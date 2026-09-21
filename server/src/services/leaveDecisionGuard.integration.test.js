/**
 * Decision-time finalizability guard (integration, real Mongo).
 *
 * Every staged decision must be finalizable — never stage a poison row that
 * hangs as PENDING through every sweep forever.
 *
 * Requests whose leave type was deleted/deactivated after submission stay
 * actionable:
 * - reject always stages + finalizes (release is null-safe, notify falls back)
 * - approve stages + finalizes when the balance row survives (finalize never
 *   reads the LeaveType row itself)
 * - approve with a wiped balance but live policy regenerates the true quota
 * - approve with no balance and no policy provisions a zeroed row so the
 *   days finalize as unpaid (LOP) instead of hanging forever
 * - healthy decision still stages normally
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
import { LopRecord } from '../models/LopRecord.js';
import { User } from '../models/User.js';
import { processLeaveDecision, runLeaveDecisionNotifyJob } from './leaveService.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    LopRecord.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser() {
  sequence += 1;
  return User.create({
    firstName: 'Applicant',
    lastName: 'Test',
    name: 'Applicant Test',
    email: `applicant.${sequence}@test.example`,
    mobile: `9${String(400000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
  });
}

async function createType(code = 'CL') {
  sequence += 1;
  return LeaveType.create({ code: `${code}${sequence}`, name: 'Casual Leave' });
}

async function createRequest(user, leaveType) {
  return LeaveRequest.create({
    userId: user._id,
    leaveTypeId: leaveType._id,
    startDate: new Date('2026-10-05T06:30:00.000Z'),
    endDate: new Date('2026-10-06T06:30:00.000Z'),
    days: 2,
    reason: 'Family function visit',
    status: 'pending',
    revision: 0,
  });
}

async function freshRequest(id) {
  return LeaveRequest.findById(id);
}

async function createBalance(user, leaveType) {
  return LeaveBalance.create({
    userId: user._id,
    leaveTypeId: leaveType._id,
    year: 2026,
    entitled: 7,
    used: 0,
    pending: 0,
    carried: 0,
    encashed: 0,
  });
}

async function finalizeStaged(staged) {
  const dueAt = new Date(new Date(staged.decisionUndoExpiresAt).getTime() + 5000);
  await runLeaveDecisionNotifyJob(dueAt);
}

test('reject on deleted leave type stages and finalizes (no balance row)', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  const request = await createRequest(applicant, type);
  await LeaveType.findByIdAndDelete(type._id);

  const staged = await processLeaveDecision(await freshRequest(request._id), actor, 'reject');
  assert.equal(staged.pendingDecision, 'rejected');
  await finalizeStaged(staged);

  const live = await freshRequest(request._id);
  assert.equal(live.status, 'rejected');
  assert.equal(live.pendingDecision, null);
});

test('approve on deleted leave type finalizes against the surviving balance', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  await createBalance(applicant, type);
  const request = await createRequest(applicant, type);
  await LeaveType.findByIdAndDelete(type._id);

  const staged = await processLeaveDecision(await freshRequest(request._id), actor, 'approve');
  assert.equal(staged.pendingDecision, 'approved');
  await finalizeStaged(staged);

  const live = await freshRequest(request._id);
  assert.equal(live.status, 'approved');
  assert.equal(live.pendingDecision, null);
  const balance = await LeaveBalance.findOne({ userId: applicant._id, leaveTypeId: type._id, year: 2026 });
  assert.equal(balance.used, 2);
});

test('reject on inactive leave type stages and finalizes', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  const request = await createRequest(applicant, type);
  await LeaveType.findByIdAndUpdate(type._id, { isActive: false });

  const staged = await processLeaveDecision(await freshRequest(request._id), actor, 'reject');
  assert.equal(staged.pendingDecision, 'rejected');
  await finalizeStaged(staged);

  const live = await freshRequest(request._id);
  assert.equal(live.status, 'rejected');
  assert.equal(live.pendingDecision, null);
});

test('approve with wiped balance but live policy regenerates quota and finalizes paid', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  await LeavePolicy.create({
    leaveTypeId: type._id,
    year: 2026,
    annualQuota: 12,
    accrualPerMonth: 0,
    paid: true,
    isActive: true,
  });
  const request = await createRequest(applicant, type);

  const staged = await processLeaveDecision(await freshRequest(request._id), actor, 'approve');
  assert.equal(staged.pendingDecision, 'approved');
  await finalizeStaged(staged);

  const live = await freshRequest(request._id);
  assert.equal(live.status, 'approved');
  assert.equal(live.pendingDecision, null);
  const balance = await LeaveBalance.findOne({ userId: applicant._id, leaveTypeId: type._id, year: 2026 });
  assert.equal(balance.entitled, 12);
  assert.equal(balance.used, 2);
  const lops = await LopRecord.find({ leaveRequestId: request._id });
  assert.equal(lops.length, 0);
});

test('approve with deleted type and no balance provisions a zero row and finalizes as unpaid', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  const request = await createRequest(applicant, type);
  const typeId = type._id;
  await LeaveType.findByIdAndDelete(typeId);

  const staged = await processLeaveDecision(await freshRequest(request._id), actor, 'approve');
  assert.equal(staged.pendingDecision, 'approved');
  await finalizeStaged(staged);

  const live = await freshRequest(request._id);
  assert.equal(live.status, 'approved');
  assert.equal(live.pendingDecision, null);
  const balance = await LeaveBalance.findOne({ userId: applicant._id, leaveTypeId: typeId, year: 2026 });
  assert.equal(balance.entitled, 0);
  assert.equal(balance.used, 2);
  // Zero quota → the approved days land as unpaid via the normal LOP path.
  const lops = await LopRecord.find({ leaveRequestId: request._id });
  assert.equal(lops.length, 1);
  assert.equal(lops[0].days, 2);
});

test('reject with missing balance row stages and finalizes', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  const request = await createRequest(applicant, type);

  const staged = await processLeaveDecision(await freshRequest(request._id), actor, 'reject');
  assert.equal(staged.pendingDecision, 'rejected');
  await finalizeStaged(staged);

  const live = await freshRequest(request._id);
  assert.equal(live.status, 'rejected');
  assert.equal(live.pendingDecision, null);
});

test('healthy decision still stages normally', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  await LeaveBalance.create({
    userId: applicant._id,
    leaveTypeId: type._id,
    year: 2026,
    entitled: 7,
    used: 0,
    pending: 0,
    carried: 0,
    encashed: 0,
  });
  const request = await createRequest(applicant, type);

  const result = await processLeaveDecision(await freshRequest(request._id), actor, 'approve');
  assert.equal(result.pendingDecision, 'approved');
  const live = await freshRequest(request._id);
  assert.equal(live.status, 'pending');
  assert.equal(live.pendingDecision, 'approved');
});

test('safety net: stuck row with null notifyAfter finalizes after undo expiry', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  await createBalance(applicant, type);
  const request = await createRequest(applicant, type);

  await processLeaveDecision(await freshRequest(request._id), actor, 'approved');

  const past = new Date(Date.now() - 60_000);
  await LeaveRequest.updateOne(
    { _id: request._id },
    { $set: { undoExpiresAt: past, notifyAfter: null, notificationsSent: false } },
  );

  const job = await runLeaveDecisionNotifyJob(new Date());
  assert.equal(job.processed, 1);

  const live = await freshRequest(request._id);
  assert.equal(live.status, 'approved');
  assert.equal(live.pendingDecision, null);
  assert.ok(live.finalizedAt);
});
