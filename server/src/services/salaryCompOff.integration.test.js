/**
 * Comp-off credit in salary math (integration, real Mongo).
 *
 * Assessed comp-off lands in LeaveBalance.compOffEarned. The monthly salary
 * summary must count it as paid stock: a CO leave covered by compOffEarned
 * contributes paidLeaveDays and does not inflate lopDays. Regression guard
 * for the balance projections that once dropped the field (select without
 * compOffEarned silently zeroes it via ?? 0).
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { Holiday } from '../models/Holiday.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { User } from '../models/User.js';
import { computeMonthlySalarySummary } from './salaryService.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';

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

async function seedUser() {
  sequence += 1;
  return User.create({
    firstName: 'Comp',
    lastName: 'Earner',
    name: 'Comp Earner',
    email: `comp-earner.${sequence}@test.example`,
    mobile: `9${String(400000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    monthlySalary: 30000,
    isActive: true,
  });
}

test('CO leave covered by compOffEarned counts as paid, not LOP', async () => {
  const user = await seedUser();
  const coType = await LeaveType.create({ code: 'CO', name: 'Comp Off', isActive: true });
  await LeavePolicy.create({
    leaveTypeId: coType._id,
    year: 2026,
    annualQuota: 0,
    paid: true,
    isActive: true,
  });
  // 2 days of assessed comp-off credit, nothing else.
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: coType._id,
    year: 2026,
    entitled: 0,
    used: 1,
    pending: 0,
    carried: 0,
    compOffEarned: 2,
    encashed: 0,
  });
  // Approved 1-day CO leave on a September 2026 working day.
  await LeaveRequest.create({
    userId: user._id,
    leaveTypeId: coType._id,
    startDate: parseDateInputAsISTDay('2026-09-10'),
    endDate: parseDateInputAsISTDay('2026-09-10'),
    days: 1,
    status: 'approved',
    reason: 'comp off avail',
  });

  const summary = await computeMonthlySalarySummary(user, '2026-09');
  assert.ok(summary.paidLeaveDays >= 1, `CO day is paid (got ${summary.paidLeaveDays})`);
  const lopForSep10 = (summary.lopDates ?? []).filter((d) => d.date === '2026-09-10');
  assert.equal(lopForSep10.length, 0, 'CO-covered day is not listed as LOP');
});

test('CO leave beyond compOffEarned still counts as LOP', async () => {
  const user = await seedUser();
  const coType = await LeaveType.create({ code: 'CO', name: 'Comp Off', isActive: true });
  await LeavePolicy.create({
    leaveTypeId: coType._id,
    year: 2026,
    annualQuota: 0,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: coType._id,
    year: 2026,
    entitled: 0,
    used: 0,
    pending: 0,
    carried: 0,
    compOffEarned: 1,
    encashed: 0,
  });
  // Two approved 1-day CO leaves against a quota of 1: the first is paid,
  // the second is overdrawn.
  await LeaveRequest.create({
    userId: user._id,
    leaveTypeId: coType._id,
    startDate: parseDateInputAsISTDay('2026-09-10'),
    endDate: parseDateInputAsISTDay('2026-09-10'),
    days: 1,
    status: 'approved',
    reason: 'comp off avail first',
  });
  await LeaveRequest.create({
    userId: user._id,
    leaveTypeId: coType._id,
    startDate: parseDateInputAsISTDay('2026-09-11'),
    endDate: parseDateInputAsISTDay('2026-09-11'),
    days: 1,
    status: 'approved',
    reason: 'comp off avail overdrawn',
  });

  const summary = await computeMonthlySalarySummary(user, '2026-09');
  const lopDates = (summary.lopDates ?? []).map((d) => d.date);
  assert.ok(!lopDates.includes('2026-09-10'), 'quota-covered day is not LOP');
  assert.ok(lopDates.includes('2026-09-11'), 'uncovered day is listed as LOP');
});
