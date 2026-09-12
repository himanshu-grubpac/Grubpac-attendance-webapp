/**
 * Reporting-manager leave visibility lockdown (integration, real Mongo).
 *
 * An RM sees and acts on leave requests of employees under them and nobody
 * else: direct reports (+ delegate chain), never managed departments, and
 * explicit ?userId= / ?departmentId= filters must never widen the scope.
 * - team + approvals scopes contain only direct (+delegated) reports
 * - managed-department non-report is invisible even though the department
 *   is managed by the actor
 * - out-of-scope ?userId= → 403 (approvals, team, and mine scopes)
 * - team calendar ignores cross-scope ?departmentId=
 * - delegate sees + approves the absent manager's reports
 * - LEAVE_READ_ALL callers are unaffected
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import '../models/Department.js';
import { Department } from '../models/Department.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { canApproveLeave, getTeamCalendar, listLeaveRequests } from './leaveService.js';
import { resolveLeaveApprovalUserIds } from './teamScopeService.js';

let memoryServer;
let sequence = 0;

const RM_PERMS = [PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_READ_TEAM, PERMISSIONS.LEAVE_APPROVE];
const ADMIN_PERMS = [...RM_PERMS, PERMISSIONS.LEAVE_READ_ALL, PERMISSIONS.USERS_WRITE];

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
    Department.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createRole(slug, permissions) {
  sequence += 1;
  return Role.create({ name: slug, slug: `${slug}-${sequence}`, permissions });
}

async function createUser(name, { roleId = null, reportingManagerId = null, delegateApproverId = null, departmentId = null, managedDepartmentIds = [] } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `7${String(200000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId,
    reportingManagerId,
    delegateApproverId,
    departmentId,
    managedDepartmentIds,
  });
}

async function setup() {
  const rmRole = await createRole('rm', RM_PERMS);
  const empRole = await createRole('emp', [PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_APPLY]);
  const dept = await Department.create({ name: 'Engineering', code: 'ENG' });
  const leaveType = await LeaveType.create({ code: 'CL', name: 'Casual Leave' });

  // RM manages the whole department but only directly manages `report`.
  const rm = await createUser('Rm', { roleId: rmRole._id, managedDepartmentIds: [dept._id] });
  const report = await createUser('Report', {
    roleId: empRole._id,
    reportingManagerId: rm._id,
    departmentId: dept._id,
  });
  // Same managed department, but reports to nobody under rm.
  const deptOnly = await createUser('DeptOnly', { roleId: empRole._id, departmentId: dept._id });
  const outsider = await createUser('Outsider', { roleId: empRole._id });
  // Absent manager + delegate covering them.
  const absent = await createUser('Absent', { roleId: rmRole._id });
  const delegate = await createUser('Delegate', { roleId: rmRole._id });
  await User.findByIdAndUpdate(absent._id, { delegateApproverId: delegate._id });
  const delegatedReport = await createUser('DelegatedReport', {
    roleId: empRole._id,
    reportingManagerId: absent._id,
  });

  async function makeRequest(user, status = 'pending') {
    return LeaveRequest.create({
      userId: user._id,
      leaveTypeId: leaveType._id,
      startDate: new Date('2026-10-05T06:30:00.000Z'),
      endDate: new Date('2026-10-06T06:30:00.000Z'),
      days: 2,
      reason: 'Family function visit',
      status,
    });
  }

  await makeRequest(report, 'pending');
  await makeRequest(deptOnly, 'pending');
  await makeRequest(outsider, 'pending');
  await makeRequest(delegatedReport, 'pending');
  await makeRequest(report, 'approved');

  return { rm, report, deptOnly, outsider, absent, delegate, delegatedReport, dept };
}

const ids = (res) => (res.requests ?? []).map((r) => String(r.userId?._id ?? r.userId));

test('team scope shows direct reports only (managed-department non-report hidden)', async () => {
  const { rm, report, deptOnly, outsider } = await setup();
  const res = await listLeaveRequests(rm, RM_PERMS, {
    scope: 'team',
    status: 'all',
    page: 1,
    limit: 50,
  });
  const seen = ids(res);
  assert.ok(seen.includes(String(report._id)), 'direct report visible');
  assert.ok(!seen.includes(String(deptOnly._id)), 'managed-department non-report hidden');
  assert.ok(!seen.includes(String(outsider._id)), 'outsider hidden');
});

test('approvals scope shows direct reports only', async () => {
  const { rm, report, deptOnly } = await setup();
  const res = await listLeaveRequests(rm, RM_PERMS, {
    scope: 'approvals',
    status: 'pending',
    page: 1,
    limit: 50,
  });
  const seen = ids(res);
  assert.ok(seen.includes(String(report._id)), 'direct report pending visible');
  assert.ok(!seen.includes(String(deptOnly._id)), 'managed-department non-report hidden');
});

test('explicit userId cannot widen scope (403)', async () => {
  const { rm, outsider, report } = await setup();
  await assert.rejects(
    listLeaveRequests(rm, RM_PERMS, { scope: 'team', status: 'all', page: 1, limit: 50, userId: String(outsider._id) }),
    (err) => err.statusCode === 403,
    'cross-team userId rejected',
  );
  await assert.rejects(
    listLeaveRequests(rm, RM_PERMS, { scope: 'approvals', status: 'pending', page: 1, limit: 50, userId: String(outsider._id) }),
    (err) => err.statusCode === 403,
    'cross-team userId rejected in approvals',
  );
  const ok = await listLeaveRequests(rm, RM_PERMS, {
    scope: 'team',
    status: 'all',
    page: 1,
    limit: 50,
    userId: String(report._id),
  });
  assert.ok(ids(ok).every((id) => id === String(report._id)), 'in-scope userId filter works');
});

test('mine scope userId must equal self', async () => {
  const { rm, outsider } = await setup();
  await assert.rejects(
    listLeaveRequests(rm, RM_PERMS, { scope: 'mine', status: 'all', page: 1, limit: 50, userId: String(outsider._id) }),
    (err) => err.statusCode === 403,
    'mine scope cannot read others',
  );
});

test('team calendar departmentId cannot widen scope', async () => {
  const { rm, report, deptOnly, dept } = await setup();
  const res = await getTeamCalendar(rm, RM_PERMS, { month: '2026-10', departmentId: String(dept._id) });
  const seen = (res.entries ?? []).map((r) => String(r.userId?._id ?? r.userId));
  const listedUsers = (res.users ?? []).map((u) => String(u.id));
  assert.ok(!seen.includes(String(deptOnly._id)), 'department filter does not leak non-reports');
  assert.ok(!listedUsers.includes(String(deptOnly._id)), 'user roster excludes non-reports');
  assert.ok(seen.includes(String(report._id)) || listedUsers.includes(String(report._id)), 'direct report visible');
});

test('delegate sees and approves absent manager reports', async () => {
  const { delegate, delegatedReport } = await setup();
  const scoped = await resolveLeaveApprovalUserIds(delegate);
  assert.ok(
    scoped.map(String).includes(String(delegatedReport._id)),
    'delegated reports in scope',
  );
  const res = await listLeaveRequests(delegate, RM_PERMS, {
    scope: 'approvals',
    status: 'pending',
    page: 1,
    limit: 50,
  });
  assert.ok(ids(res).includes(String(delegatedReport._id)), 'delegate sees delegated pending');
  const requester = await User.findById(delegatedReport._id).populate(
    'reportingManagerId',
    'delegateApproverId',
  );
  assert.equal(canApproveLeave(delegate, requester, RM_PERMS), true, 'delegate can approve');
});

test('READ_ALL callers unaffected', async () => {
  const { rm, outsider } = await setup();
  const res = await listLeaveRequests(rm, ADMIN_PERMS, {
    scope: 'team',
    status: 'all',
    page: 1,
    limit: 50,
    userId: String(outsider._id),
  });
  assert.ok(ids(res).includes(String(outsider._id)), 'read-all still unscoped');
});
