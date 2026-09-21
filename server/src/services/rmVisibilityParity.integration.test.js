/**
 * RM team scope vs leave-approval scope (integration, real Mongo).
 *
 * Team-scoped admin surfaces (employee list, salary, attendance) use
 * resolveTeamScopedUserIds → direct reports + delegate chain + managed
 * departments + dept lead/deputy.
 *
 * Leave approval queues stay on resolveLeaveApprovalUserIds (reports +
 * delegate only). Managed-department members appear in team scope but not
 * in the approval queue unless they report to the manager.
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
import {
  applyTeamScopeToEmployeeQuery,
  resolveLeaveApprovalUserIds,
  resolveTeamScopedUserIds,
} from './teamScopeService.js';

const RM_PERMS = [PERMISSIONS.ATTENDANCE_READ_TEAM, PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_READ];

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([Role.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createRole() {
  sequence += 1;
  return Role.create({ name: `rm-${sequence}`, slug: `rm-${sequence}`, permissions: RM_PERMS });
}

async function createUser(name, fields = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `6${String(300000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    isActive: true,
    ...fields,
  });
}

test('team scope includes managed departments; leave approval does not', async () => {
  const role = await createRole();
  const dept = new mongoose.Types.ObjectId();
  const mgr = await createUser('Mgr', {
    roleId: role._id,
    departmentId: dept,
    managedDepartmentIds: [dept],
  });
  const direct = await createUser('Direct', {
    roleId: role._id,
    reportingManagerId: mgr._id,
    departmentId: new mongoose.Types.ObjectId(),
  });
  const stranger = await createUser('Stranger', {
    roleId: role._id,
    reportingManagerId: new mongoose.Types.ObjectId(),
    departmentId: dept,
  });
  const coveree = await createUser('Coveree', { roleId: role._id, delegateApproverId: mgr._id });
  const delegated = await createUser('Delegated', { roleId: role._id, reportingManagerId: coveree._id });

  const teamIds = await resolveTeamScopedUserIds(mgr, RM_PERMS);
  const approvalIds = await resolveLeaveApprovalUserIds(mgr);

  const sortIds = (ids) => ids.map(String).sort();
  assert.notDeepEqual(sortIds(teamIds), sortIds(approvalIds), 'team scope is wider than approval scope');

  assert.ok(sortIds(teamIds).includes(String(direct._id)), 'direct report in team scope');
  assert.ok(sortIds(teamIds).includes(String(delegated._id)), 'delegated report in team scope');
  assert.ok(sortIds(teamIds).includes(String(stranger._id)), 'managed-dept member in team scope');
  assert.ok(!sortIds(teamIds).includes(String(coveree._id)), 'delegating manager not in team scope');
  assert.ok(!sortIds(teamIds).includes(String(mgr._id)), 'manager does not see self');

  assert.ok(sortIds(approvalIds).includes(String(direct._id)), 'direct report in approval scope');
  assert.ok(sortIds(approvalIds).includes(String(delegated._id)), 'delegated report in approval scope');
  assert.ok(!sortIds(approvalIds).includes(String(stranger._id)), 'managed-dept stranger not in approval scope');
});

test('employee-directory query uses full team scope including managed department', async () => {
  const role = await createRole();
  const dept = new mongoose.Types.ObjectId();
  const mgr = await createUser('MgrTwo', {
    roleId: role._id,
    departmentId: dept,
    managedDepartmentIds: [dept],
  });
  const direct = await createUser('DirectTwo', { roleId: role._id, reportingManagerId: mgr._id });
  const stranger = await createUser('StrangerTwo', {
    roleId: role._id,
    reportingManagerId: new mongoose.Types.ObjectId(),
    departmentId: dept,
  });

  const query = await applyTeamScopeToEmployeeQuery({}, mgr, RM_PERMS);
  const found = await User.find(query).select('_id').lean();
  const ids = found.map((u) => String(u._id)).sort();

  assert.deepEqual(ids, [String(direct._id), String(stranger._id)].sort());
});
