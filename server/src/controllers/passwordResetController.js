import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { loadAuthenticatedUser } from '../middleware/auth.js';
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  PasswordResetTokenError,
} from '../utils/passwordReset.js';
import { env } from '../config/env.js';
import {
  renderPasswordResetEmail,
  sendEmail,
} from '../services/emailService.js';
import { sendWhatsAppText } from '../services/whatsappService.js';
import { auditLog, getRequestAuditContext } from '../utils/auditLog.js';
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  resetPasswordVerifySchema,
} from '../../../shared/validation/auth.js';

function isEmployeeEligible(user) {
  return Boolean(user && user.isActive && user.role === 'employee');
}

/**
 * Step 1 — request a reset link.
 * Always returns a generic success message to avoid account enumeration.
 * Only active employees receive an email. In non-production, the magic link is
 * also returned in the response so local/e2e testing does not need a real inbox.
 */
export async function requestPasswordReset(body, auditContext = {}) {
  const { email } = forgotPasswordSchema.parse(body);
  const user = await User.findOne({ email });

  let resetLink = null;
  if (isEmployeeEligible(user)) {
    const token = createPasswordResetToken(user);
    resetLink = `${env.clientOrigin}/reset-password?token=${encodeURIComponent(token)}`;
    const { subject, html, text } = renderPasswordResetEmail({
      name: user.firstName || user.name,
      resetLink,
    });
    await sendEmail({ to: user.email, subject, html, text, tag: 'password-reset' });
    if (user.whatsappOptIn && user.mobile) {
      const mins = Math.max(1, Math.round(env.passwordResetExpiresMs / 60000));
      await sendWhatsAppText({
        to: user.mobile,
        message: `Grubpac Attendance: password reset requested. Reset here (expires in ${mins} min, single use): ${resetLink}`,
      });
    }
    auditLog('password_reset_requested', {
      userId: user._id.toString(),
      email: user.email,
      role: user.role,
      ...auditContext,
    });
  } else {
    auditLog('password_reset_requested', {
      email,
      reason: !user ? 'no_user' : !user.isActive ? 'inactive' : 'not_employee',
      ...auditContext,
    });
  }

  const response = {
    message:
      'We have sent password reset instructions.',
    // Surfaced so the forgot-password UI can tell the user directly whether
    // the email is registered (intentional account-existence check per product
    // request — note this enables email enumeration).
    exists: Boolean(user),
  };

  if (process.env.NODE_ENV !== 'production' && resetLink) {
    response.devResetLink = resetLink;
  }

  return response;
}

/**
 * Step 2 — validate a reset token before showing the form.
 * Returns a 200 with `{ valid }` so the UI can show a friendly state without
 * leaking whether the account exists.
 */
export async function verifyPasswordReset(body) {
  const { token } = resetPasswordVerifySchema.parse(body);

  try {
    const payload = verifyPasswordResetToken(token);
    const user = await loadAuthenticatedUser(payload.sub);

    if (!isEmployeeEligible(user)) {
      return { valid: false, reason: 'unavailable' };
    }
    if (payload.tv !== (user.tokenVersion ?? 0)) {
      return { valid: false, reason: 'used' };
    }
    return { valid: true, email: user.email };
  } catch (error) {
    if (error instanceof PasswordResetTokenError) {
      return {
        valid: false,
        reason: error.code === 'expired' ? 'expired' : 'invalid',
        message: error.message,
      };
    }
    return { valid: false, reason: 'invalid', message: 'This password reset link is invalid.' };
  }
}

/**
 * Step 3 — set a new password from a valid reset token.
 * Invalidates all existing sessions (tokenVersion bump) so the link is
 * single-use and any compromised sessions are revoked.
 */
export async function resetPassword(body, auditContext = {}) {
  const { token, newPassword } = resetPasswordSchema.parse(body);
  const payload = verifyPasswordResetToken(token);

  const user = await User.findById(payload.sub);
  if (!isEmployeeEligible(user)) {
    const error = new Error(
      'This account is no longer available for password reset.',
    );
    error.statusCode = 410;
    throw error;
  }

  if (payload.tv !== (user.tokenVersion ?? 0)) {
    const error = new Error(
      'This password reset link has already been used. Please request a new one.',
    );
    error.statusCode = 410;
    throw error;
  }

  const sameAsCurrent = await bcrypt.compare(newPassword, user.passwordHash);
  if (sameAsCurrent) {
    const error = new Error(
      'New password must be different from your current password.',
    );
    error.statusCode = 400;
    throw error;
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  // A password reset revokes the alternative PIN credential too — the PIN is a
  // stand-in for the password, so it must not outlive a reset.
  user.pin4Hash = null;
  user.pin6Hash = null;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  auditLog('password_reset_completed', {
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    ...auditContext,
  });

  return {
    message: 'Your password has been reset. Please sign in with your new password.',
  };
}
