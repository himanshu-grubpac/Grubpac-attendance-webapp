/**
 * RM visibility parity (integration, real Mongo).
 *
 * Every team-scoped page (dashboard, employee list, attendance history,
 * today strip) must resolve the SAME membership for a reporting manager:
 * direct reports + delegate chain, never managed departments. Regression
 * test for the dashboard-38 vs list-20 split: a manager with 38 reports and
 * a 20-person managed department sees the same 38 people everywhere.
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

test('team scope equals leave-approval scope even with a managed department', async () => {
  const role = await createRole();
  const dept = new mongoose.Types.ObjectId();
  const mgr = await createUser('Mgr', {
    roleId: role._id,
    departmentId: dept,
    managedDepartmentIds: [dept],
  });
  // Direct report in another department.
  const direct = await createUser('Direct', {
    roleId: role._id,
    reportingManagerId: mgr._id,
    departmentId: new mongoose.Types.ObjectId(),
  });
  // Managed-department stranger who reports elsewhere.
  const stranger = await createUser('Stranger', {
    roleId: role._id,
    reportingManagerId: new mongoose.Types.ObjectId(),
    departmentId: dept,
  });
  // Delegated chain.
  const coveree = await createUser('Coveree', { roleId: role._id, delegateApproverId: mgr._id });
  const delegated = await createUser('Delegated', { roleId: role._id, reportingManagerId: coveree._id });

  const teamIds = await resolveTeamScopedUserIds(
    mgr,
    RM_PERMS,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  const approvalIds = await resolveLeaveApprovalUserIds(mgr);

  const sortIds = (ids) => ids.map(String).sort();
  assert.deepEqual(sortIds(teamIds), sortIds(approvalIds), 'team scope matches approval scope');
  assert.ok(sortIds(teamIds).includes(String(direct._id)), 'direct report visible');
  assert.ok(sortIds(teamIds).includes(String(delegated._id)), 'delegated report visible');
  assert.ok(!sortIds(teamIds).includes(String(stranger._id)), 'managed-department stranger hidden');
  assert.ok(!sortIds(teamIds).includes(String(coveree._id)), 'delegating manager is not a report');
  assert.ok(!sortIds(teamIds).includes(String(mgr._id)), 'manager does not see self');
});

test('employee-directory query narrows to the same membership', async () => {
  const role = await createRole();
  const dept = new mongoose.Types.ObjectId();
  const mgr = await createUser('MgrTwo', {
    roleId: role._id,
    departmentId: dept,
    managedDepartmentIds: [dept],
  });
  const direct = await createUser('DirectTwo', { roleId: role._id, reportingManagerId: mgr._id });
  await createUser('StrangerTwo', {
    roleId: role._id,
    reportingManagerId: new mongoose.Types.ObjectId(),
    departmentId: dept,
  });

  const query = await applyTeamScopeToEmployeeQuery(
    {},
    mgr,
    RM_PERMS,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  const found = await User.find(query).select('_id').lean();
  const ids = found.map((u) => String(u._id));
  assert.deepEqual(ids.sort(), [String(direct._id)].sort());
});
