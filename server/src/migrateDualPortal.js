/**
 * One-shot migration: sync system role permissions for dual-portal login
 * and fix legacy user.role vs roleId.slug mismatches.
 *
 * Usage: node src/migrateDualPortal.js
 * Does NOT reset passwords or wipe data.
 */
import { connectDatabase, disconnectDatabase } from './config/db.js';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_SLUGS,
  legacyRoleFromSlug,
  hasAdminPortalAccess,
  hasPermission,
} from '../../shared/permissions.js';
import { User } from './models/User.js';
import { Role } from './models/Role.js';

const KEY_EMAILS = ['admin@grubpac.com', 'salunke.himanshu@grubpac.com'];

async function upsertSystemRoles() {
  const roleMap = new Map();
  const changes = [];

  for (const seedRole of SYSTEM_ROLES) {
    let role = await Role.findOne({ slug: seedRole.slug });
    if (!role) {
      role = await Role.create(seedRole);
      changes.push(`Created role: ${seedRole.slug}`);
    } else {
      const before = [...(role.permissions ?? [])].sort().join(',');
      role.name = seedRole.name;
      role.description = seedRole.description;
      role.isSystem = true;
      role.permissions = seedRole.permissions;
      await role.save();
      const after = [...(role.permissions ?? [])].sort().join(',');
      if (before !== after) {
        changes.push(`Updated permissions for role: ${seedRole.slug}`);
      }
    }
    roleMap.set(seedRole.slug, role);
  }

  return { roleMap, changes };
}

async function syncUserLegacyRoles(roleMap) {
  const users = await User.find({});
  const fixes = [];

  for (const user of users) {
    let changed = false;

    if (!user.roleId) {
      const adminRole = roleMap.get(SYSTEM_ROLE_SLUGS.ADMIN);
      const employeeRole = roleMap.get(SYSTEM_ROLE_SLUGS.EMPLOYEE);
      user.roleId = user.role === 'admin' ? adminRole._id : employeeRole._id;
      changed = true;
      fixes.push(`${user.email}: assigned missing roleId`);
    }

    const roleDoc = await Role.findById(user.roleId);
    const expectedLegacyRole = legacyRoleFromSlug(roleDoc?.slug ?? SYSTEM_ROLE_SLUGS.EMPLOYEE);
    if (user.role !== expectedLegacyRole) {
      fixes.push(`${user.email}: role ${user.role} -> ${expectedLegacyRole} (slug=${roleDoc?.slug})`);
      user.role = expectedLegacyRole;
      changed = true;
    }

    if (changed) {
      await user.save();
    }
  }

  return fixes;
}

async function auditKeyUsers() {
  const users = await User.find({ email: { $in: KEY_EMAILS } }).populate('roleId', 'name slug permissions');
  return users.map((user) => {
    const permissions = user.roleId?.permissions ?? [];
    return {
      email: user.email,
      legacyRole: user.role,
      roleSlug: user.roleId?.slug ?? null,
      roleName: user.roleId?.name ?? null,
      canAdminPortal: hasAdminPortalAccess(permissions),
      canEmployeePortal: hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_OWN),
      canDualPortal:
        hasAdminPortalAccess(permissions) &&
        hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_OWN),
    };
  });
}

async function migrateDualPortal() {
  await connectDatabase();

  const { roleMap, changes: roleChanges } = await upsertSystemRoles();
  const userFixes = await syncUserLegacyRoles(roleMap);
  const keyUsers = await auditKeyUsers();

  console.log('=== Role updates ===');
  if (roleChanges.length === 0) {
    console.log('No role permission changes needed.');
  } else {
    roleChanges.forEach((line) => console.log(line));
  }

  console.log('\n=== User legacy role sync ===');
  if (userFixes.length === 0) {
    console.log('All users already in sync.');
  } else {
    userFixes.forEach((line) => console.log(line));
  }

  console.log('\n=== Key user audit ===');
  keyUsers.forEach((row) => console.log(JSON.stringify(row)));

  const roles = await Role.find({ isSystem: true }).select('slug permissions').lean();
  console.log('\n=== System role employee-portal readiness ===');
  for (const role of roles) {
    console.log(
      JSON.stringify({
        slug: role.slug,
        attendanceReadOwn: role.permissions.includes(PERMISSIONS.ATTENDANCE_READ_OWN),
      }),
    );
  }

  await disconnectDatabase();
  process.exit(0);
}

migrateDualPortal().catch((error) => {
  console.error(error);
  process.exit(1);
});
