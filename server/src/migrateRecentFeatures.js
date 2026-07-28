/**
 * Idempotent schema/index migration for recent attendance-web features.
 * Does NOT wipe data or reset passwords.
 *
 * Covers:
 * - AuditLog deviceId/ip/userAgent indexes (login device conflict)
 * - AttendanceRecord lateNote + edit history fields (schemaless — index sync only)
 * - LeaveCarryForwardEntry, WeekAttendanceConfirmation, SalaryTransfer collections
 * - LeavePolicy.year backfill + compound index (leaveTypeId + year)
 * - User.managedDepartmentIds backfill
 * - Dual-portal system role permissions (HR attendance.read_own)
 *
 * Usage: node src/migrateRecentFeatures.js
 */
import { connectDatabase, disconnectDatabase } from './config/db.js';
import mongoose from 'mongoose';
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
import { AuditLog } from './models/AuditLog.js';
import { AttendanceRecord } from './models/AttendanceRecord.js';
import { LeaveCarryForwardEntry } from './models/LeaveCarryForwardEntry.js';
import { WeekAttendanceConfirmation } from './models/WeekAttendanceConfirmation.js';
import { SalaryTransfer } from './models/SalaryTransfer.js';
import { SalarySettings } from './models/SalarySettings.js';
import { HolidayCategory } from './models/HolidayCategory.js';
import { Holiday } from './models/Holiday.js';
import { Department } from './models/Department.js';
import { LeaveType } from './models/LeaveType.js';
import { LeavePolicy } from './models/LeavePolicy.js';
import { LeaveBalance } from './models/LeaveBalance.js';
import { OfficeSettings } from './models/OfficeSettings.js';
import { seedLeaveTypesAndPolicies, migrateLeavePolicyYears } from './services/leaveBalanceService.js';

const KEY_EMAILS = ['admin@grubpac.com', 'salunke.himanshu@grubpac.com'];

const INDEX_MODELS = [
  AuditLog,
  AttendanceRecord,
  LeaveCarryForwardEntry,
  WeekAttendanceConfirmation,
  SalaryTransfer,
  SalarySettings,
  HolidayCategory,
  Holiday,
  User,
  Role,
  Department,
  LeaveType,
  LeavePolicy,
  LeaveBalance,
  OfficeSettings,
];

async function syncAllIndexes() {
  const results = [];
  for (const Model of INDEX_MODELS) {
    const name = Model.modelName;
    try {
      const diff = await Model.syncIndexes();
      results.push({ model: name, diff: diff ?? {} });
      console.log(`Synced indexes: ${name}`);
    } catch (error) {
      console.error(`Index sync failed for ${name}:`, error.message);
      throw error;
    }
  }
  return results;
}

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

    if (!Array.isArray(user.managedDepartmentIds)) {
      user.managedDepartmentIds = [];
      changed = true;
      fixes.push(`${user.email}: initialized managedDepartmentIds`);
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
      canAdminPortal: hasAdminPortalAccess(permissions),
      canEmployeePortal: hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_OWN),
    };
  });
}

async function migrateRecentFeatures() {
  await connectDatabase();

  console.log('\n=== Leave policy year backfill ===');
  const backfilled = await migrateLeavePolicyYears();
  if (backfilled === 0) {
    console.log('All leave policies already have a year.');
  }

  console.log('=== Syncing indexes ===');
  await syncAllIndexes();

  console.log('\n=== Leave types & policies (WFH/RH etc.) ===');
  await seedLeaveTypesAndPolicies();

  console.log('\n=== Dual-portal role sync ===');
  const { roleMap, changes: roleChanges } = await upsertSystemRoles();
  if (roleChanges.length === 0) {
    console.log('No role permission changes needed.');
  } else {
    roleChanges.forEach((line) => console.log(line));
  }

  const userFixes = await syncUserLegacyRoles(roleMap);
  console.log('\n=== User legacy role / managedDepartmentIds sync ===');
  if (userFixes.length === 0) {
    console.log('All users already in sync.');
  } else {
    userFixes.forEach((line) => console.log(line));
  }

  console.log('\n=== Key user audit ===');
  const keyUsers = await auditKeyUsers();
  keyUsers.forEach((row) => console.log(JSON.stringify(row)));

  const collections = [
    'auditlogs',
    'attendancerecords',
    'leavecarryforwardentries',
    'weekattendanceconfirmations',
    'salarytransfers',
  ];
  const db = mongoose.connection.db;
  const existing = await db.listCollections().toArray();
  const names = new Set(existing.map((c) => c.name));
  console.log('\n=== Collection readiness ===');
  for (const name of collections) {
    console.log(`${name}: ${names.has(name) ? 'present' : 'will be created on first write'}`);
  }

  await disconnectDatabase();
  console.log('\nMigration complete.');
  process.exit(0);
}

migrateRecentFeatures().catch((error) => {
  console.error(error);
  process.exit(1);
});
