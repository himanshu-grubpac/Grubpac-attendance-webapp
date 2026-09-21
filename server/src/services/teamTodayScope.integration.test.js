/**
 * Team Attendance Today strip scope (integration, real Mongo).
 *
 * Product visibility rule for team viewers (READ_TEAM, no company-wide
 * scope): own reports (+delegate chain, all statuses) + fellow RMs
 * org-wide + the upline management chain. Never self; managed-department
 * strangers are directory-only (Employee List). Authority stays narrow
 * elsewhere: leave approvals/queues use the reports-only
 * resolveTeamScopedUserIds membership (see rmVisibilityParity). Full
 * admins (company-wide scope) still see everyone.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import '../models/Department.js';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { collectReportSubtreeIds, getTeamTodayStatusService } from './attendanceService.js';

let memoryServer;
let sequence = 0;

const RM_PERMS = [PERMISSIONS.ATTENDANCE_READ_TEAM];
const ADMIN_PERMS = [
  PERMISSIONS.ATTENDANCE_READ_ALL,
  PERMISSIONS.ATTENDANCE_READ_TEAM,
  PERMISSIONS.EMPLOYEES_RECORD_R,
];

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([Department.deleteMany({}), Role.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createRole(slug, permissions) {
  sequence += 1;
  return Role.create({ name: slug, slug: `${slug}-${sequence}`, permissions });
}

async function createUser(name, { roleId = null, reportingManagerId = null, departmentId = null, delegateApproverId = null, isActive = true, managedDepartmentIds = null } = {}) {
  sequence += 1;
  const created = await User.create({
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
  if (managedDepartmentIds !== null) {
    await User.findByIdAndUpdate(created._id, { managedDepartmentIds });
    return User.findById(created._id);
  }
  return created;
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

test('mid-level RM sees reports + upline; self and off-branch hidden', async () => {
  const { mid, boss, emp, subRm, subEmp, sibRm, sibEmp, otherBoss, otherEmp } = await setupTree();
  const rows = await getTeamTodayStatusService(mid, RM_PERMS);
  const seen = new Set(idsOf(rows));
  for (const u of [emp, subRm, boss]) {
    assert.ok(seen.has(String(u._id)), `visible: ${u.name}`);
  }
  for (const u of [mid, subEmp, sibRm, sibEmp, otherBoss, otherEmp]) {
    assert.ok(!seen.has(String(u._id)), `hidden: ${u.name}`);
  }
});

test('top boss sees direct reports, no self, indirect/other branch hidden', async () => {
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

test('managed scope adds the department on top of the full report roster', async () => {
  const rmRole = await createRole('rmdept', RM_PERMS);
  const empRole = await createRole('empdept', []);
  const deptA = new mongoose.Types.ObjectId();
  const deptB = new mongoose.Types.ObjectId();
  const mgr = await createUser('DeptMgr', {
    roleId: rmRole._id,
    departmentId: deptA,
    managedDepartmentIds: [deptA],
  });
  const same = await createUser('SameDept', { roleId: empRole._id, reportingManagerId: mgr._id, departmentId: deptA });
  const other = await createUser('OtherDept', { roleId: empRole._id, reportingManagerId: mgr._id, departmentId: deptB });
  const nostaff = await createUser('NoDept', { roleId: empRole._id, reportingManagerId: mgr._id });
  const rows = await getTeamTodayStatusService(mgr, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(same._id)), 'in-scope direct report visible');
  assert.ok(!seen.has(String(mgr._id)), 'self never listed');
  assert.ok(seen.has(String(other._id)), 'cross-department direct report stays visible');
  assert.ok(seen.has(String(nostaff._id)), 'null-department direct report stays visible');
});

test('RM without any department scope keeps all direct reports + self', async () => {
  const rmRole = await createRole('rmnoscope', RM_PERMS);
  const empRole = await createRole('empnoscope', []);
  const deptA = new mongoose.Types.ObjectId();
  const deptB = new mongoose.Types.ObjectId();
  const mgr = await createUser('NoScopeMgr', { roleId: rmRole._id });
  const same = await createUser('NoScopeSame', { roleId: empRole._id, reportingManagerId: mgr._id, departmentId: deptA });
  const other = await createUser('NoScopeOther', { roleId: empRole._id, reportingManagerId: mgr._id, departmentId: deptB });
  const rows = await getTeamTodayStatusService(mgr, RM_PERMS);
  const seen = new Set(idsOf(rows));
  for (const u of [same, other]) {
    assert.ok(seen.has(String(u._id)), `visible: ${u.name}`);
  }
  assert.ok(!seen.has(String(mgr._id)), 'self never listed');
});

test('delegated chains cross departments; managed strangers stay directory-only', async () => {
  const rmRole = await createRole('rmdel', RM_PERMS);
  const empRole = await createRole('empdel', []);
  const dept = new mongoose.Types.ObjectId();
  const otherDept = new mongoose.Types.ObjectId();
  const mgr = await createUser('CoverMgr', {
    roleId: rmRole._id,
    departmentId: dept,
    managedDepartmentIds: [dept],
  });
  const direct = await createUser('DirectRep', {
    roleId: empRole._id,
    reportingManagerId: mgr._id,
    departmentId: dept,
  });
  const coveree = await createUser('Coveree', {
    roleId: rmRole._id,
    delegateApproverId: mgr._id,
  });
  const delegatedIn = await createUser('DelegatedRep', {
    roleId: empRole._id,
    reportingManagerId: coveree._id,
    departmentId: dept,
  });
  const delegatedOut = await createUser('DelegatedOutRep', {
    roleId: empRole._id,
    reportingManagerId: coveree._id,
    departmentId: otherDept,
  });
  const stranger = await createUser('DeptStranger', {
    roleId: empRole._id,
    departmentId: dept,
    reportingManagerId: null,
  });
  const rows = await getTeamTodayStatusService(mgr, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(direct._id)), 'in-scope direct report visible');
  assert.ok(seen.has(String(delegatedIn._id)), 'in-scope delegated report visible');
  assert.ok(!seen.has(String(mgr._id)), 'self never listed');
  assert.ok(seen.has(String(delegatedOut._id)), 'delegated chain has no department constraint');
  assert.ok(!seen.has(String(stranger._id)), 'managed-department non-report stays directory-only');
  assert.ok(!seen.has(String(coveree._id)), 'delegating manager is not a report');
});

test('inactive ex-reports stay visible with an inactive status (directory parity)', async () => {
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
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.inactive, 1);
  const byId = new Map(result.teamStatus.map((m) => [String(m.userId), m]));
  assert.ok(byId.has(String(active._id)), 'active report visible');
  assert.ok(!byId.has(String(mgr._id)), 'self never listed');
  assert.ok(byId.has(String(offboarded._id)), 'inactive ex-report visible');
  assert.equal(byId.get(String(offboarded._id)).status, 'inactive');
});

test('company-wide Admin/HR still see everyone', async () => {
  const { boss, otherEmp } = await setupTree();
  const adminActor = { ...boss.toObject(), _id: boss._id, roleSlug: SYSTEM_ROLE_SLUGS.ADMIN };
  const rows = await getTeamTodayStatusService(adminActor, ADMIN_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(otherEmp._id)), 'admin sees other branch');
});

test('fellow RMs are visible org-wide; unrelated branches stay hidden', async () => {
  const rmRole = await Role.create({ name: 'RM', slug: 'reporting-manager', permissions: RM_PERMS });
  const empRole = await createRole('emp2', []);
  const viewer = await createUser('Viewer', { roleId: rmRole._id });
  const sibRm = await createUser('SibRm', { roleId: rmRole._id });
  const report = await createUser('Report', { roleId: empRole._id, reportingManagerId: viewer._id });
  const rows = await getTeamTodayStatusService(viewer, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(report._id)), 'direct report visible');
  assert.ok(!seen.has(String(viewer._id)), 'self never listed');
  assert.ok(seen.has(String(sibRm._id)), 'fellow RM visible');
});

test('team roster holds reports + fellow RMs, never self or managed strangers', async () => {
  const rmRole = await createRole('rmm', RM_PERMS);
  const empRole = await createRole('empm', []);
  const dept = new mongoose.Types.ObjectId();
  const otherDept = new mongoose.Types.ObjectId();
  const mgr = await createUser('Mgr', {
    roleId: rmRole._id,
    departmentId: dept,
    managedDepartmentIds: [dept],
  });
  const insiderReport = await createUser('InsiderReport', {
    roleId: empRole._id,
    departmentId: dept,
    reportingManagerId: mgr._id,
  });
  const outsiderReport = await createUser('OutsiderReport', {
    roleId: empRole._id,
    reportingManagerId: mgr._id,
  });
  const peerRm = await createUser('PeerRm', { roleId: rmRole._id, departmentId: dept });
  const peerRmOther = await createUser('PeerRmOther', { roleId: rmRole._id, departmentId: otherDept });
  const insider = await createUser('Insider', { roleId: empRole._id, departmentId: dept });
  const insiderOff = await createUser('InsiderOff', {
    roleId: empRole._id,
    departmentId: dept,
    isActive: false,
  });
  const rows = await getTeamTodayStatusService(mgr, RM_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(!seen.has(String(mgr._id)), 'self never listed');
  assert.ok(seen.has(String(insiderReport._id)), 'in-scope direct report visible');
  assert.ok(!seen.has(String(peerRm._id)), 'non-report without the RM role slug stays hidden');
  assert.ok(seen.has(String(outsiderReport._id)), 'cross-department direct report stays visible');
  assert.ok(!seen.has(String(peerRmOther._id)), 'out-of-scope same-role peer hidden');
  assert.ok(!seen.has(String(insider._id)), 'managed non-report stays directory-only');
  assert.ok(!seen.has(String(insiderOff._id)), 'inactive managed member stays directory-only');
});

test('paginated response carries scope facets limited to the membership', async () => {
  const rmRole = await createRole('rmfac', RM_PERMS);
  const empRole = await createRole('empfac', []);
  sequence += 1;
  const dept = await Department.create({ name: 'Development', code: `DEV${sequence}` });
  sequence += 1;
  const otherDept = await Department.create({ name: 'Design', code: `DSN${sequence}` });
  const mgr = await createUser('FacMgr', {
    roleId: rmRole._id,
    departmentId: dept._id,
    managedDepartmentIds: [dept._id],
  });
  await createUser('FacReport', {
    roleId: empRole._id,
    reportingManagerId: mgr._id,
    departmentId: dept._id,
  });
  await createUser('FacOutsider', {
    roleId: empRole._id,
    reportingManagerId: mgr._id,
    departmentId: otherDept._id,
  });
  const result = await getTeamTodayStatusService(mgr, RM_PERMS, { paginate: true, page: 1, limit: 25 });
  const facetDeptIds = (result.scopeFacets?.departments ?? []).map((d) => String(d.id));
  const facetRoleIds = (result.scopeFacets?.roles ?? []).map((r) => String(r.id));
  // The cross-department report is in the roster, so its department is
  // offered too — facets describe the whole membership, never the directory.
  // The viewer themself is never a member, so only the report role shows.
  assert.deepEqual(facetDeptIds.sort(), [String(dept._id), String(otherDept._id)].sort(), 'roster departments offered');
  assert.ok(!facetRoleIds.includes(String(rmRole._id)), 'viewer role not offered without members');
  assert.ok(facetRoleIds.includes(String(empRole._id)), 'report role offered');
  assert.equal(facetRoleIds.length, 1, 'no directory-wide roles leak');
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
