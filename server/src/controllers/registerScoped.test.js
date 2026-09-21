/**
 * Reporting-manager scoped employee creation (integration, real Mongo).
 *
 * RMs without users.write may create Employee accounts only: always
 * reporting to themselves, department restricted to their managed
 * departments, privileged fields stripped. Non-RM writers are unaffected,
 * and the role catalog stays hidden except ?scope=creatable (id/name/slug
 * of Employee only — never the permission matrix).
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { registerEmployee } from './adminController.js';
import { listRoles } from './rolesController.js';

let memServer;
let sequence = 0;
let empRole;
let rmRole;
let deptManaged;
let deptOther;

const RM_PERMS = ['users.read', 'attendance.read_own', 'attendance.read_team'];

before(async () => {
  memServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memServer.waitUntilRunning();
  await mongoose.connect(memServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([Department.deleteMany({}), Role.deleteMany({}), User.deleteMany({})]);
  sequence += 1;
  empRole = await Role.create({ name: 'Employee', slug: 'employee', permissions: [] });
  rmRole = await Role.create({ name: 'RM', slug: 'reporting-manager', permissions: RM_PERMS });
  deptManaged = await Department.create({ name: 'Managed', code: `MNG${sequence}` });
  deptOther = await Department.create({ name: 'Other', code: `OTH${sequence}` });
});

after(async () => {
  await mongoose.disconnect();
  await memServer.stop();
});

async function createRm({ managedDepartmentIds = [deptManaged._id] } = {}) {
  sequence += 1;
  return User.create({
    firstName: 'Remy',
    lastName: 'Manager',
    name: 'Remy Manager',
    email: `rm.${sequence}@test.example`,
    mobile: `9${String(800000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId: rmRole._id,
    departmentId: deptManaged._id,
    managedDepartmentIds,
    isActive: true,
  });
}

// Production req.user is the full user document (findById + populate), so
// the department pre-check sees managed/own departments — mirror that here.
const actorAs = (userDoc, userPermissions) => ({
  _id: userDoc._id,
  roleId: { _id: rmRole._id, slug: 'reporting-manager' },
  departmentId: userDoc.departmentId ?? null,
  managedDepartmentIds: userDoc.managedDepartmentIds ?? [],
});

function validBody(overrides = {}) {
  sequence += 1;
  return {
    firstName: 'Newbie',
    lastName: 'Joiner',
    email: `newbie.${sequence}@test.example`,
    mobile: `9${String(700000000 + sequence)}`,
    password: 'Temp@1234',
    designation: 'Analyst',
    joiningDate: '2026-09-01',
    departmentId: deptManaged._id.toString(),
    // No roleId: scoped creators never assign roles — the server forces
    // Employee. (Explicit roleIds require the register-assign permission.)
    reportingManagerId: new mongoose.Types.ObjectId().toString(),
    ...overrides,
  };
}

const resStub = () => {
  const res = {
    statusCode: 200,
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (payload) => {
      res.body = payload;
      return res;
    },
  };
  return res;
};

test('RM creates an Employee in a managed department (201, reports to self)', async () => {
  const rm = await createRm();
  const res = resStub();
  await registerEmployee(
    { body: validBody(), user: actorAs(rm), userPermissions: RM_PERMS },
    res,
  );
  assert.equal(res.statusCode, 201);
  const created = await User.findOne({ email: res.body.employee.email }).lean();
  assert.ok(created, 'employee persisted');
  assert.equal(String(created.reportingManagerId), String(rm._id), 'reports to the RM');
  assert.equal(String(created.departmentId), String(deptManaged._id));
  assert.equal(String(created.roleId), String(empRole._id));
  assert.deepEqual(created.managedDepartmentIds ?? [], [], 'no team scope granted');
  assert.equal(created.delegateApproverId ?? null, null, 'no delegate granted');
});

test('RM cannot create outside managed departments', async () => {
  const rm = await createRm();
  const res = resStub();
  await registerEmployee(
    { body: validBody({ departmentId: deptOther._id.toString() }), user: actorAs(rm), userPermissions: RM_PERMS },
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body?.message ?? '', /selected department/);
});

test('RM cannot create non-Employee roles', async () => {
  const rm = await createRm();
  // Explicit role assignment needs the register-assign permission, which
  // scoped creators never hold — rejected before the scoped path runs.
  const res = resStub();
  await registerEmployee(
    { body: validBody({ roleId: rmRole._id.toString() }), user: actorAs(rm), userPermissions: RM_PERMS },
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body?.message ?? '', /assign roles/);
});

test('RM without managed departments cannot create', async () => {
  const rm = await createRm({ managedDepartmentIds: [] });
  const err = await registerEmployee(
    { body: validBody(), user: actorAs(rm), userPermissions: RM_PERMS },
    resStub(),
  ).then(() => null, (e) => e);
  assert.ok(err, 'rejected');
  assert.equal(err?.statusCode, 403);
  assert.match(err?.message ?? '', /No managed departments/);
});

test('non-RM without users.write cannot create', async () => {
  const rm = await createRm();
  const actor = { _id: rm._id, roleId: { _id: empRole._id, slug: 'employee' } };
  // No department: skips the department pre-check so the call reaches the
  // scoped creator, which rejects non-reporting-managers outright.
  const err = await registerEmployee(
    { body: validBody({ departmentId: undefined }), user: actor, userPermissions: ['users.read'] },
    resStub(),
  ).then(() => null, (e) => e);
  assert.ok(err, 'rejected');
  assert.equal(err?.statusCode, 403);
});

test('RM resolves only the Employee role via ?scope=creatable', async () => {
  const rm = await createRm();
  const res = resStub();
  await listRoles(
    { query: { scope: 'creatable' }, user: actorAs(rm), userPermissions: RM_PERMS },
    res,
  );
  assert.deepEqual(res.body.roles, [{ id: empRole._id.toString(), name: 'Employee', slug: 'employee' }]);
});

test('RM without scope param still gets 403 on the role catalog', async () => {
  const rm = await createRm();
  const res = resStub();
  await listRoles(
    { query: {}, user: actorAs(rm), userPermissions: RM_PERMS },
    res,
  );
  assert.equal(res.statusCode, 403);
});
