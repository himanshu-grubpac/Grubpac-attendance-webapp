/**
 * Unified approvals pending-counts (integration, real Mongo).
 *
 * getLeavePendingCounts splits pending leave vs WFH-only leave, scoped to the
 * caller's approval queue (direct reports unless LEAVE_READ_ALL).
 * getCompOffPendingCounts splits pending vs worked (awaiting assessment).
 * Non-approvers get zeros, never a 403.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { CompOffRequest } from '../models/CompOffRequest.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { User } from '../models/User.js';
import { getLeavePendingCounts } from './leaveService.js';
import { getCompOffPendingCounts } from './compOffService.js';
import {
  getISTDateInputValue,
  getISTYear,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';

let memoryServer;
let sequence = 0;

const MANAGER_PERMS = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_READ];
const ADMIN_PERMS = [...MANAGER_PERMS, PERMISSIONS.LEAVE_READ_ALL];
const NO_APPROVE_PERMS = [PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_APPLY];

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    CompOffRequest.deleteMany({}),
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

async function createUser(name, { reportingManagerId = null } = {}) {
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
    reportingManagerId,
    isActive: true,
  });
}

async function seedTypes() {
  const cl = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
  const wfh = await LeaveType.create({ code: 'WFH', name: 'Work From Home', isActive: true });
  const year = getISTYear();
  for (const leaveType of [cl, wfh]) {
    await LeavePolicy.create({
      leaveTypeId: leaveType._id,
      year,
      annualQuota: 12,
      accrualPerMonth: 0,
      paid: true,
      isActive: true,
    });
  }
  return { cl, wfh, year };
}

async function submitDirect(applicant, leaveType, dayKey) {
  return LeaveRequest.create({
    userId: applicant._id,
    leaveTypeId: leaveType._id,
    startDate: parseDateInputAsISTDay(dayKey),
    endDate: parseDateInputAsISTDay(dayKey),
    days: 1,
    status: 'pending',
    reason: 'counts fixture',
  });
}

test('leave counts split WFH vs non-WFH within the approval queue', async () => {
  const manager = await createUser('CountsManager');
  const applicant = await createUser('CountsApplicant', { reportingManagerId: manager._id });
  const outsider = await createUser('CountsOutsider');
  const { cl, wfh } = await seedTypes();
  const dayKey = nextWorkingDay(getISTDateInputValue(), 5);

  await submitDirect(applicant, cl, dayKey);
  await submitDirect(applicant, wfh, dayKey);
  await submitDirect(outsider, cl, dayKey);

  const scoped = await getLeavePendingCounts(manager, MANAGER_PERMS);
  assert.equal(scoped.leave, 1, 'one non-WFH pending in queue');
  assert.equal(scoped.wfh, 1, 'one WFH pending in queue');

  const admin = await getLeavePendingCounts(manager, ADMIN_PERMS);
  assert.equal(admin.leave, 2, 'admin sees outsider request too');
  assert.equal(admin.wfh, 1);

  const none = await getLeavePendingCounts(applicant, NO_APPROVE_PERMS);
  assert.deepEqual(none, { leave: 0, wfh: 0 }, 'non-approvers get zeros');
});

test('comp-off counts split pending vs worked, scoped to queue', async () => {
  const manager = await createUser('CoCountsManager');
  const applicant = await createUser('CoCountsApplicant', { reportingManagerId: manager._id });
  const outsider = await createUser('CoCountsOutsider');
  const dayKey = nextWorkingDay(getISTDateInputValue(), 5);
  const day = parseDateInputAsISTDay(dayKey);

  await CompOffRequest.create({
    userId: applicant._id, startDate: day, endDate: day, days: 1, status: 'pending', reason: 'x',
  });
  await CompOffRequest.create({
    userId: applicant._id, startDate: day, endDate: day, days: 1, status: 'worked', reason: 'x',
  });
  await CompOffRequest.create({
    userId: outsider._id, startDate: day, endDate: day, days: 1, status: 'pending', reason: 'x',
  });

  const scoped = await getCompOffPendingCounts(manager, MANAGER_PERMS);
  assert.deepEqual(scoped, { pending: 1, assessment: 1 });

  const admin = await getCompOffPendingCounts(manager, ADMIN_PERMS);
  assert.deepEqual(admin, { pending: 2, assessment: 1 });

  const none = await getCompOffPendingCounts(applicant, NO_APPROVE_PERMS);
  assert.deepEqual(none, { pending: 0, assessment: 0 });
});
