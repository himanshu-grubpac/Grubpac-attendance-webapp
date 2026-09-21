/**
 * Phase 1 — salary/LOP engine unit + integration tests.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { User } from '../models/User.js';
import { PERMISSIONS } from '../../../shared/permissions.js';
import {
  getISTDateInputValue,
  getISTMonthInputValue,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';
import { Holiday } from '../models/Holiday.js';
import {
  createLeaveRequest,
  decideLeaveRequest,
  runLeaveDecisionNotifyJob,
} from './leaveService.js';
import {
  SALARY_DAYS_DIVISOR,
  buildUnpaidLeaveDayMap,
  computeLopDeductionRows,
  computeMtdSalaryMetrics,
  computeMonthlySalarySummary,
  computePayableFromSalaryPool,
  computePerDaySalary,
  getLopDetailForUser,
  resolveSalaryAsOfDate,
  salaryAppliesForMonth,
} from './salaryService.js';

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    AttendanceRecord.deleteMany({}),
    Holiday.deleteMany({}),
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function seedUser(monthlySalary = 32000) {
  sequence += 1;
  return User.create({
    firstName: 'Salary',
    lastName: 'Tester',
    name: 'Salary Tester',
    email: `salary-tester.${sequence}@test.example`,
    mobile: `9${String(500000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    monthlySalary,
    isActive: true,
  });
}

async function seedCheckIn(userId, dayKey, attendanceTag = null) {
  return AttendanceRecord.create({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: parseDateInputAsISTDay(dayKey),
    attendanceTag,
    latitude: 28.647284,
    longitude: 77.202835,
    accuracyMeters: 1,
    distanceMeters: 0,
    officeLatitude: 28.647284,
    officeLongitude: 77.202835,
    radiusMeters: 100,
  });
}

// ── Pure unit tests ───────────────────────────────────────────────────

test('computePerDaySalary uses fixed 30-day divisor — ₹32,000 → ₹1,066.67', () => {
  assert.equal(SALARY_DAYS_DIVISOR, 30);
  assert.equal(computePerDaySalary(32000), 1066.67);
  assert.equal(computePerDaySalary(null), null);
  assert.equal(computePerDaySalary(0), null);
});

test('computeLopDeductionRows — full absent day deducts 100% perDay', () => {
  const rows = computeLopDeductionRows({
    workingDayList: ['2026-06-02'],
    attendanceCreditByDay: new Map(),
    paidLeaveByDay: new Map(),
    unpaidLeaveByDay: new Map(),
    monthlySalary: 32000,
    asOfDateKey: '2026-06-30',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Absent');
  assert.equal(rows[0].amount, 1066.67);
  assert.equal(rows[0].days, 1);
});

test('attendanceCreditForTag — P=1, HD/LV=0.5', async () => {
  const { attendanceCreditForTag } = await import('./salaryService.js');
  assert.equal(attendanceCreditForTag('P'), 1);
  assert.equal(attendanceCreditForTag(null), 1);
  assert.equal(attendanceCreditForTag('HD'), 0.5);
  assert.equal(attendanceCreditForTag('LV'), 0.5);
});

test('computeLopDeductionRows — half day deducts 50% perDay', () => {
  const rows = computeLopDeductionRows({
    workingDayList: ['2026-06-02'],
    attendanceCreditByDay: new Map([['2026-06-02', 0.5]]),
    paidLeaveByDay: new Map(),
    unpaidLeaveByDay: new Map(),
    monthlySalary: 32000,
    asOfDateKey: '2026-06-30',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Half day');
  assert.equal(rows[0].amount, 533.33);
  assert.equal(rows[0].days, 0.5);
});

test('computeLopDeductionRows — paid leave within balance produces no row', () => {
  const rows = computeLopDeductionRows({
    workingDayList: ['2026-06-02'],
    attendanceCreditByDay: new Map(),
    paidLeaveByDay: new Map([['2026-06-02', 1]]),
    unpaidLeaveByDay: new Map(),
    monthlySalary: 32000,
    asOfDateKey: '2026-06-30',
  });

  assert.equal(rows.length, 0);
});

test('computeLopDeductionRows — unpaid leave includes type label', () => {
  const rows = computeLopDeductionRows({
    workingDayList: ['2026-06-02'],
    attendanceCreditByDay: new Map(),
    paidLeaveByDay: new Map(),
    unpaidLeaveByDay: new Map([
      ['2026-06-02', { fraction: 1, leaveTypeCode: 'CL', leaveTypeId: 'lt-cl' }],
    ]),
    monthlySalary: 32000,
    asOfDateKey: '2026-06-30',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Unpaid CL');
  assert.equal(rows[0].category, 'unpaid_leave');
  assert.equal(rows[0].amount, 1066.67);
});

test('computePayableFromSalaryPool — Mohit example: ₹30,000, 4 LOP days → ₹26,000, 26 paid days', () => {
  const perDay = 1000;
  const pool = computePayableFromSalaryPool(30000, 4, 4 * perDay);

  assert.equal(pool.paidDaysOutOf30, 26);
  assert.equal(pool.payableEstimate, 26000);
  assert.equal(pool.payableFromPool, 26000);
  assert.equal(pool.perDaySalary, 1000);
});

test('computeMtdSalaryMetrics — 30-day pool payable matches deduction sum', () => {
  const metrics = computeMtdSalaryMetrics({
    monthlySalary: 30000,
    workingDayList: ['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'],
    attendanceCreditByDay: new Map(),
    paidLeaveByDay: new Map(),
    unpaidLeaveByDay: new Map(),
    asOfDateKey: '2026-06-30',
  });

  assert.equal(metrics.lopDays, 4);
  assert.equal(metrics.paidDaysOutOf30, 26);
  assert.equal(metrics.payableEstimate, 26000);
  assert.equal(metrics.salaryDaysDivisor, 30);
  assert.equal(metrics.maxLopDaysPossible, 4);
  assert.equal(metrics.lopDeduction, 4000);
  assert.equal(metrics.payableEstimate, roundMoney(30000 - metrics.lopDeduction));
});

test('computeMtdSalaryMetrics — MTD cutoff excludes deductions after asOfDate', () => {
  const perDay = 1000;
  const metrics = computeMtdSalaryMetrics({
    monthlySalary: 30000,
    workingDayList: ['2026-06-02', '2026-06-03', '2026-06-04'],
    attendanceCreditByDay: new Map([
      ['2026-06-02', 1],
      ['2026-06-03', 0],
      ['2026-06-04', 0],
    ]),
    paidLeaveByDay: new Map(),
    unpaidLeaveByDay: new Map(),
    asOfDateKey: '2026-06-03',
  });

  assert.equal(metrics.lopDeduction, 1000);
  assert.equal(metrics.payableEstimate, 29000);
  assert.equal(metrics.lopDeductionRows.length, 1);
  assert.equal(metrics.lopDeductionRows[0].date, '2026-06-03');
});

test('resolveSalaryAsOfDate defaults to month-end for past months', () => {
  const resolved = resolveSalaryAsOfDate('2020-06');
  assert.ok(resolved);
  assert.equal(resolved.asOfDateKey, '2020-06-30');
});

test('resolveSalaryAsOfDate defaults to today for current IST month', () => {
  const currentMonth = getISTMonthInputValue();
  const resolved = resolveSalaryAsOfDate(currentMonth);
  assert.ok(resolved);
  assert.equal(resolved.asOfDateKey, getISTDateInputValue(new Date()));
});

test('resolveSalaryAsOfDate clamps explicit asOf within month bounds', () => {
  const resolved = resolveSalaryAsOfDate('2026-06', '2026-06-15');
  assert.equal(resolved.asOfDateKey, '2026-06-15');
});

test('salaryAppliesForMonth — salaryEffectiveFrom blocks months before effective date', () => {
  const monthEndMay = parseDateInputAsISTDay('2026-05-31');
  const monthEndJun = parseDateInputAsISTDay('2026-06-30');
  const user = {
    monthlySalary: 30000,
    salaryEffectiveFrom: parseDateInputAsISTDay('2026-06-15'),
  };

  assert.equal(salaryAppliesForMonth(user, monthEndMay), false);
  assert.equal(salaryAppliesForMonth(user, monthEndJun), true);
});

test('salaryAppliesForMonth — mid-month effective date still applies for that month', () => {
  const monthEndJun = parseDateInputAsISTDay('2026-06-30');
  const user = {
    monthlySalary: 30000,
    salaryEffectiveFrom: parseDateInputAsISTDay('2026-06-16'),
  };

  assert.equal(salaryAppliesForMonth(user, monthEndJun), true);
});

// ── Integration tests (recompute on read) ─────────────────────────────

test('integration: Mohit example — 4 full LOP days → payable ₹26,000, paidDaysOutOf30 26', async () => {
  const user = await seedUser(30000);
  const absentDays = new Set(['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']);

  for (let day = 1; day <= 30; day += 1) {
    const dayKey = `2026-06-${String(day).padStart(2, '0')}`;
    if (!absentDays.has(dayKey)) {
      await seedCheckIn(user._id, dayKey);
    }
  }

  const summary = await computeMonthlySalarySummary(user, '2026-06', {
    asOfDate: '2026-06-30',
  });

  assert.equal(summary.perDaySalary, 1000);
  assert.equal(summary.lopDays, 4);
  assert.equal(summary.paidDaysOutOf30, 26);
  assert.equal(summary.payableEstimate, 26000);
  assert.equal(summary.mtdPayable, 26000);
  assert.equal(summary.salaryDaysDivisor, 30);
  assert.ok(summary.lopDays <= summary.maxLopDaysPossible);
});

test('integration: full attendance on all working days → full monthly salary', async () => {
  const user = await seedUser(30000);

  for (let day = 1; day <= 30; day += 1) {
    const dayKey = `2026-06-${String(day).padStart(2, '0')}`;
    await seedCheckIn(user._id, dayKey);
  }

  const summary = await computeMonthlySalarySummary(user, '2026-06', {
    asOfDate: '2026-06-30',
  });

  assert.equal(summary.lopDays, 0);
  assert.equal(summary.paidDaysOutOf30, 30);
  assert.equal(summary.payableEstimate, 30000);
  assert.equal(summary.lopDeduction, 0);
  assert.ok(summary.maxLopDaysPossible > 0);
});

test('integration: LOP days never exceed working days in month (maxLopDaysPossible cap)', async () => {
  const user = await seedUser(30000);
  const summary = await computeMonthlySalarySummary(user, '2026-06', {
    asOfDate: '2026-06-30',
  });

  assert.ok(summary.maxLopDaysPossible > 0);
  assert.ok(summary.maxLopDaysPossible <= 31);
  assert.equal(summary.lopDays, summary.maxLopDaysPossible);
  assert.equal(summary.paidDaysOutOf30, roundMoney(30 - summary.maxLopDaysPossible));
  assert.equal(summary.payableEstimate, roundMoney(30000 - summary.lopDeduction));
});

test('integration: absent + half day + MTD payable formula', async () => {
  const user = await seedUser(32000);
  await seedCheckIn(user._id, '2026-06-01');
  await seedCheckIn(user._id, '2026-06-02');
  await seedCheckIn(user._id, '2026-06-03', 'HD');
  // 2026-06-04 onward left absent

  const midMonth = await computeMonthlySalarySummary(user, '2026-06', {
    asOfDate: '2026-06-03',
  });
  assert.equal(midMonth.perDaySalary, 1066.67);
  assert.equal(midMonth.lopDeduction, 533.33);
  assert.equal(midMonth.payableEstimate, 31466.67);

  const monthEnd = await computeMonthlySalarySummary(user, '2026-06', {
    asOfDate: '2026-06-30',
  });
  assert.ok(monthEnd.lopDeduction > midMonth.lopDeduction);
  assert.equal(monthEnd.payableEstimate, roundMoney(32000 - monthEnd.lopDeduction));
});

test('integration: paid CL excluded; unpaid CL included with label', async () => {
  const user = await seedUser(30000);
  const clType = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
  await LeavePolicy.create({
    leaveTypeId: clType._id,
    year: 2026,
    annualQuota: 1,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: clType._id,
    year: 2026,
    entitled: 1,
    used: 0,
    pending: 0,
    carried: 0,
    compOffEarned: 0,
    encashed: 0,
  });

  await LeaveRequest.create({
    userId: user._id,
    leaveTypeId: clType._id,
    startDate: parseDateInputAsISTDay('2026-06-02'),
    endDate: parseDateInputAsISTDay('2026-06-02'),
    days: 1,
    status: 'approved',
    reason: 'paid CL',
  });
  await LeaveRequest.create({
    userId: user._id,
    leaveTypeId: clType._id,
    startDate: parseDateInputAsISTDay('2026-06-03'),
    endDate: parseDateInputAsISTDay('2026-06-03'),
    days: 1,
    status: 'approved',
    reason: 'unpaid CL overdraw',
  });

  const summary = await computeMonthlySalarySummary(user, '2026-06', {
    asOfDate: '2026-06-30',
  });

  const unpaidRows = (summary.lopDeductionRows ?? []).filter((r) => r.category === 'unpaid_leave');
  assert.equal(unpaidRows.length, 1);
  assert.equal(unpaidRows[0].reason, 'Unpaid CL');
  assert.equal(unpaidRows[0].date, '2026-06-03');
  assert.ok(!(summary.lopDeductionRows ?? []).some((r) => r.date === '2026-06-02'));
});

test('integration: attendance edit reflected on recompute (absent → present)', async () => {
  const user = await seedUser(30000);
  const day = '2026-06-02';

  const before = await computeMonthlySalarySummary(user, '2026-06', { asOfDate: '2026-06-30' });
  assert.ok(before.lopDeduction > 0);

  await seedCheckIn(user._id, day);

  const after = await computeMonthlySalarySummary(user, '2026-06', { asOfDate: '2026-06-30' });
  assert.equal(after.lopDeduction, before.lopDeduction - 1000);
  assert.equal(after.payableEstimate, before.payableEstimate + 1000);
});

test('buildUnpaidLeaveDayMap treats all paid-type days as unpaid when quota map is empty', () => {
  const typeId = 'sl-type';
  const day = parseDateInputAsISTDay('2026-06-04');
  const requests = [
    {
      _id: 'r1',
      leaveTypeId: typeId,
      startDate: day,
      endDate: day,
      days: 1,
    },
  ];

  const unpaidMap = buildUnpaidLeaveDayMap(
    requests,
    day,
    day,
    new Set(),
    new Set([typeId]),
    new Map(),
    new Map([[typeId, 'SL']]),
  );

  assert.equal(unpaidMap.size, 1);
  assert.equal(unpaidMap.get('2026-06-04')?.fraction, 1);
  assert.equal(unpaidMap.get('2026-06-04')?.leaveTypeCode, 'SL');
});

test('integration: leave apply → approve → LOP detail shows Unpaid CL', async () => {
  const manager = await User.create({
    firstName: 'Manager',
    lastName: 'One',
    name: 'Manager One',
    email: `mgr.${sequence}@test.example`,
    mobile: `9${String(400000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    isActive: true,
  });
  sequence += 1;
  const applicant = await User.create({
    firstName: 'Apply',
    lastName: 'Tester',
    name: 'Apply Tester',
    email: `apply.${sequence}@test.example`,
    mobile: `9${String(410000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    monthlySalary: 30000,
    reportingManagerId: manager._id,
    isActive: true,
  });

  const clType = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
  await LeavePolicy.create({
    leaveTypeId: clType._id,
    year: 2026,
    annualQuota: 0,
    accrualPerMonth: 0,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: applicant._id,
    leaveTypeId: clType._id,
    year: 2026,
    entitled: 0,
    used: 0,
    pending: 0,
    carried: 0,
    compOffEarned: 0,
    encashed: 0,
  });

  const dayKey = '2026-06-09';
  const created = await createLeaveRequest(applicant._id, {
    leaveTypeId: clType._id.toString(),
    startDate: dayKey,
    endDate: dayKey,
    reason: 'zero balance apply',
  });
  assert.equal(created.status, 'pending');

  await runLeaveDecisionNotifyJob(
    new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000),
  );

  // Team-audit read lets the manager view a direct report's LOP detail
  // (payroll read alone no longer implies team scope since the catalog).
  const managerPerms = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.SALARY_TEAM_AUDIT_R];
  await decideLeaveRequest(created.id, manager, managerPerms, 'approved', {
    comment: 'Approved despite zero balance',
  });

  const staged = await LeaveRequest.findById(created.id).lean();
  await runLeaveDecisionNotifyJob(new Date(new Date(staged.notifyAfter).getTime() + 1000));

  const finalReq = await LeaveRequest.findById(created.id).lean();
  assert.equal(finalReq.status, 'approved');

  const detail = await getLopDetailForUser(
    manager,
    managerPerms,
    applicant._id.toString(),
    '2026-06',
    '2026-06-30',
  );

  const unpaidRow = detail.deductions.find((row) => row.reason === 'Unpaid CL' && row.date === dayKey);
  assert.ok(unpaidRow, 'approved overdrawn CL must appear as Unpaid CL in LOP detail');
  assert.equal(unpaidRow.amountDeducted, 1000);
});

test('integration: day 31 absent produces LOP like any working day', async () => {
  const user = await seedUser(30000);
  await seedCheckIn(user._id, '2026-03-30');
  // 2026-03-31 is Tuesday — absent

  const summary = await computeMonthlySalarySummary(user, '2026-03', {
    asOfDate: '2026-03-31',
  });

  const day31Row = (summary.lopDeductionRows ?? []).find((row) => row.date === '2026-03-31');
  assert.ok(day31Row, 'day 31 absent must deduct LOP');
  assert.equal(day31Row.amount, 1000);
});

test('integration: day 31 present counts as attendance credit', async () => {
  const user = await seedUser(30000);
  await seedCheckIn(user._id, '2026-03-31');

  const summary = await computeMonthlySalarySummary(user, '2026-03', {
    asOfDate: '2026-03-31',
  });

  assert.equal(summary.presentDays, 1);
  assert.ok(!(summary.lopDeductionRows ?? []).some((row) => row.date === '2026-03-31'));
});

test('integration: zero-balance SL approved leave surfaces as Unpaid SL', async () => {
  const user = await seedUser(30000);
  const slType = await LeaveType.create({ code: 'SL', name: 'Sick Leave', isActive: true });
  await LeavePolicy.create({
    leaveTypeId: slType._id,
    year: 2026,
    annualQuota: 0,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: slType._id,
    year: 2026,
    entitled: 0,
    used: 0,
    pending: 0,
    carried: 0,
    compOffEarned: 0,
    encashed: 0,
  });

  await LeaveRequest.create({
    userId: user._id,
    leaveTypeId: slType._id,
    startDate: parseDateInputAsISTDay('2026-06-05'),
    endDate: parseDateInputAsISTDay('2026-06-05'),
    days: 1,
    status: 'approved',
    reason: 'zero balance SL',
  });

  const summary = await computeMonthlySalarySummary(user, '2026-06', {
    asOfDate: '2026-06-30',
  });

  const unpaidRows = (summary.lopDeductionRows ?? []).filter((r) => r.category === 'unpaid_leave');
  assert.equal(unpaidRows.length, 1);
  assert.equal(unpaidRows[0].reason, 'Unpaid SL');
  assert.equal(unpaidRows[0].date, '2026-06-05');
  assert.equal(unpaidRows[0].amount, 1000);
});

test('integration: salaryEffectiveFrom excludes employee from earlier months', async () => {
  sequence += 1;
  const user = await User.create({
    firstName: 'Effective',
    lastName: 'From',
    name: 'Effective From',
    email: `effective.from.${sequence}@test.example`,
    mobile: `9${String(520000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    monthlySalary: 30000,
    salaryEffectiveFrom: parseDateInputAsISTDay('2026-06-15'),
    isActive: true,
  });

  const may = await computeMonthlySalarySummary(user, '2026-05', { asOfDate: '2026-05-31' });
  assert.equal(may.hasSalaryConfigured, false);
  assert.equal(may.monthlySalary, null);

  await seedCheckIn(user._id, '2026-06-02');
  const june = await computeMonthlySalarySummary(user, '2026-06', { asOfDate: '2026-06-30' });
  assert.equal(june.hasSalaryConfigured, true);
  assert.equal(june.monthlySalary, 30000);
});

test('integration: holiday working day excluded from LOP deductions', async () => {
  await Holiday.create({
    date: parseDateInputAsISTDay('2026-06-05'),
    name: 'Company Holiday',
    isActive: true,
  });

  const user = await seedUser(30000);
  const summary = await computeMonthlySalarySummary(user, '2026-06', { asOfDate: '2026-06-30' });

  assert.ok(
    !(summary.lopDeductionRows ?? []).some((row) => row.date === '2026-06-05'),
    'holiday must not produce an absent LOP row',
  );
  assert.ok(summary.workingDaysInMonth > 0);
});

test('integration: endingDate does not truncate salary month window in computeMonthlySalarySummary', async () => {
  sequence += 1;
  const user = await User.create({
    firstName: 'Ending',
    lastName: 'Soon',
    name: 'Ending Soon',
    email: `ending.soon.${sequence}@test.example`,
    mobile: `9${String(530000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    monthlySalary: 30000,
    endingDate: parseDateInputAsISTDay('2026-06-10'),
    isActive: true,
  });

  const summary = await computeMonthlySalarySummary(user, '2026-06', { asOfDate: '2026-06-30' });
  const absentAfterEnding = (summary.lopDeductionRows ?? []).some((row) => row.date === '2026-06-16');
  assert.ok(absentAfterEnding, 'current engine still evaluates LOP after endingDate');
});

test('integration: past month asOf month-end yields full-month payable vs MTD cutoff', async () => {
  const user = await seedUser(30000);
  await seedCheckIn(user._id, '2026-06-01');
  await seedCheckIn(user._id, '2026-06-02');
  await seedCheckIn(user._id, '2026-06-03');

  const mtd = await computeMonthlySalarySummary(user, '2026-06', { asOfDate: '2026-06-10' });
  const fullMonth = await computeMonthlySalarySummary(user, '2026-06', { asOfDate: '2026-06-30' });
  const defaulted = await computeMonthlySalarySummary(user, '2026-06');

  assert.ok(fullMonth.lopDeduction >= mtd.lopDeduction);
  assert.equal(defaulted.asOfDate, fullMonth.asOfDate);
  assert.equal(defaulted.mtdPayable, fullMonth.mtdPayable);
});

test('buildUnpaidLeaveDayMap matches quota consumption order', () => {
  const typeId = 'cl-type';
  const monthStart = parseDateInputAsISTDay('2026-06-02');
  const monthEnd = parseDateInputAsISTDay('2026-06-03');
  const requests = [
    {
      _id: 'r1',
      leaveTypeId: typeId,
      startDate: monthStart,
      endDate: monthStart,
      days: 1,
    },
    {
      _id: 'r2',
      leaveTypeId: typeId,
      startDate: monthEnd,
      endDate: monthEnd,
      days: 1,
    },
  ];

  const unpaidMap = buildUnpaidLeaveDayMap(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set([typeId]),
    new Map([[typeId, 1]]),
    new Map([[typeId, 'CL']]),
  );

  assert.equal(unpaidMap.size, 1);
  assert.equal(unpaidMap.get('2026-06-03')?.fraction, 1);
  assert.equal(unpaidMap.get('2026-06-03')?.leaveTypeCode, 'CL');
});
