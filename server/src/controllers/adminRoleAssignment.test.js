/**
 * Admin-role assignment guard (integration, real Mongo).
 *
 * Only role administrators — holders of the Admin role slug or the
 * roles.manage permission — may grant the Admin system role via single
 * register (updateEmployee shares the same guard). Everyone else gets a 403
 * before any validation runs; non-Admin assignments always pass the guard.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Role } from '../models/Role.js';
import { registerEmployee } from './adminController.js';

let memServer;
let adminRole;
let empRole;
let rmRole;

before(async () => {
  memServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memServer.waitUntilRunning();
  await mongoose.connect(memServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Role.deleteMany({});
  adminRole = await Role.create({ name: 'Admin', slug: 'admin', permissions: [] });
  empRole = await Role.create({ name: 'Employee', slug: 'employee', permissions: [] });
  rmRole = await Role.create({ name: 'RM', slug: 'reporting-manager', permissions: ['users.write'] });
});

after(async () => {
  await mongoose.disconnect();
  await memServer.stop();
});

const reqFor = (actorRoleId, userPermissions, roleId) => ({
  body: { roleId },
  user: { _id: new mongoose.Types.ObjectId(), roleId: actorRoleId },
  userPermissions,
});

const resStub = () => {
  const res = {
    statusCode: 200,
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: () => res,
  };
  return res;
};

const guardError = (err) => err?.statusCode === 403
  && err?.message === 'Only admins can assign the Admin role.';

test('RM without roles.manage cannot grant the Admin role', async () => {
  await assert.rejects(
    registerEmployee(reqFor(rmRole._id, ['users.write'], adminRole._id), resStub()),
    guardError,
    'guard blocks with 403',
  );
});

test('RM can still assign non-Admin roles (guard passes, validation decides)', async () => {
  const err = await registerEmployee(
    reqFor(rmRole._id, ['users.write'], empRole._id),
    resStub(),
  ).then(() => null, (e) => e);
  assert.ok(err, 'bare body still fails downstream validation');
  assert.ok(!guardError(err), 'guard passes; only downstream validation rejects');
});

test('admin holder can grant the Admin role (guard passes)', async () => {
  const err = await registerEmployee(
    reqFor(adminRole._id, ['users.write'], adminRole._id),
    resStub(),
  ).then(() => null, (e) => e);
  assert.ok(err, 'bare body still fails downstream validation');
  assert.ok(!guardError(err), 'guard passes; only downstream validation rejects');
});

test('roles.manage holder without the Admin slug can grant the Admin role', async () => {
  const err = await registerEmployee(
    reqFor(rmRole._id, ['users.write', 'roles.manage'], adminRole._id),
    resStub(),
  ).then(() => null, (e) => e);
  assert.ok(err, 'bare body still fails downstream validation');
  assert.ok(!guardError(err), 'roles.manage bypasses the guard like the UI option');
});
