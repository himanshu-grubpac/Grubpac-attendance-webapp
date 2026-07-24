import bcrypt from 'bcryptjs';
import {
  PERMISSIONS,
  hasAdminPortalAccess,
  hasPermission,
} from '../../../shared/permissions.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import {
  signToken,
  loadAuthenticatedUser,
  resolveUserPermissions,
  invalidateUserSessions,
} from '../middleware/auth.js';
import { env } from '../config/env.js';
import {
  generateCsrfToken,
  setCsrfCookie,
  clearCsrfCookie,
} from '../middleware/csrf.js';
import {
  changePasswordSchema,
  detectIdentifierType,
  loginSchema,
  updateProfileSchema,
} from '../../../shared/validation/auth.js';
import { normalizeMobile } from '../../../shared/validation/common.js';
import { auditLog } from '../utils/auditLog.js';

const COOKIE_NAME = 'attendance_token';

export function getAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: env.jwtCookieMaxAgeMs,
    path: '/',
  };
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, getAuthCookieOptions());
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

/** Builds the User lookup query for a login identifier (email, mobile, or employee code). */
function buildIdentifierQuery(identifier) {
  const type = detectIdentifierType(identifier);
  if (type === 'email') {
    return { email: identifier.toLowerCase() };
  }
  if (type === 'mobile') {
    return { mobile: normalizeMobile(identifier) };
  }
  return { employeeCode: identifier };
}

export async function loginUser(body, portal, auditContext = {}) {
  const parsed = loginSchema.parse(body);
  const found = await User.findOne(buildIdentifierQuery(parsed.identifier));
  if (!found) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'invalid_or_inactive',
      ...auditContext,
    });
    const error = new Error('Invalid credentials.');
    error.statusCode = 401;
    throw error;
  }

  const user = await loadAuthenticatedUser(found._id);

  if (!user || !user.isActive) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'invalid_or_inactive',
      ...auditContext,
    });
    const error = new Error('Invalid credentials.');
    error.statusCode = 401;
    throw error;
  }

  const permissions = resolveUserPermissions(user);

  if (portal === 'admin' && !hasAdminPortalAccess(permissions)) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'wrong_portal',
      role: user.role,
      portal,
      ...auditContext,
    });
    const error = new Error('You do not have access to this portal.');
    error.statusCode = 403;
    throw error;
  }

  if (portal === 'employee' && hasAdminPortalAccess(permissions)) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'wrong_portal',
      role: user.role,
      portal,
      ...auditContext,
    });
    const error = new Error('This account uses the Admin portal. Switch to the Admin tab to sign in.');
    error.statusCode = 403;
    throw error;
  }

  if (portal === 'employee' && !hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_OWN)) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'wrong_portal',
      role: user.role,
      portal,
      ...auditContext,
    });
    const error = new Error('You do not have access to this portal.');
    error.statusCode = 403;
    throw error;
  }

  const valid = await bcrypt.compare(parsed.password, user.passwordHash);
  if (!valid) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'bad_password',
      ...auditContext,
    });
    const error = new Error('Invalid credentials.');
    error.statusCode = 401;
    throw error;
  }

  user.lastLoginAt = new Date();
  await user.save();

  auditLog('login_success', {
    userId: user._id.toString(),
    role: user.role,
    email: user.email,
    portal,
    ...auditContext,
  });

  const csrfToken = generateCsrfToken();

  return {
    token: signToken(user),
    csrfToken,
    user: user.toSafeJSON(),
  };
}

export function applyAuthSession(res, { token, csrfToken }) {
  setAuthCookie(res, token);
  setCsrfCookie(res, csrfToken);
}

export async function getCurrentUser(userId) {
  const user = await loadAuthenticatedUser(userId);
  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }
  return user.toSafeJSON();
}

export async function updateProfile(userId, body) {
  const parsed = updateProfileSchema.parse(body);
  const user = await User.findById(userId);

  if (!user || !user.isActive) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  const previous = {
    firstName: user.firstName,
    lastName: user.lastName,
    mobile: user.mobile,
  };

  if (parsed.mobile !== undefined && parsed.mobile !== user.mobile) {
    const taken = await User.exists({ mobile: parsed.mobile, _id: { $ne: user._id } });
    if (taken) {
      const error = new Error('Mobile number is already in use.');
      error.statusCode = 409;
      throw error;
    }
    user.mobile = parsed.mobile;
  }

  if (parsed.firstName !== undefined) {
    user.firstName = parsed.firstName;
  }
  if (parsed.lastName !== undefined) {
    user.lastName = parsed.lastName;
  }

  await user.save();
  const refreshed = await loadAuthenticatedUser(user._id);

  auditLog('profile_updated', {
    userId: user._id.toString(),
    role: user.role,
    email: user.email,
    previous,
    next: {
      firstName: refreshed.firstName,
      lastName: refreshed.lastName,
      mobile: refreshed.mobile,
    },
  });

  return refreshed.toSafeJSON();
}

export async function changePassword(userId, body) {
  const parsed = changePasswordSchema.parse(body);
  const user = await User.findById(userId);

  if (!user || !user.isActive) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  const currentValid = await bcrypt.compare(parsed.currentPassword, user.passwordHash);
  if (!currentValid) {
    const error = new Error('Current password is incorrect.');
    error.statusCode = 401;
    throw error;
  }

  user.passwordHash = await bcrypt.hash(parsed.newPassword, 12);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  auditLog('password_changed', {
    userId: user._id.toString(),
    role: user.role,
    email: user.email,
  });

  return { message: 'Password changed successfully.' };
}
