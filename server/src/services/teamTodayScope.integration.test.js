/**
 * Team Attendance Today strip scope (integration, real Mongo).
 *
 * Canonical membership contract lives in rmVisibilityParity.integration.test.js
 * (direct reports + delegate chain, never managed departments); the tests
 * here lock strip-level details on top of it. Full admins (READ_ALL) still
 * see everyone.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { collectReportSubtreeIds, getTeamTodayStatusService } from './attendanceService.js';

let memoryServer;
let sequence = 0;

const RM_PERMS = [PERMISSIONS.ATTENDANCE_READ_TEAM];
const ADMIN_PERMS = [PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM];

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([Role.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createRole(slug, permissions) {
  sequence += 1;
  return Role.create({ name: slug, slug: `${slug}-${sequence}`, permissions });
}

async function createUser(name, { roleId = null, reportingManagerId = null, departmentId = null, delegateApproverId = null, isActive = true } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `6${String(300000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId,
    reportingManagerId,
    departmentId,
    delegateApproverId,
    isActive,
  });
}

//   boss
//   ├── mid (actor) ── emp, subRm ── subEmp
//   └── sibRm ── sibEmp
//   otherBoss ── otherEmp   (unrelated branch)
async function setupTree() {
  const rmRole = await createRole('rm', RM_PERMS);
  const empRole = await createRole('emp', []);
  const boss = await createUser('Boss', { roleId: rmRole._id });
  const mid = await createUser('Mid', { roleId: rmRole._id, reportingManagerId: boss._id });
  const emp = await createUser('Emp', { roleId: empRole._id, reportingManagerId: mid._id });
  const subRm = await createUser('SubRm', { roleId: rmRole._id, reportingManagerId: mid._id });
  const subEmp = await createUser('SubEmp', { roleId: empRole._id, reportingManagerId: subRm._id });
  const sibRm = await createUser('SibRm', { roleId: rmRole._id, reportingManagerId: boss._id });
  const sibEmp = await createUser('SibEmp', { roleId: empRole._id, reportingManagerId: sibRm._id });
  const otherBoss = await createUser('OtherBoss', { roleId: rmRole._id });
  const otherEmp = await createUser('OtherEmp', { roleId: empRole._id, reportingManagerId: otherBoss._id });
  return { boss, mid, emp, subRm, subEmp, sibRm, sibEmp, otherBoss, otherEmp };
}

const idsOf = (rows) => rows.map((m) => String(m.userId));

test('mid-level RM sees direct reports only, siblings/boss/indirect hidden', async () => {
  const { mid, boss, emp, subRm, subEmp, sibRm, sibEmp, otherBoss, otherEmp } = await setupTree();
  const rows = await getTeamTodayStatusService(mid, RM_PERMS);
  const seen = new Set(idsOf(rows));
  for (const u of [emp, subRm]) {
    assert.ok(seen.has(String(u._id)), `visible: ${u.name}`);
  }
  for (const u of [mid, boss, subEmp, sibRm, sibEmp, otherBoss, otherEmp]) {
    assert.ok(!seen.has(String(u._id)), `hidden: ${u.name}`);
  }
});

test('top boss sees direct reports only, indirect/other branch hidden', async () => {
  const { boss, mid, emp, subRm, subEmp, sibRm, sibEmp, otherBoss, otherEmp } = await setupTree();
  const rows = await getTeamTodayStatusService(boss, RM_PERMS);
  const seen = new Set(idsOf(rows));
  for (const u of [mid, sibRm]) {
    assert.ok(seen.has(String(u._id)), `visible: ${u.name}`);
  }
  for (const u of [boss, emp, subRm, subEmp, sibEmp, otherBoss, otherEmp]) {
    assert.ok(!seen.has(String(u._id)), `hidden: ${u.name}`);
  }
});

test('RM sees all direct reports regardless of department', async () => {
  const rmRole = await createRole('rmdept', RM_PERMS);
  const empRole = await createRole('empdept', []);
  const deptA = new mongoose.Types.ObjectId();
  const deptB = new mongoose.Types.ObjectId();
  const mgr = await createUser('DeptMgr', { roleId: rmRole._id, departmentId: deptA });
  const same = await createUser('SameDept', { roleId: empRole._id, reportingManagerId: mgr._id, departmentId: deptA });
  const other = await createUser('OtherDept', { roleId: empRole._id, reportingManagerId: mgr._id, departmentId: deptB });
  const nostaff = await createUser('NoDept', { roleId: empRole._id, reportingManagerId: mgr._id });
  const rows = await getTeamTodayStatusService(mgr, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(same._id)), 'same department visible');
  assert.ok(seen.has(String(other._id)), 'cross-department direct report visible');
  assert.ok(seen.has(String(nostaff._id)), 'null-department direct report visible');
});

test('RM sees delegated reports but not managed-department strangers', async () => {
  const rmRole = await createRole('rmdel', RM_PERMS);
  const empRole = await createRole('empdel', []);
  const dept = new mongoose.Types.ObjectId();
  const mgr = await createUser('CoverMgr', { roleId: rmRole._id });
  const direct = await createUser('DirectRep', { roleId: empRole._id, reportingManagerId: mgr._id });
  const coveree = await createUser('Coveree', {
    roleId: rmRole._id,
    delegateApproverId: mgr._id,
  });
  const delegated = await createUser('DelegatedRep', { roleId: empRole._id, reportingManagerId: coveree._id });
  const stranger = await createUser('DeptStranger', {
    roleId: empRole._id,
    departmentId: dept,
    reportingManagerId: null,
  });
  // Managed departments no longer widen visibility: the stranger shares the
  // manager's own department yet stays hidden.
  await User.findByIdAndUpdate(mgr._id, { departmentId: dept, managedDepartmentIds: [dept] });
  const rows = await getTeamTodayStatusService(mgr, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(direct._id)), 'direct report visible');
  assert.ok(seen.has(String(delegated._id)), 'delegated report visible');
  assert.ok(!seen.has(String(stranger._id)), 'managed-department stranger hidden');
  assert.ok(!seen.has(String(coveree._id)), 'delegating manager is not a report');
});

test('inactive ex-reports are hidden from RMs', async () => {
  const rmRole = await createRole('rmoff', RM_PERMS);
  const empRole = await createRole('empoff', []);
  const mgr = await createUser('OffMgr', { roleId: rmRole._id });
  const active = await createUser('ActiveRep', { roleId: empRole._id, reportingManagerId: mgr._id });
  const offboarded = await createUser('OffboardedRep', {
    roleId: empRole._id,
    reportingManagerId: mgr._id,
    isActive: false,
  });
  const result = await getTeamTodayStatusService(mgr, RM_PERMS, { paginate: true, page: 1, limit: 25 });
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.inactive, 0);
  const seen = new Set(result.teamStatus.map((m) => String(m.userId)));
  assert.ok(seen.has(String(active._id)), 'active report visible');
  assert.ok(!seen.has(String(offboarded._id)), 'inactive ex-report hidden');
});

test('read-all admins still see everyone', async () => {
  const { boss, otherEmp } = await setupTree();
  const rows = await getTeamTodayStatusService(boss, ADMIN_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(otherEmp._id)), 'admin sees other branch');
});

test('sibling RMs with the real reporting-manager slug stay hidden', async () => {
  const rmRole = await Role.create({ name: 'RM', slug: 'reporting-manager', permissions: RM_PERMS });
  const empRole = await createRole('emp2', []);
  const viewer = await createUser('Viewer', { roleId: rmRole._id });
  const sibRm = await createUser('SibRm', { roleId: rmRole._id });
  const report = await createUser('Report', { roleId: empRole._id, reportingManagerId: viewer._id });
  const rows = await getTeamTodayStatusService(viewer, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(report._id)), 'direct report visible');
  assert.ok(!seen.has(String(sibRm._id)), 'sibling RM hidden');
  assert.ok(!seen.has(String(viewer._id)), 'self hidden');
});

test('managed departments do not widen the strip; only direct reports show', async () => {
  const rmRole = await createRole('rmm', RM_PERMS);
  const empRole = await createRole('empm', []);
  const dept = new mongoose.Types.ObjectId();
  const mgr = await createUser('Mgr', { roleId: rmRole._id, departmentId: dept });
  await User.findByIdAndUpdate(mgr._id, { managedDepartmentIds: [dept] });
  const insider = await createUser('Insider', { roleId: empRole._id, departmentId: dept });
  const insiderOff = await createUser('InsiderOff', {
    roleId: empRole._id,
    departmentId: dept,
    isActive: false,
  });
  const outsider = await createUser('Outsider', { roleId: empRole._id, reportingManagerId: mgr._id });
  const rows = await getTeamTodayStatusService(mgr, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(!seen.has(String(mgr._id)), 'self hidden');
  assert.ok(!seen.has(String(insider._id)), 'dept non-report hidden');
  assert.ok(!seen.has(String(insiderOff._id)), 'inactive dept non-report hidden');
  assert.ok(seen.has(String(outsider._id)), 'direct report visible regardless of department');
});

test('collectReportSubtreeIds terminates on reporting cycles', async () => {
  const rmRole = await createRole('rmc', RM_PERMS);
  const empRole = await createRole('empc', []);
  const a = await createUser('CycleA', { roleId: rmRole._id });
  const b = await createUser('CycleB', { roleId: empRole._id, reportingManagerId: a._id });
  await User.findByIdAndUpdate(a._id, { reportingManagerId: b._id });
  const ids = await collectReportSubtreeIds([a._id]);
  assert.deepEqual(
    ids.map(String).sort(),
    [String(b._id)].sort(),
    'cycle terminates (root excluded by design, no infinite loop)',
  );
});
