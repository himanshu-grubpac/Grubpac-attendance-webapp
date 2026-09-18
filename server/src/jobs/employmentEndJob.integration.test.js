process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { runEmploymentEndJob } from './employmentEndJob.js';

let memoryServer;
let sequence = 0;
let roles = {};

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
    AuditLog.deleteMany({}),
    User.deleteMany({}),
    Role.deleteMany({}),
  ]);
  roles = {
    employee: await Role.create({ name: 'Employee', slug: 'employee', permissions: [] }),
    admin: await Role.create({ name: 'Admin', slug: 'admin', permissions: [] }),
  };
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser(name, fields = {}) {
  sequence += 1;
  return User.create({
    role: 'employee',
    roleId: roles.employee._id,
    firstName: name,
    lastName: 'Ended',
    name: `${name} Ended`,
    email: `${name.toLowerCase()}.${sequence}@test.example`,
    mobile: `9${String(200000000 + sequence)}`,
    passwordHash: 'hash',
    employeeCode: `END${String(100 + sequence)}`,
    isActive: true,
    ...fields,
  });
}

test('deactivates employees past their ending date with an audit row', async () => {
  const past = await createUser('Past', { endingDate: new Date('2026-08-01T00:00:00Z') });

  const result = await runEmploymentEndJob(new Date('2026-09-18T00:00:00Z'));

  assert.equal(result.processed, 1);
  assert.deepEqual(result.deactivatedIds, [past._id.toString()]);
  assert.equal((await User.findById(past._id).lean()).isActive, false);

  const audit = await AuditLog.findOne({ action: 'employee_auto_deactivated' }).lean();
  assert.ok(audit);
  assert.equal(String(audit.userId), past._id.toString());
  assert.equal(audit.reason, 'ending_date_passed');
});

test('leaves future, dateless and already-inactive employees alone', async () => {
  const future = await createUser('Future', { endingDate: new Date('2026-12-01T00:00:00Z') });
  const dateless = await createUser('Dateless', { endingDate: null });
  const inactive = await createUser('Inactive', {
    endingDate: new Date('2026-08-01T00:00:00Z'),
    isActive: false,
  });

  const result = await runEmploymentEndJob(new Date('2026-09-18T00:00:00Z'));

  assert.equal(result.processed, 0);
  assert.equal((await User.findById(future._id).lean()).isActive, true);
  assert.equal((await User.findById(dateless._id).lean()).isActive, true);
  assert.equal((await User.findById(inactive._id).lean()).isActive, false);
  assert.equal(await AuditLog.countDocuments({ action: 'employee_auto_deactivated' }), 0);
});

test('never deactivates admin-role holders and reports them', async () => {
  const admin = await createUser('Admin', {
    role: 'admin',
    roleId: roles.admin._id,
    endingDate: new Date('2026-08-01T00:00:00Z'),
  });

  const result = await runEmploymentEndJob(new Date('2026-09-18T00:00:00Z'));

  assert.equal(result.processed, 0);
  assert.equal(result.skippedAdmins, 1);
  assert.equal((await User.findById(admin._id).lean()).isActive, true);
});

test('second run is a no-op (idempotent)', async () => {
  await createUser('Past', { endingDate: new Date('2026-08-01T00:00:00Z') });

  const first = await runEmploymentEndJob(new Date('2026-09-18T00:00:00Z'));
  assert.equal(first.processed, 1);
  const second = await runEmploymentEndJob(new Date('2026-09-18T00:00:00Z'));
  assert.equal(second.processed, 0);
});
