import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const PASSWORD_RESET_PURPOSE = 'password-reset';

/**
 * Typed error for password-reset token problems so controllers can map to the
 * right HTTP status (410 expired/used vs 400 invalid/malformed).
 */
export class PasswordResetTokenError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PasswordResetTokenError';
    this.code = code;
    this.statusCode = code === 'expired' ? 410 : 400;
  }
}

/** Create a short-lived, single-purpose JWT for an employee password reset. */
export function createPasswordResetToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      tv: user.tokenVersion ?? 0,
      purpose: PASSWORD_RESET_PURPOSE,
    },
    env.jwtSecret,
    { expiresIn: Math.floor(env.passwordResetExpiresMs / 1000) },
  );
}

/**
 * Verify a password-reset token. Throws PasswordResetTokenError on any problem
 * (malformed, wrong purpose, expired, or otherwise invalid). Callers must still
 * confirm the user exists, is active, is an employee, and that `tv` matches.
 */
export function verifyPasswordResetToken(token) {
  if (!token || typeof token !== 'string') {
    throw new PasswordResetTokenError('This password reset link is invalid.', 'invalid');
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new PasswordResetTokenError(
        'This password reset link has expired. Please request a new one.',
        'expired',
      );
    }
    throw new PasswordResetTokenError(
      'This password reset link is invalid or has already been used.',
      'invalid',
    );
  }

  if (payload.purpose !== PASSWORD_RESET_PURPOSE) {
    throw new PasswordResetTokenError(
      'This password reset link is invalid or has already been used.',
      'invalid',
    );
  }

  return payload;
}
