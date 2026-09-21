/**
 * Half-day apply gaps (integration, real Mongo).
 *
 * Regression tests for two submit-blocking banners on Apply Leave:
 * - SS2: "Combined CL+EL balance cannot exceed 45 days" blocked a 0.5-day CL
 *   request even though consuming leave only shrinks stock. The accumulation
 *   cap must never gate consumption (only growth paths may use it).
 * - SS1: "Leave policy not configured for this type." for types created
 *   without a policy. backfillMissingLeavePolicies seeds a zero-quota policy
 *   (+ balances) so new types are LOP-usable immediately.
 * - AM + PM halves on the same date must not block each other as "overlap".
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { User } from '../models/User.js';
import { createLeaveRequest, validateLeaveRequestInput } from './leaveService.js';
import { backfillMissingLeavePolicies, validateCombinedAccumulation } from './leaveBalanceService.js';
import {
  getISTDateInputValue,
  getISTYear,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';

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

function nextWorkingDay(fromKey, days = 5) {
  let day = parseDateInputAsISTDay(fromKey);
  let remaining = days;
  while (remaining > 0) {
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return getISTDateInputValue(day);
}

async function createUser(name) {
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    passwordHash: 'hash',
    role: 'employee',
    isActive: true,
  });
}

async function createTypeWithPolicy(code, { annualQuota, maxAccumulation = 45, group = 'CL_EL', year }) {
  const leaveType = await LeaveType.create({ code, name: `${code} Leave`, isActive: true });
  await LeavePolicy.create({
    leaveTypeId: leaveType._id,
    year,
    annualQuota,
    accrualPerMonth: 0,
    paid: true,
    maxAccumulation,
    combinedCarryGroup: group,
    isActive: true,
  });
  return leaveType;
}

test('half-day CL applies while combined stock already exceeds the cap', async () => {
  const applicant = await createUser('CapApplicant');
  const dayKey = nextWorkingDay(getISTDateInputValue());
  const year = getISTYear(parseDateInputAsISTDay(dayKey));
  const cl = await createTypeWithPolicy('CL', { annualQuota: 12, year });
  // Corrupt-scale EL quota (mirrors the local EL-122 incident): combined
  // stock (112) sits far above the 45 cap before the request.
  await createTypeWithPolicy('EL', { annualQuota: 100, year });

  const validated = await validateLeaveRequestInput({
    userId: applicant._id,
    leaveTypeId: cl._id,
    startDateInput: dayKey,
    endDateInput: dayKey,
    halfDay: 'am',
  });
  assert.equal(validated.days, 0.5);
});

test('validateCombinedAccumulation still guards growth paths directly', async () => {
  const applicant = await createUser('CapGrowth');
  const dayKey = nextWorkingDay(getISTDateInputValue());
  const year = getISTYear(parseDateInputAsISTDay(dayKey));
  const cl = await createTypeWithPolicy('CL', { annualQuota: 12, year });
  const el = await createTypeWithPolicy('EL', { annualQuota: 100, year });
  const { getPolicyMapForYear } = await import('./leaveBalanceService.js');
  const policyMap = await getPolicyMapForYear(year);
  await assert.rejects(
    validateCombinedAccumulation(applicant._id, year, policyMap, 0.5, cl._id),
    (err) => /cannot exceed 45/.test(err.message),
  );
  assert.ok(el, 'fixture created');
});

test('complementary AM + PM halves share one date; duplicates still block', async () => {
  const applicant = await createUser('HalfApplicant');
  const dayKey = nextWorkingDay(getISTDateInputValue());
  const year = getISTYear(parseDateInputAsISTDay(dayKey));
  const cl = await createTypeWithPolicy('CL', { annualQuota: 12, year });

  await createLeaveRequest(applicant._id, {
    leaveTypeId: cl._id,
    startDate: dayKey,
    endDate: dayKey,
    halfDay: 'am',
    reason: 'Morning appointment',
  });

  // Opposite half on the same date validates fine.
  const pm = await validateLeaveRequestInput({
    userId: applicant._id,
    leaveTypeId: cl._id,
    startDateInput: dayKey,
    endDateInput: dayKey,
    halfDay: 'pm',
  });
  assert.equal(pm.days, 0.5);

  // Same half again is still an overlap.
  await assert.rejects(
    validateLeaveRequestInput({
      userId: applicant._id,
      leaveTypeId: cl._id,
      startDateInput: dayKey,
      endDateInput: dayKey,
      halfDay: 'am',
    }),
    (err) => /overlapping/.test(err.message),
  );

  // A full day over a held half is still an overlap.
  await assert.rejects(
    validateLeaveRequestInput({
      userId: applicant._id,
      leaveTypeId: cl._id,
      startDateInput: dayKey,
      endDateInput: dayKey,
    }),
    (err) => /overlapping/.test(err.message),
  );
});

test('policy-less type becomes submittable after backfill (zero-quota LOP)', async () => {
  const applicant = await createUser('PolicyLessApplicant');
  const dayKey = nextWorkingDay(getISTDateInputValue());
  const year = getISTYear(parseDateInputAsISTDay(dayKey));
  const gg = await LeaveType.create({ code: 'GG', name: 'Test Leave', isActive: true });

  await assert.rejects(
    validateLeaveRequestInput({
      userId: applicant._id,
      leaveTypeId: gg._id,
      startDateInput: dayKey,
      endDateInput: dayKey,
      halfDay: 'am',
    }),
    (err) => /not configured/.test(err.message),
  );

  const created = await backfillMissingLeavePolicies({ year });
  assert.equal(created, 1);
  const policy = await LeavePolicy.findOne({ leaveTypeId: gg._id, year }).lean();
  assert.equal(policy.annualQuota, 0);

  const validated = await validateLeaveRequestInput({
    userId: applicant._id,
    leaveTypeId: gg._id,
    startDateInput: dayKey,
    endDateInput: dayKey,
    halfDay: 'am',
  });
  assert.equal(validated.days, 0.5);
});
