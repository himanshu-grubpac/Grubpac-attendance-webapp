import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  hasAnyPermission,
  hasPermission,
  legacyRoleFromSlug,
} from '../../../shared/permissions.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';

const COOKIE_NAME = 'attendance_token';

export function signToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      tv: user.tokenVersion ?? 0,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

export async function invalidateUserSessions(userId) {
  await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
}

function extractToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7);
  }
  if (req.cookies?.[COOKIE_NAME]) {
    return req.cookies[COOKIE_NAME];
  }
  return null;
}

export function resolveUserPermissions(user) {
  const roleDoc = user.roleId && typeof user.roleId === 'object' ? user.roleId : null;
  if (roleDoc?.permissions?.length) {
    return roleDoc.permissions;
  }
  if (user.role === 'admin') {
    return ALL_PERMISSIONS;
  }
  return [PERMISSIONS.ATTENDANCE_READ_OWN, PERMISSIONS.NOTIFICATIONS_READ];
}

export async function loadAuthenticatedUser(userId) {
  return User.findById(userId).populate(USER_POPULATE_FIELDS);
}

export async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    const payload = jwt.verify(token, env.jwtSecret);
    const user = await loadAuthenticatedUser(payload.sub);

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid or inactive account.' });
    }

    const tokenVersion = payload.tv ?? 0;
    if (tokenVersion !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ message: 'Session has been revoked.' });
    }

    req.user = user;
    req.userPermissions = resolveUserPermissions(user);
    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

export function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    const allowed = requiredPermissions.some((permission) =>
      hasPermission(req.userPermissions, permission),
    );
    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission for this action.' });
    }
    return next();
  };
}

export function requireAllPermissions(...requiredPermissions) {
  return (req, res, next) => {
    const allowed = requiredPermissions.every((permission) =>
      hasPermission(req.userPermissions, permission),
    );
    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission for this action.' });
    }
    return next();
  };
}

export function requireAdminPortalAccess(req, res, next) {
  if (!hasAnyPermission(req.userPermissions, [
    PERMISSIONS.USERS_READ,
    PERMISSIONS.USERS_WRITE,
    PERMISSIONS.ROLES_MANAGE,
    PERMISSIONS.DEPARTMENTS_MANAGE,
    PERMISSIONS.OFFICE_MANAGE,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
    PERMISSIONS.AUDIT_READ,
  ])) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  return next();
}

/** @deprecated Use requirePermission — kept for gradual migration. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && !hasAnyPermission(req.userPermissions, [
    PERMISSIONS.USERS_WRITE,
    PERMISSIONS.ROLES_MANAGE,
  ])) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  return next();
}

export function requireEmployeePortalAccess(req, res, next) {
  if (!hasPermission(req.userPermissions, PERMISSIONS.ATTENDANCE_READ_OWN)) {
    return res.status(403).json({ message: 'Employee access required.' });
  }
  return next();
}

/** @deprecated Use requireEmployeePortalAccess. */
export function requireEmployee(req, res, next) {
  return requireEmployeePortalAccess(req, res, next);
}

export { legacyRoleFromSlug };
