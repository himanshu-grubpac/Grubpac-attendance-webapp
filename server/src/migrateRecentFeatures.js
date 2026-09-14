/**
 * Idempotent schema/index migration for recent attendance-web features.
 * Does NOT wipe data or reset passwords.
 *
 * Covers:
 * - AuditLog deviceId/ip/userAgent indexes (login device conflict)
 * - AttendanceRecord lateNote + edit history fields (schemaless — index sync only)
 * - LeaveCarryForwardEntry, WeekAttendanceConfirmation, SalaryTransfer collections
 * - LeavePolicy.year backfill + compound index (leaveTypeId + year)
 * - LeaveRequest provisional→final lifecycle fields (revision, pendingRevision,
 *   undoExpiresAt, finalizedAt) + finalizer sweep indexes
 * - LeaveBalance.compOffEarned backfill + CompOffRequest collection (comp-off module)
 * - User.managedDepartmentIds backfill
 * - Dual-portal system role permissions (HR attendance.read_own)
 * - DemoFaqItem collection indexes + demo_faq.* role permissions
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
import { LeaveRequest } from './models/LeaveRequest.js';
import { CompOffRequest } from './models/CompOffRequest.js';
import { OfficeSettings } from './models/OfficeSettings.js';
import { DemoFaqItem } from './models/DemoFaqItem.js';
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
  LeaveRequest,
  CompOffRequest,
  OfficeSettings,
  DemoFaqItem,
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
      // Roles are dynamically editable via Roles & Permissions: never
      // overwrite an existing role's permissions here — seed defaults apply
      // to freshly created roles only.
      role.name = seedRole.name;
      role.description = seedRole.description;
      role.isSystem = true;
      await role.save();
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

/**
 * Backfills the provisional→final lifecycle fields on existing leave requests.
 * Idempotent — only touches documents missing the new fields.
 * - revision defaults to 0 for pre-lifecycle requests.
 * - In-flight staged decisions (pendingDecision set, old notifyAfter semantics
 *   where notifyAfter == undo expiry): split into undoExpiresAt (= old
 *   notifyAfter) and notifyAfter (= old notifyAfter + notification delay).
 * - Legacy plain-pending submissions (never notified, no undoExpiresAt): grant
 *   a fresh finite undo window measured from migration time. Without this,
 *   the withdraw claim (which requires undoExpiresAt in the future) would
 *   reject them with a misleading "already sent" error even though no
 *   notification was ever delivered.
 */
async function migrateLeaveRequestUndoLifecycle() {
  const delayMs = Number(process.env.LEAVE_NOTIFICATION_DELAY_MS ?? 2500);
  const submitWindowMs = Number(process.env.LEAVE_SUBMIT_UNDO_WINDOW_MS ?? 10000);

  const missingRevision = await LeaveRequest.updateMany(
    { revision: { $exists: false } },
    { $set: { revision: 0 } },
  );

  const inFlight = await LeaveRequest.find({
    pendingDecision: { $ne: null },
    undoExpiresAt: { $exists: false },
    notifyAfter: { $ne: null },
  }).select('_id notifyAfter');

  let split = 0;
  for (const doc of inFlight) {
    const expiry = doc.notifyAfter;
    await LeaveRequest.updateOne(
      { _id: doc._id, undoExpiresAt: { $exists: false } },
      {
        $set: {
          undoExpiresAt: expiry,
          pendingRevision: 0,
          notifyAfter: new Date(new Date(expiry).getTime() + delayMs),
        },
      },
    );
    split += 1;
  }

  const migrationNow = Date.now();
  const legacyPending = await LeaveRequest.updateMany(
    {
      status: 'pending',
      pendingDecision: null,
      undoExpiresAt: { $exists: false },
      submitNotificationsSent: { $ne: true },
      notificationsSent: false,
    },
    {
      $set: {
        undoExpiresAt: new Date(migrationNow + submitWindowMs),
        notifyAfter: new Date(migrationNow + submitWindowMs + delayMs),
      },
    },
  );

  return {
    missingRevision: missingRevision.modifiedCount ?? 0,
    inFlightSplit: split,
    legacyPendingWindowed: legacyPending.modifiedCount ?? 0,
  };
}

/**
 * Backfills the comp-off earned-credit field on leave balances.
 * Idempotent — only touches documents missing the new field.
 */
async function migrateCompOffEarnedField() {
  const result = await LeaveBalance.updateMany(
    { compOffEarned: { $exists: false } },
    { $set: { compOffEarned: 0 } },
  );
  return result.modifiedCount ?? 0;
}

async function migrateRecentFeatures() {
  await connectDatabase();

  console.log('\n=== Leave request undo-lifecycle backfill ===');
  const undoBackfill = await migrateLeaveRequestUndoLifecycle();
  console.log(
    `revision defaulted on ${undoBackfill.missingRevision} request(s); split notifyAfter on ${undoBackfill.inFlightSplit} in-flight staged decision(s); granted fresh undo windows to ${undoBackfill.legacyPendingWindowed} legacy pending submission(s).`,
  );

  console.log('\n=== Comp-off earned credit backfill ===');
  const compOffBackfill = await migrateCompOffEarnedField();
  console.log(
    `compOffEarned defaulted on ${compOffBackfill} leave balance(s).`,
  );

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
