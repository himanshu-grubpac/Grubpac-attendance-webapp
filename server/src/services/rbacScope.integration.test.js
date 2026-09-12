/**
 * RBAC scope regression tests (integration, real Mongo).
 *
 * - GET /lop-records/:userId: self always allowed; READ_ALL/ADJUST bypass;
 *   otherwise confined to direct reports (+ delegate chain), else 403.
 * - createLopOnApproval: comp-off credit counts as paid stock — CO-covered
 *   leave mints no phantom LOP records.
 * - GET /admin/users/managers: admin/HR see all managers; others see only
 *   their own chain.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeaveType } from '../models/LeaveType.js';
import { LopRecord } from '../models/LopRecord.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { getLopRecordsHandler } from '../controllers/leaveController.js';
import { listManagers } from '../controllers/adminController.js';
import { createLopOnApproval } from './lopSettlementService.js';

let memoryServer;
let sequence = 0;

const RM_PERMS = [PERMISSIONS.USERS_READ, PERMISSIONS.LEAVE_READ, PERMISSIONS.ATTENDANCE_READ_TEAM];
const ADMIN_PERMS = [...RM_PERMS, PERMISSIONS.LEAVE_READ_ALL, PERMISSIONS.LEAVE_ADJUST_BALANCES];

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    LeaveBalance.deleteMany({}),
    LeaveType.deleteMany({}),
    LopRecord.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createRole(slug) {
  sequence += 1;
  return Role.create({ name: slug, slug: `${slug}-${sequence}`, permissions: [] });
}

async function createUser(name, { roleId = null, reportingManagerId = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `8${String(300000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId,
    reportingManagerId,
    isActive: true,
  });
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.body = data;
    return res;
  };
  return res;
}

function actorAs(user, roleSlug) {
  return {
    ...user.toObject(),
    _id: user._id,
    roleId: { _id: user.roleId, slug: roleSlug },
  };
}

// ── LOP records ──────────────────────────────────────────────────────────

async function seedLopTree() {
  const rmRole = await createRole('rm');
  const admin = await createUser('LopAdmin');
  const manager = await createUser('LopMgr', { roleId: rmRole._id });
  const report = await createUser('LopRep', { reportingManagerId: manager._id });
  const outsider = await createUser('LopOut');
  const leaveType = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
  await LopRecord.create({
    userId: outsider._id,
    leaveTypeId: leaveType._id,
    leaveRequestId: new mongoose.Types.ObjectId(),
    leaveDate: new Date(),
    periodKey: '2026-09',
    days: 1,
    year: 2026,
  });
  return { admin, manager, report, outsider };
}

test('LOP records: self read allowed', async () => {
  const { outsider } = await seedLopTree();
  const req = {
    params: { userId: outsider._id.toString() },
    query: {},
    user: actorAs(outsider, 'employee'),
    userPermissions: [PERMISSIONS.LEAVE_READ],
  };
  const res = mockRes();
  await getLopRecordsHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.records.length, 1);
});

test('LOP records: manager reads report, blocked on outsider', async () => {
  const { manager, report, outsider } = await seedLopTree();
  const actor = actorAs(manager, 'reporting-manager');

  const okRes = mockRes();
  await getLopRecordsHandler(
    { params: { userId: report._id.toString() }, query: {}, user: actor, userPermissions: RM_PERMS },
    okRes,
  );
  assert.equal(okRes.statusCode, 200);

  const deniedRes = mockRes();
  await getLopRecordsHandler(
    { params: { userId: outsider._id.toString() }, query: {}, user: actor, userPermissions: RM_PERMS },
    deniedRes,
  );
  assert.equal(deniedRes.statusCode, 403);
});

test('LOP records: READ_ALL bypasses scope', async () => {
  const { manager, outsider } = await seedLopTree();
  const res = mockRes();
  await getLopRecordsHandler(
    {
      params: { userId: outsider._id.toString() },
      query: {},
      user: actorAs(manager, 'reporting-manager'),
      userPermissions: ADMIN_PERMS,
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.records.length, 1);
});

// ── comp-off credit in LOP math ──────────────────────────────────────────

test('createLopOnApproval: comp-off-covered leave creates no LOP record', async () => {
  const user = await createUser('CoEarner');
  const coType = await LeaveType.create({ code: 'CO', name: 'Comp Off', isActive: true });
  const year = 2026;
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: coType._id,
    year,
    entitled: 0,
    used: 1,
    pending: 0,
    carried: 0,
    compOffEarned: 2,
    encashed: 0,
  });
  const result = await createLopOnApproval(
    user._id,
    coType._id,
    new mongoose.Types.ObjectId(),
    new Date('2026-09-10T00:00:00Z'),
    1,
  );
  assert.equal(result, null, 'no LOP when comp-off credit covers the leave');
  assert.equal(await LopRecord.countDocuments({ userId: user._id }), 0);
});

test('createLopOnApproval: genuinely overdrawn leave still creates LOP', async () => {
  const user = await createUser('CoBroke');
  const coType = await LeaveType.create({ code: 'CO', name: 'Comp Off', isActive: true });
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: coType._id,
    year: 2026,
    entitled: 0,
    used: 3,
    pending: 0,
    carried: 0,
    compOffEarned: 1,
    encashed: 0,
  });
  const result = await createLopOnApproval(
    user._id,
    coType._id,
    new mongoose.Types.ObjectId(),
    new Date('2026-09-10T00:00:00Z'),
    1,
  );
  assert.ok(result, 'LOP record created for the uncovered portion');
  assert.equal(result.days, 1);
});

// ── manager picker scope ─────────────────────────────────────────────────

async function seedManagerTree() {
  // Exact system slugs: listManagers queries Role by slug, so suffixed
  // slugs would match nothing. beforeEach wipes Role, so no collisions.
  const adminRole = await Role.create({ name: 'Admin', slug: 'admin', permissions: [] });
  const hrRole = await Role.create({ name: 'HR', slug: 'hr', permissions: [] });
  const rmRole = await Role.create({ name: 'RM', slug: 'reporting-manager', permissions: [] });
  const admin = await createUser('PickAdmin', { roleId: adminRole._id });
  const hr = await createUser('PickHr', { roleId: hrRole._id });
  const rmA = await createUser('PickRmA', { roleId: rmRole._id, reportingManagerId: admin._id });
  const rmB = await createUser('PickRmB', { roleId: rmRole._id });
  await createUser('PickEmp', { reportingManagerId: rmA._id });
  return { admin, hr, rmA, rmB };
}

test('listManagers: admin and HR see all managers', async () => {
  const { admin, hr } = await seedManagerTree();
  for (const [user, slug] of [[admin, 'admin'], [hr, 'hr']]) {
    const res = mockRes();
    await listManagers({ query: {}, user: actorAs(user, slug), userPermissions: [] }, res);
    const names = res.body.managers.map((m) => m.name);
    assert.ok(names.some((n) => n.includes('PickRmA')), `${slug} sees rmA`);
    assert.ok(names.some((n) => n.includes('PickRmB')), `${slug} sees rmB`);
  }
});

test('listManagers: RM sees own chain only', async () => {
  const { rmA } = await seedManagerTree();
  const res = mockRes();
  await listManagers(
    { query: {}, user: actorAs(rmA, 'reporting-manager'), userPermissions: RM_PERMS },
    res,
  );
  const names = res.body.managers.map((m) => m.name);
  assert.ok(names.some((n) => n.includes('PickRmA')), 'sees self');
  assert.ok(names.some((n) => n.includes('PickAdmin')), 'sees manager above');
  assert.ok(!names.some((n) => n.includes('PickRmB')), 'peer branch hidden');
  assert.ok(!names.some((n) => n.includes('PickHr')), 'HR hidden from RM picker');
});
