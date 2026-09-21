/**
 * Dynamic roles & permissions (integration, real Mongo).
 *
 * Every role — system or custom — is editable except the Admin system role,
 * which keeps its permissions locked (superadmin lockout protection):
 * - PATCH reporting-manager with new permissions → 200, persisted
 * - PATCH admin with permissions → 403, untouched
 * - PATCH admin name only → 200 (display fields stay editable)
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { ADMIN_LOCK_SLUGS, PERMISSIONS } from '../../../shared/permissions.js';
import { Role } from '../models/Role.js';
import { updateRole } from './rolesController.js';

let memoryServer;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Role.deleteMany({});
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function seedRoles() {
  const admin = await Role.create({
    name: 'Admin',
    slug: 'admin',
    isSystem: true,
    permissions: [...Object.values(PERMISSIONS)],
  });
  const rm = await Role.create({
    name: 'Reporting Manager',
    slug: 'reporting-manager',
    isSystem: true,
    permissions: [PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_APPROVE],
  });
  return { admin, rm };
}

test('reporting-manager permissions update applies immediately', async () => {
  const { rm } = await seedRoles();
  const res = mockRes();
  await updateRole(
    {
      params: { id: rm._id.toString() },
      body: {
        name: 'Reporting Manager',
        description: 'desc',
        permissions: [PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_APPLY],
      },
      user: { _id: new mongoose.Types.ObjectId() },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.role.permissions.includes(PERMISSIONS.LEAVE_APPLY));
  const reloaded = await Role.findById(rm._id).lean();
  assert.ok(reloaded.permissions.includes(PERMISSIONS.LEAVE_APPLY), 'persisted to DB');
});

test('admin role keeps lockout-protection slugs on permission edits (merged, not stripped)', async () => {
  const { admin } = await seedRoles();
  const res = mockRes();
  await updateRole(
    {
      params: { id: admin._id.toString() },
      body: { name: 'Admin', permissions: [PERMISSIONS.LEAVE_READ] },
      user: { _id: new mongoose.Types.ObjectId() },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  const reloaded = await Role.findById(admin._id).lean();
  // Requested slug applied, lockout-protection slugs force-retained.
  assert.ok(reloaded.permissions.includes(PERMISSIONS.LEAVE_READ));
  for (const slug of ADMIN_LOCK_SLUGS) {
    assert.ok(reloaded.permissions.includes(slug), `lock slug retained: ${slug}`);
  }
});

test('admin display name stays editable', async () => {
  const { admin } = await seedRoles();
  const res = mockRes();
  await updateRole(
    {
      params: { id: admin._id.toString() },
      body: { name: 'Head Admin' },
      user: { _id: new mongoose.Types.ObjectId() },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role.name, 'Head Admin');
});

test('cannot remove permissions from own role (self-lockout guard)', async () => {
  const { rm } = await seedRoles();
  const selfId = new mongoose.Types.ObjectId();
  const res = mockRes();
  await updateRole(
    {
      params: { id: rm._id.toString() },
      body: { name: 'Reporting Manager', permissions: [PERMISSIONS.LEAVE_READ] },
      user: { _id: selfId, roleId: rm._id },
    },
    res,
  );
  assert.equal(res.statusCode, 403);
  const reloaded = await Role.findById(rm._id).lean();
  assert.ok(reloaded.permissions.includes(PERMISSIONS.LEAVE_APPROVE), 'untouched');
});

test('adding permissions to own role is allowed', async () => {
  const { rm } = await seedRoles();
  const selfId = new mongoose.Types.ObjectId();
  const res = mockRes();
  await updateRole(
    {
      params: { id: rm._id.toString() },
      body: {
        name: 'Reporting Manager',
        permissions: [PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_APPLY],
      },
      user: { _id: selfId, roleId: rm._id },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.role.permissions.includes(PERMISSIONS.LEAVE_APPLY));
});

test('removing permissions from another role is allowed', async () => {
  const { rm } = await seedRoles();
  const otherId = new mongoose.Types.ObjectId();
  const res = mockRes();
  await updateRole(
    {
      params: { id: rm._id.toString() },
      body: { name: 'Reporting Manager', permissions: [PERMISSIONS.LEAVE_READ] },
      user: { _id: otherId, roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.role.permissions.includes(PERMISSIONS.LEAVE_APPROVE));
});
