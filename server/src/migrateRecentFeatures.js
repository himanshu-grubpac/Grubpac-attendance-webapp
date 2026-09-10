/**
 * Idempotent schema/index migration for recent attendance-web features.
 * Does NOT wipe data or reset passwords.
 *
 * Covers:
 * - AuditLog deviceId/ip/userAgent indexes (login device conflict)
 * - AttendanceRecord lateNote + edit history fields (schemaless — index sync only)
 * - LeaveCarryForwardEntry, WeekAttendanceConfirmation, SalaryTransfer collections
 * - LeavePolicy.year backfill + compound index (leaveTypeId + year) — missing year only
 * - LeaveRequest provisional→final lifecycle fields (revision, pendingRevision,
 *   undoExpiresAt, finalizedAt) + finalizer sweep indexes — additive $set only
 * - User.managedDepartmentIds / roleId backfill (missing fields only)
 * - HelpAttachment status + createdAt compound index (stale pending cleanup sweep)
 *
 * Usage (always from server/):
 *   node --env-file=.env.staging src/migrateRecentFeatures.js
 *   node --env-file=.env.production src/migrateRecentFeatures.js
 *
 * Prod-safe mode (automatic when MONGODB_URI host is grubpac-attendance.uvcyogy.mongodb.net
 * or MIGRATE_PROD_SAFE=1):
 *   - Skips seedLeaveTypesAndPolicies (would overwrite prod-tuned WFH/RH 2026 policies)
 *   - Skips upsertSystemRoles permission overwrite (reporting-manager etc. stay as-is)
 *   - Skips legacy-pending undo window grant (avoids surprise manager emails on old pending rows)
 *   Override any skip: MIGRATE_SKIP_LEAVE_SEED=0 | MIGRATE_SKIP_ROLE_SYNC=0 |
 *   MIGRATE_SKIP_LEGACY_PENDING_UNDO=0
 *
 * Staging / dev (non-prod URI): runs leave seed + role sync unless MIGRATE_SKIP_*=1.
 *
 * Never run on prod: seed.js, wipeKeepHolidaysGeo.js, migrateDualPortal.js (redundant),
 * migrateUnsetPin6.js (PIN cutover — separate decision).
 *
 * syncIndexes: adds schema-defined indexes; drops DB indexes not declared on the model
 * (prod audit 2026-09: existing indexes already match schemas — no data change).
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
import { OfficeSettings } from './models/OfficeSettings.js';
import { DemoFaqItem } from './models/DemoFaqItem.js';
import { HelpAttachment } from './models/HelpAttachment.js';
import { seedLeaveTypesAndPolicies, migrateLeavePolicyYears } from './services/leaveBalanceService.js';

const KEY_EMAILS = ['admin@grubpac.com', 'salunke.himanshu@grubpac.com'];
const PROD_CLUSTER_HOST = 'grubpac-attendance.uvcyogy.mongodb.net';

function envFlag(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function envFlagOff(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no';
}

function isProdClusterUri(uri = process.env.MONGODB_URI ?? '') {
  return String(uri).includes(PROD_CLUSTER_HOST);
}

function resolveProdSafeMode() {
  if (envFlag('MIGRATE_PROD_SAFE')) return true;
  return isProdClusterUri();
}

/** Env explicit 1/true → skip; explicit 0/false → run; unset → defaultSkipOnProd when prod-safe. */
function resolveSkipFlag(name, prodSafe, defaultSkipOnProd) {
  if (envFlag(name)) return true;
  if (envFlagOff(name)) return false;
  return prodSafe && defaultSkipOnProd;
}

function logMigrationMode(prodSafe) {
  console.log('\n=== Migration mode ===');
  if (prodSafe) {
    console.log(
      `Prod-safe mode ON (host ${PROD_CLUSTER_HOST} or MIGRATE_PROD_SAFE=1). Destructive seed/role steps skipped unless overridden with =0.`,
    );
  } else {
    console.log('Prod-safe mode OFF — staging/dev defaults (leave seed + role sync run unless MIGRATE_SKIP_*=1).');
  }
  const uri = process.env.MONGODB_URI ?? '';
  const hostMatch = uri.match(/@([^/?]+)/);
  console.log(`MONGODB_URI host: ${hostMatch?.[1] ?? '(not set — verify before running)'}`);
}

async function loadExistingRoleMap() {
  const slugs = SYSTEM_ROLES.map((r) => r.slug);
  const roles = await Role.find({ slug: { $in: slugs } });
  const roleMap = new Map();
  for (const role of roles) {
    roleMap.set(role.slug, role);
  }
  return roleMap;
}

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
  OfficeSettings,
  DemoFaqItem,
  HelpAttachment,
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

/**
 * Backfills the provisional→final lifecycle fields on existing leave requests.
 * Idempotent — only touches documents missing the new fields.
 * - revision defaults to 0 for pre-lifecycle requests.
 * - In-flight staged decisions (pendingDecision set, old notifyAfter semantics
 *   where notifyAfter == undo expiry): split into undoExpiresAt (= old
 *   notifyAfter) and notifyAfter (= old notifyAfter + notification delay).
 * - Legacy plain-pending submissions (never notified, no undoExpiresAt): optionally
 *   grant a fresh finite undo window measured from migration time. Without this,
 *   the withdraw claim (which requires undoExpiresAt in the future) would
 *   reject them with a misleading "already sent" error even though no
 *   notification was ever delivered. When granted, notifyAfter is also set so
 *   the submit finalizer will email managers shortly after the window expires.
 *   Skipped in prod-safe mode (MIGRATE_SKIP_LEGACY_PENDING_UNDO or auto prod)
 *   to avoid surprise notifications on long-standing pending rows.
 *
 * Never overwrites existing revision, undoExpiresAt, or notifyAfter on matched docs.
 */
async function migrateLeaveRequestUndoLifecycle(options = {}) {
  const { skipLegacyPendingUndo = false } = options;
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

  let legacyPendingWindowed = 0;
  if (skipLegacyPendingUndo) {
    console.log(
      'Legacy pending undo window grant skipped — existing pending rows keep prior behavior (no new notifyAfter).',
    );
  } else {
    const migrationNow = Date.now();
    const legacyPending = await LeaveRequest.updateMany(
      {
        status: 'pending',
        pendingDecision: null,
        undoExpiresAt: { $exists: false },
        submitNotificationsSent: { $ne: true },
        notificationsSent: { $ne: true },
      },
      {
        $set: {
          undoExpiresAt: new Date(migrationNow + submitWindowMs),
          notifyAfter: new Date(migrationNow + submitWindowMs + delayMs),
        },
      },
    );
    legacyPendingWindowed = legacyPending.modifiedCount ?? 0;
  }

  return {
    missingRevision: missingRevision.modifiedCount ?? 0,
    inFlightSplit: split,
    legacyPendingWindowed,
    legacyPendingSkipped: skipLegacyPendingUndo,
  };
}

async function migrateRecentFeatures() {
  await connectDatabase();

  const prodSafe = resolveProdSafeMode();
  logMigrationMode(prodSafe);

  const skipLeaveSeed = resolveSkipFlag('MIGRATE_SKIP_LEAVE_SEED', prodSafe, true);
  const skipRoleSync = resolveSkipFlag('MIGRATE_SKIP_ROLE_SYNC', prodSafe, true);
  const skipLegacyPendingUndo = resolveSkipFlag(
    'MIGRATE_SKIP_LEGACY_PENDING_UNDO',
    prodSafe,
    true,
  );

  console.log('\n=== Leave request undo-lifecycle backfill ===');
  const undoBackfill = await migrateLeaveRequestUndoLifecycle({ skipLegacyPendingUndo });
  const legacyPendingLine = undoBackfill.legacyPendingSkipped
    ? 'legacy pending undo window grant skipped (prod-safe).'
    : `granted fresh undo windows to ${undoBackfill.legacyPendingWindowed} legacy pending submission(s).`;
  console.log(
    `revision defaulted on ${undoBackfill.missingRevision} request(s); split notifyAfter on ${undoBackfill.inFlightSplit} in-flight staged decision(s); ${legacyPendingLine}`,
  );

  console.log('\n=== Leave policy year backfill ===');
  const backfilled = await migrateLeavePolicyYears();
  if (backfilled === 0) {
    console.log('All leave policies already have a year.');
  }

  console.log('=== Syncing indexes ===');
  await syncAllIndexes();

  if (skipLeaveSeed) {
    console.log('\n=== Leave types & policies (WFH/RH etc.) ===');
    console.log(
      'Skipped — prod-tuned WFH/RH policies left unchanged (prod-safe or MIGRATE_SKIP_LEAVE_SEED).',
    );
  } else {
    console.log('\n=== Leave types & policies (WFH/RH etc.) ===');
    await seedLeaveTypesAndPolicies();
  }

  let roleMap;
  console.log('\n=== Dual-portal role sync ===');
  if (skipRoleSync) {
    console.log(
      'Skipped permission overwrite — using existing roles (prod-safe or MIGRATE_SKIP_ROLE_SYNC).',
    );
    roleMap = await loadExistingRoleMap();
  } else {
    const { roleMap: synced, changes: roleChanges } = await upsertSystemRoles();
    roleMap = synced;
    if (roleChanges.length === 0) {
      console.log('No role permission changes needed.');
    } else {
      roleChanges.forEach((line) => console.log(line));
    }
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
