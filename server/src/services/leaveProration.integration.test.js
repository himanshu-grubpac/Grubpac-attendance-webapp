process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { COMPANY_WIDE_SCOPE_SLUG, PERMISSIONS, SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import { Department } from '../models/Department.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveType } from '../models/LeaveType.js';
import { User } from '../models/User.js';
import {
  adjustBalance,
  computeProratedEntitled,
  ensureBalancesForUser,
  getBalancesForUser,
  getUserLeaveStartKey,
  recomputeEntitledForPolicy,
  seedLeaveTypesAndPolicies,
} from './leaveBalanceService.js';
import { getLeaveAdjustmentHistory } from './leaveAdjustmentService.js';
import { getISTDateInputValue, getISTYear } from '../utils/istDate.js';

const ADMIN_PERMS = [COMPANY_WIDE_SCOPE_SLUG, PERMISSIONS.LEAVE_ADJUST_BALANCES,
  PERMISSIONS.ATTENDANCE_READ_ALL];

let memoryServer;
let sequence = 0;
let YEAR;

// Actor form for company-wide (admin) calls: the scope helper reads roleSlug
// off the actor (production req.user carries the resolved slug).
const asAdmin = (userDoc) => ({
  ...userDoc.toObject(),
  _id: userDoc._id,
  roleSlug: SYSTEM_ROLE_SLUGS.ADMIN,
});

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
  YEAR = getISTYear();
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveType.deleteMany({}),
    User.deleteMany({}),
  ]);
  await seedLeaveTypesAndPolicies();
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser(name, { joiningDate = null, salaryEffectiveFrom = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: '',
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `T${String(sequence).padStart(8, '0')}`,
    passwordHash: 'test-password-hash',
    role: 'employee',
    joiningDate,
    salaryEffectiveFrom,
    isActive: true,
  });
}

async function clBalance(userId, year) {
  const clType = await LeaveType.findOne({ code: 'CL' });
  return LeaveBalance.findOne({ userId, leaveTypeId: clType._id, year }).lean();
}

test('getUserLeaveStartKey prefers contract start over joining date', async () => {
  const user = await createUser('Start Key', {
    joiningDate: new Date(`${YEAR}-02-01T00:00:00Z`),
    salaryEffectiveFrom: new Date(`${YEAR}-08-27T00:00:00Z`),
  });
  assert.equal(await getUserLeaveStartKey(user._id), `${YEAR}-08-27`);

  const joinOnly = await createUser('Join Only', {
    joiningDate: new Date(`${YEAR}-03-05T00:00:00Z`),
  });
  assert.equal(await getUserLeaveStartKey(joinOnly._id), `${YEAR}-03-05`);

  const neither = await createUser('No Dates');
  assert.equal(await getUserLeaveStartKey(neither._id), null);
});

test('mid-year joiner gets prorated entitled on first ensure', async () => {
  const user = await createUser('Mid Joiner', {
    joiningDate: new Date(`${YEAR}-08-27T00:00:00Z`),
  });
  await ensureBalancesForUser(user._id, YEAR);
  const balance = await clBalance(user._id, YEAR);
  const expected = computeProratedEntitled({
    annualQuota: 7,
    accrualPerMonth: 0,
    year: YEAR,
    joiningDateKey: `${YEAR}-08-27`,
  });
  assert.equal(balance.entitled, expected);
  assert.ok(expected > 0 && expected < 7);
});

test('full-year joiner keeps the full quota', async () => {
  const user = await createUser('Full Joiner', {
    joiningDate: new Date(`${YEAR - 1}-06-01T00:00:00Z`),
  });
  await ensureBalancesForUser(user._id, YEAR);
  const balance = await clBalance(user._id, YEAR);
  assert.equal(balance.entitled, 7);
});

test('stale full-quota seed rows converge to prorated on next ensure', async () => {
  const user = await createUser('Stale Row', {
    joiningDate: new Date(`${YEAR}-08-27T00:00:00Z`),
  });
  await ensureBalancesForUser(user._id, YEAR);
  // Simulate a row seeded under the old full-quota logic.
  await LeaveBalance.updateOne(
    { userId: user._id, year: YEAR },
    { $set: { entitled: 7 } },
  );
  const balances = await getBalancesForUser(user._id, YEAR);
  const cl = balances.find((item) => item.leaveTypeCode === 'CL');
  const expected = computeProratedEntitled({
    annualQuota: 7,
    accrualPerMonth: 0,
    year: YEAR,
    joiningDateKey: `${YEAR}-08-27`,
  });
  assert.equal(cl.entitled, expected);
});

test('deliberate manual entitled tweaks survive ensure', async () => {
  const user = await createUser('Manual Tweaker', {
    joiningDate: new Date(`${YEAR}-08-27T00:00:00Z`),
  });
  const clType = await LeaveType.findOne({ code: 'CL' });
  await adjustBalance(
    user._id,
    { leaveTypeId: clType._id.toString(), year: YEAR, entitled: 5, reason: 'Special grant' },
    user._id,
  );
  const locked = await clBalance(user._id, YEAR);
  assert.equal(locked.entitled, 5);
  assert.equal(locked.entitledLocked, true);

  await ensureBalancesForUser(user._id, YEAR);
  const after = await clBalance(user._id, YEAR);
  assert.equal(after.entitled, 5);
});

test('stale non-quota unlocked rows heal to the computed value on ensure', async () => {
  // Regression: rows frozen at an older quota era (e.g. SL 2.5 against a
  // quota of 7) used to be skipped forever because the guard assumed any
  // non-quota value was deliberate. Only entitledLocked protects a row now.
  const user = await createUser('Stale Era', {
    joiningDate: new Date(`${YEAR}-01-01T00:00:00Z`),
  });
  await ensureBalancesForUser(user._id, YEAR);
  await LeaveBalance.updateOne(
    { userId: user._id, year: YEAR },
    { $set: { entitled: 2.5, entitledLocked: false } },
  );
  const balances = await getBalancesForUser(user._id, YEAR);
  const cl = balances.find((item) => item.leaveTypeCode === 'CL');
  assert.equal(cl.entitled, 7);
});

test('accrual policies grant the full quota upfront regardless of month', async () => {
  const elType = await LeaveType.findOne({ code: 'EL' });
  await LeavePolicy.updateOne(
    { leaveTypeId: elType._id, year: YEAR },
    { $set: { annualQuota: 365, accrualPerMonth: 30 } },
  );
  const user = await createUser('Upfront Accrual', {
    joiningDate: new Date(`${YEAR}-01-01T00:00:00Z`),
  });
  await ensureBalancesForUser(user._id, YEAR);
  const balance = await LeaveBalance.findOne({
    userId: user._id,
    leaveTypeId: elType._id,
    year: YEAR,
  }).lean();
  assert.equal(balance.entitled, 365);
});

test('policy edit recomputes unlocked rows and skips locked ones', async () => {
  const mid = await createUser('Recompute Mid', {
    joiningDate: new Date(`${YEAR}-08-27T00:00:00Z`),
  });
  const full = await createUser('Recompute Full', {
    joiningDate: new Date(`${YEAR - 1}-01-10T00:00:00Z`),
  });
  const clType = await LeaveType.findOne({ code: 'CL' });
  await ensureBalancesForUser(mid._id, YEAR);
  await ensureBalancesForUser(full._id, YEAR);
  // Hand-lock the full-year employee's row.
  await adjustBalance(
    full._id,
    { leaveTypeId: clType._id.toString(), year: YEAR, entitled: 9, reason: 'Retention grant' },
    full._id,
  );

  const policy = await LeavePolicy.findOne({ leaveTypeId: clType._id, year: YEAR });
  policy.annualQuota = 10;
  await policy.save();

  const result = await recomputeEntitledForPolicy(policy._id);
  assert.equal(result.year, YEAR);
  assert.equal(result.skippedLocked, 1);
  assert.ok(result.recomputed >= 1);

  const midBalance = await clBalance(mid._id, YEAR);
  assert.equal(
    midBalance.entitled,
    computeProratedEntitled({
      annualQuota: 10,
      accrualPerMonth: 0,
      year: YEAR,
      joiningDateKey: `${YEAR}-08-27`,
    }),
  );
  const fullBalance = await clBalance(full._id, YEAR);
  assert.equal(fullBalance.entitled, 9);
});

test('adjustment history returns three years of per-type snapshots', async () => {
  const admin = await createUser('History Admin');
  const employee = await createUser('History Employee', {
    joiningDate: new Date(`${YEAR - 2}-04-01T00:00:00Z`),
  });
  const clType = await LeaveType.findOne({ code: 'CL' });
  await ensureBalancesForUser(employee._id, YEAR - 1);
  await ensureBalancesForUser(employee._id, YEAR);
  await adjustBalance(
    employee._id,
    { leaveTypeId: clType._id.toString(), year: YEAR, carried: 3, reason: 'Carry test' },
    admin._id,
  );

  const history = await getLeaveAdjustmentHistory(asAdmin(admin), ADMIN_PERMS, employee._id.toString(), {
    year: YEAR,
  });
  assert.equal(history.user.employeeCode, employee.employeeCode);
  assert.deepEqual(
    history.years.map((entry) => entry.year),
    [YEAR],
  );
  for (const entry of history.years) {
    assert.ok(entry.balances.length > 0);
    for (const snapshot of entry.balances) {
      for (const field of [
        'entitled',
        'carried',
        'used',
        'pending',
        'compOffEarned',
        'encashed',
        'available',
      ]) {
        assert.equal(typeof snapshot[field], 'number', `${entry.year}/${snapshot.leaveTypeCode}.${field}`);
      }
    }
  }
  const current = history.years.find((entry) => entry.year === YEAR);
  const cl = current.balances.find((item) => item.leaveTypeCode === 'CL');
  assert.equal(cl.hasRecord, true);
  assert.equal(cl.carried, 3);
  assert.equal(cl.available, cl.entitled + cl.carried - cl.used - cl.pending - cl.encashed + cl.compOffEarned);
});

test('history shows zero leave for a pre-joining year, not an error', async () => {
  const admin = await createUser('Flag Admin');
  const employee = await createUser('Flag Employee', {
    joiningDate: new Date(`${YEAR}-04-01T00:00:00Z`),
  });
  const history = await getLeaveAdjustmentHistory(asAdmin(admin), ADMIN_PERMS, employee._id.toString(), {
    year: YEAR - 1,
  });
  assert.ok(history.user.contractStartDate, 'contract start exposed for context');
  assert.deepEqual(
    history.years.map((entry) => entry.year),
    [YEAR - 1],
  );

  const yearEntry = history.years[0];
  assert.ok(yearEntry.balances.length > 0);
  const cl = yearEntry.balances.find((item) => item.leaveTypeCode === 'CL');
  // Joined after that year: materialized rows carry zero entitlement.
  assert.equal(cl.hasRecord, true);
  assert.equal(cl.entitled, 0);
  assert.equal(cl.available, 0);
});

test('history flags types without a policy instead of zero-filling', async () => {
  const admin = await createUser('Policy Flag Admin');
  const employee = await createUser('Policy Flag Employee', {
    joiningDate: new Date(`${YEAR - 1}-05-01T00:00:00Z`),
  });
  await LeaveType.create({ code: 'XX', name: 'No Policy Type', isActive: true });

  const history = await getLeaveAdjustmentHistory(asAdmin(admin), ADMIN_PERMS, employee._id.toString(), {
    year: YEAR,
  });
  const current = history.years[0];
  const orphan = current.balances.find((item) => item.leaveTypeCode === 'XX');
  assert.ok(orphan, 'policy-less type still listed');
  assert.equal(orphan.hasRecord, false);
  const cl = current.balances.find((item) => item.leaveTypeCode === 'CL');
  assert.equal(cl.hasRecord, true);
});

test('history respects access scope', async () => {
  const outsider = await createUser('History Outsider');
  const employee = await createUser('History Target');
  await assert.rejects(
    getLeaveAdjustmentHistory(outsider, [PERMISSIONS.LEAVE_ADJUST_BALANCES], employee._id.toString(), {
      year: YEAR,
    }),
    (err) => err.statusCode === 403,
  );
});

test('audit report exposes full component columns and stays un-uploadable', async () => {
  const { buildCarryAuditReport, parseCarryBulkWorkbook } = await import('./leaveCarryBulkService.js');
  const XLSX = await import('xlsx');
  const employee = await createUser('Audit Columns', {
    joiningDate: new Date(`${YEAR - 1}-05-01T00:00:00Z`),
  });
  await ensureBalancesForUser(employee._id, YEAR);

  const buffer = await buildCarryAuditReport({ year: YEAR, fromYear: YEAR - 1, toYear: YEAR });
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.CarriedLeave, { header: 1, defval: null });
  const subHeader = rows.find((row) => Array.isArray(row) && row.includes('Entitled'));
  assert.ok(subHeader, 'audit sheet has a sub-header row');
  const start = subHeader.indexOf('Entitled');
  assert.deepEqual(subHeader.slice(start, start + 7), [
    'Entitled',
    'Used',
    'Carried',
    'Pending',
    'CompOff',
    'Encashed',
    'Remaining',
  ]);

  // The audit layout must never match the upload parser's
  // Entitled/Used/Remaining/Carry template signature.
  assert.throws(() => parseCarryBulkWorkbook(buffer), /column groups|Carry/);
});
