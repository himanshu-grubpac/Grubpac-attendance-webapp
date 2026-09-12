/**
 * Decision-time finalizability guard (integration, real Mongo).
 *
 * A staged decision that can never finalize (deleted/inactive leave type,
 * missing balance row) must fail loudly at decide time — never stage a
 * poison row that hangs as PENDING through every sweep forever.
 * - decision on deleted leave type → 409, request left untouched
 * - decision with missing balance row → 409, request left untouched
 * - healthy decision still stages normally
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { User } from '../models/User.js';
import { processLeaveDecision } from './leaveService.js';

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
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
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

test('decision on deleted leave type fails loudly without staging', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  const request = await createRequest(applicant, type);
  await LeaveType.findByIdAndDelete(type._id);

  await assert.rejects(
    processLeaveDecision(await freshRequest(request._id), actor, 'approve'),
    (err) => err.statusCode === 409,
    'expected 409 for deleted type',
  );
  const live = await freshRequest(request._id);
  assert.equal(live.status, 'pending');
  assert.equal(live.pendingDecision, null);
  assert.equal(live.notifyAfter, null);
});

test('decision with missing balance row fails loudly without staging', async () => {
  const actor = await createUser();
  const applicant = await createUser();
  const type = await createType();
  const request = await createRequest(applicant, type);

  await assert.rejects(
    processLeaveDecision(await freshRequest(request._id), actor, 'approve'),
    (err) => err.statusCode === 409,
    'expected 409 for missing balance',
  );
  const live = await freshRequest(request._id);
  assert.equal(live.status, 'pending');
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
