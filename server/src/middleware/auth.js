import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import {
  PERMISSIONS,
  hasAdminPortalAccess,
  hasAnyPermission,
  hasEmployeePortalAccess,
  hasPermission,
  legacyRoleFromSlug,
  migrateLegacyPermissions,
} from '../../../shared/permissions.js';
import { Role } from '../models/Role.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';

const COOKIE_NAME = 'attendance_token';

const ROLE_AUTH_FIELDS = 'name slug permissions isSystem permissionsVersion';

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

/**
 * Resolve permissions strictly from the user's Role document.
 * No hardcoded slug fallbacks — missing or unpopulated role → deny all.
 */
export function resolveUserPermissions(user) {
  const roleDoc = user?.roleId && typeof user.roleId === 'object' ? user.roleId : null;
  if (roleDoc && Array.isArray(roleDoc.permissions)) {
    return migrateLegacyPermissions(roleDoc.permissions);
  }
  return [];
}

async function hydrateRoleDocument(user) {
  if (!user?.roleId) {
    return user;
  }
  const roleDoc = user.roleId;
  if (typeof roleDoc === 'object' && Array.isArray(roleDoc.permissions)) {
    return user;
  }
  const roleId = roleDoc._id?.toString?.() ?? roleDoc.toString?.();
  if (!roleId) {
    return user;
  }
  const role = await Role.findById(roleId).select(ROLE_AUTH_FIELDS);
  if (role) {
    user.roleId = role;
  }
  return user;
}

export async function loadAuthenticatedUser(userId) {
  const user = await User.findById(userId).populate(USER_POPULATE_FIELDS);
  if (!user) {
    return null;
  }
  return hydrateRoleDocument(user);
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

    if (user.endingDate && new Date(user.endingDate) < new Date()) {
      if (user.isActive) {
        user.isActive = false;
        await user.save();
      }
      return res.status(401).json({ message: 'Your employment has ended. Contact your administrator.' });
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
  if (!hasAdminPortalAccess(req.userPermissions)) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  return next();
}

/** @deprecated Use requirePermission — kept for gradual migration. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && !hasAnyPermission(req.userPermissions, [
    PERMISSIONS.EMPLOYEES_RECORD_U,
    PERMISSIONS.RBAC_ROLE_R,
  ])) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  return next();
}

export function requireEmployeePortalAccess(req, res, next) {
  if (!hasEmployeePortalAccess(req.userPermissions)) {
    return res.status(403).json({ message: 'Employee access required.' });
  }
  return next();
}

/** @deprecated Use requireEmployeePortalAccess. */
export function requireEmployee(req, res, next) {
  return requireEmployeePortalAccess(req, res, next);
}

export { legacyRoleFromSlug };
