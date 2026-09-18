/**
 * RBAC catalog scope — HR company-wide vs RM team-bounded salary access.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS, buildDefaultRolePermissions } from '../../../shared/permissions.js';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { canViewSalarySummary } from './salaryService.js';
import { isUserInTeamScope } from './teamScopeService.js';

let memoryServer;
let sequence = 0;

const DEFAULTS = buildDefaultRolePermissions();

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([Department.deleteMany({}), Role.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function seedUser(name, fields = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Scope',
    name: `${name} Scope`,
    email: `${name.toLowerCase()}.${sequence}@rbac.test`,
    mobile: `9${String(100000000 + sequence).slice(-9)}`,
    passwordHash: 'hash',
    role: 'employee',
    isActive: true,
    monthlySalary: 50000,
    ...fields,
  });
}

test('HR with employees.record.r has company-wide salary scope', async () => {
  const hr = await seedUser('HR', { role: 'admin' });
  const employee = await seedUser('Emp');
  const hrPerms = DEFAULTS.hr;

  assert.equal(await canViewSalarySummary(hr, employee, hrPerms), true);
  assert.equal(await isUserInTeamScope(hr, hrPerms, employee._id), true);
});

test('RM with salary.team_audit.r sees team only, not company-wide', async () => {
  const dept = await Department.create({ name: 'Eng', code: `E${sequence}`, isActive: true });
  const rm = await seedUser('RM', { role: 'admin', managedDepartmentIds: [dept._id] });
  const inTeam = await seedUser('InTeam', { departmentId: dept._id, reportingManagerId: rm._id });
  const outsider = await seedUser('Outsider');
  const rmPerms = DEFAULTS['reporting-manager'];

  assert.ok(rmPerms.includes(PERMISSIONS.SALARY_TEAM_AUDIT_R));
  assert.ok(!rmPerms.includes(PERMISSIONS.EMPLOYEES_RECORD_R));

  assert.equal(await canViewSalarySummary(rm, inTeam, rmPerms), true);
  assert.equal(await canViewSalarySummary(rm, outsider, rmPerms), false);
  assert.equal(await isUserInTeamScope(rm, rmPerms, inTeam._id), true);
  assert.equal(await isUserInTeamScope(rm, rmPerms, outsider._id), false);
});

test('Employee self pay uses emp.pay.r only for own record', async () => {
  const emp = await seedUser('Self');
  const other = await seedUser('Other');
  const empPerms = DEFAULTS.employee;

  assert.equal(await canViewSalarySummary(emp, emp, empPerms), true);
  assert.equal(await canViewSalarySummary(emp, other, empPerms), false);
});
