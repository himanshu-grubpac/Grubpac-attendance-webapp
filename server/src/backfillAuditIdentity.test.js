process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AuditLog } from './models/AuditLog.js';
import { User } from './models/User.js';
import { backfillAuditIdentity } from './backfillAuditIdentity.js';

let memoryServer;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([AuditLog.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser(overrides = {}) {
  return User.create({
    role: 'employee',
    firstName: 'Back',
    lastName: 'Fill',
    name: 'Back Fill',
    email: 'back.fill@example.com',
    mobile: '9876543219',
    passwordHash: 'hash',
    isActive: true,
    ...overrides,
  });
}

async function seedLegacyRows(user) {
  await AuditLog.create([
    // Missing both identity fields.
    { action: 'logout', userId: user._id, status: 'success', reason: 'n/a' },
    // Missing email only; explicit role must survive.
    { action: 'logout', userId: user._id, role: 'contractor', status: 'success', reason: 'n/a' },
    // Actor deleted after the fact — nothing to patch from.
    {
      action: 'logout',
      userId: new mongoose.Types.ObjectId(),
      status: 'success',
      reason: 'n/a',
    },
    // System action without any actor — never touched.
    { action: 'month_settled', status: 'success', reason: 'n/a' },
    // Already complete — never touched.
    {
      action: 'login_success',
      userId: user._id,
      email: 'back.fill@example.com',
      role: 'employee',
      status: 'success',
      reason: 'n/a',
    },
  ]);
}

test('dry-run reports projected patches without writing', async () => {
  const user = await createUser();
  await seedLegacyRows(user);

  const result = await backfillAuditIdentity({ dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.scanned, 3);
  assert.equal(result.emailPatched, 2);
  assert.equal(result.rolePatched, 1);
  assert.equal(result.modifiedCount, 0);
  assert.equal(result.operations, 2);

  const untouched = await AuditLog.findOne({ action: 'logout', role: 'contractor' }).lean();
  assert.equal(untouched.email, undefined);
});

test('live run patches only missing identity fields', async () => {
  const user = await createUser();
  await seedLegacyRows(user);

  const result = await backfillAuditIdentity({ dryRun: false });

  assert.equal(result.dryRun, false);
  assert.equal(result.modifiedCount, 2);

  const bothPatched = await AuditLog.findOne({
    action: 'logout',
    role: 'employee',
  }).lean();
  assert.equal(bothPatched.email, 'back.fill@example.com');

  // Explicitly stored role wins over the user's current role.
  const roleKept = await AuditLog.findOne({ role: 'contractor' }).lean();
  assert.equal(roleKept.email, 'back.fill@example.com');
  assert.equal(roleKept.role, 'contractor');

  // Deleted-user and system rows are left alone.
  assert.equal(result.skippedNoUser, 1);
  const systemRow = await AuditLog.findOne({ action: 'month_settled' }).lean();
  assert.equal(systemRow.email, undefined);
  assert.equal(systemRow.role, undefined);

  // Complete rows are never rewritten.
  const complete = await AuditLog.findOne({ action: 'login_success' }).lean();
  assert.equal(complete.email, 'back.fill@example.com');
  assert.equal(complete.role, 'employee');
});
