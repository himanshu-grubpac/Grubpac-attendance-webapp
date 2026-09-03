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
  setPinSchema,
  updateProfileSchema,
} from '../../../shared/validation/auth.js';
import { normalizeMobile } from '../../../shared/validation/common.js';
import { auditLog } from '../utils/auditLog.js';

const COOKIE_NAME = 'attendance_token';

export function getAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
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
    sameSite: 'lax',
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
  const loginAuditContext = {
    ...auditContext,
    ...(parsed.deviceId ? { deviceId: parsed.deviceId } : {}),
  };
  const found = await User.findOne(buildIdentifierQuery(parsed.identifier));
  if (!found) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'invalid_or_inactive',
      ...loginAuditContext,
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
      ...loginAuditContext,
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
      ...loginAuditContext,
    });
    const error = new Error('You do not have access to this portal.');
    error.statusCode = 403;
    throw error;
  }

  if (portal === 'employee' && !hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_OWN)) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'wrong_portal',
      role: user.role,
      portal,
      ...loginAuditContext,
    });
    const error = new Error('You do not have access to this portal.');
    error.statusCode = 403;
    throw error;
  }

  // A login secret is either the account password OR a 4/6-digit PIN. We detect
  // the format so a 4-digit PIN is tried against the PIN hash (when set) and
  // anything else falls through to a normal password comparison. This avoids
  // comparing against a null hash, which would throw.
  const secret = parsed.password;
  let valid = false;
  const isFourDigit = /^\d{4}$/.test(secret);
  const isSixDigit = /^\d{6}$/.test(secret);

  if (isFourDigit && user.pin4Hash) {
    valid = await bcrypt.compare(secret, user.pin4Hash);
  }
  if (!valid && isSixDigit && user.pin6Hash) {
    valid = await bcrypt.compare(secret, user.pin6Hash);
  }
  if (!valid) {
    valid = await bcrypt.compare(secret, user.passwordHash);
  }

  if (!valid) {
    auditLog('login_failed', {
      identifier: parsed.identifier,
      reason: 'bad_password',
      ...loginAuditContext,
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
    ...loginAuditContext,
  });

  const csrfToken = generateCsrfToken();

  return {
    token: signToken(user),
    csrfToken,
    user: {
      ...user.toSafeJSON(),
      loginPortal: portal,
    },
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

/**
 * Employee self-service PIN setup and change.
 * - Only employees may set a PIN (admins use the admin reset endpoint).
 * - Setting a PIN for the first time requires no current PIN.
 * - Changing an existing PIN requires the current PIN to be supplied and correct.
 * - Self-service PINs are stored strictly as 4-digit (pin4Hash); any legacy
 *   6-digit hash is cleared so the account has a single, predictable credential.
 */
export async function setPin(userId, body, auditContext = {}) {
  const parsed = setPinSchema.parse(body);
  const user = await User.findById(userId);

  if (!user || !user.isActive) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  if (user.role !== 'employee') {
    const error = new Error('PIN setup is available for employees only.');
    error.statusCode = 403;
    throw error;
  }

  const hasPin = Boolean(user.pin4Hash || user.pin6Hash);
  if (hasPin) {
    // Changing an existing PIN requires the current PIN.
    if (!parsed.currentPin) {
      const error = new Error('Current PIN is required to change your PIN.');
      error.statusCode = 400;
      throw error;
    }
    const currentHash = user.pin4Hash || user.pin6Hash;
    const currentValid = await bcrypt.compare(parsed.currentPin, currentHash);
    if (!currentValid) {
      const error = new Error('Current PIN is incorrect.');
      error.statusCode = 401;
      throw error;
    }
  } else {
    // Setting a PIN for the first time requires the current account password.
    if (!parsed.currentPassword) {
      const error = new Error('Current password is required to set a PIN.');
      error.statusCode = 400;
      throw error;
    }
    const passwordValid = await bcrypt.compare(parsed.currentPassword, user.passwordHash);
    if (!passwordValid) {
      const error = new Error('Current password is incorrect.');
      error.statusCode = 401;
      throw error;
    }
  }

  user.pin4Hash = await bcrypt.hash(parsed.pin, 12);
  user.pin6Hash = null;
  await user.save();

  auditLog(hasPin ? 'pin_changed' : 'pin_set', {
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    ...auditContext,
  });

  return {
    message: hasPin ? 'PIN changed successfully.' : 'PIN set successfully.',
  };
}

/**
 * Employee self-service PIN removal.
 * - Only employees may remove their own PIN.
 * - Requires the current account password (when no PIN is set this is moot) or
 *   the current PIN to re-verify identity before clearing the credential.
 */
export async function deletePin(userId, body = {}, auditContext = {}) {
  const user = await User.findById(userId);

  if (!user || !user.isActive) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  if (user.role !== 'employee') {
    const error = new Error('PIN removal is available for employees only.');
    error.statusCode = 403;
    throw error;
  }

  const hasPin = Boolean(user.pin4Hash || user.pin6Hash);
  if (!hasPin) {
    return { message: 'No PIN is currently set.' };
  }

  const currentPin = body.currentPin?.trim();
  const currentPassword = body.currentPassword?.trim();

  if (!currentPin && !currentPassword) {
    const error = new Error('Your current PIN or password is required to remove the PIN.');
    error.statusCode = 400;
    throw error;
  }

  if (currentPin) {
    const currentHash = user.pin4Hash || user.pin6Hash;
    const currentValid = await bcrypt.compare(currentPin, currentHash);
    if (!currentValid) {
      const error = new Error('Current PIN is incorrect.');
      error.statusCode = 401;
      throw error;
    }
  } else if (currentPassword) {
    const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!passwordValid) {
      const error = new Error('Current password is incorrect.');
      error.statusCode = 401;
      throw error;
    }
  }

  user.pin4Hash = null;
  user.pin6Hash = null;
  await user.save();

  auditLog('pin_removed', {
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    ...auditContext,
  });

  return { message: 'PIN removed successfully.' };
}
