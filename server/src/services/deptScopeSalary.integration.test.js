/**
 * Department scope — salary lists, filters, and bulk import.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS, buildDefaultRolePermissions } from '../../../shared/permissions.js';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import {
  assertDepartmentInAccessibleSet,
  resolveAccessibleDepartmentIds,
} from './teamScopeService.js';
import {
  listLopSummaries,
  listSalarySummariesForMonth,
} from './salaryService.js';
import { importEmployeesFromRowsUpsert } from './excelImportService.js';

let memoryServer;
let sequence = 0;

const DEFAULTS = buildDefaultRolePermissions();
const MONTH = '2026-06';

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
    email: `${name.toLowerCase()}.${sequence}@deptscope.test`,
    mobile: `9${String(100000000 + sequence).slice(-9)}`,
    passwordHash: 'hash',
    role: 'admin',
    isActive: true,
    monthlySalary: 60000,
    salaryEffectiveFrom: new Date('2020-01-01'),
    ...fields,
  });
}

async function seedRmWithDepts() {
  const deptA = await Department.create({ name: 'Eng A', code: `EA${sequence}`, isActive: true });
  const deptB = await Department.create({ name: 'Eng B', code: `EB${sequence}`, isActive: true });
  const rm = await seedUser('RM', { managedDepartmentIds: [deptA._id] });
  const inTeam = await seedUser('InTeam', {
    departmentId: deptA._id,
    reportingManagerId: rm._id,
  });
  const outsider = await seedUser('Outsider', { departmentId: deptB._id });
  const rmPerms = DEFAULTS['reporting-manager'];
  return { deptA, deptB, rm, inTeam, outsider, rmPerms };
}

test('scoped RM listSalarySummariesForMonth excludes out-of-scope employees', async () => {
  const { rm, inTeam, outsider, rmPerms } = await seedRmWithDepts();

  const scoped = await listSalarySummariesForMonth(MONTH, {
    actor: rm,
    permissions: rmPerms,
  });
  const scopedIds = new Set(scoped.map((row) => row.userId));

  assert.ok(scopedIds.has(inTeam._id.toString()), 'in-team employee included');
  assert.ok(!scopedIds.has(outsider._id.toString()), 'outsider excluded');
});

test('listLopSummaries respects team scope', async () => {
  const { rm, inTeam, outsider, rmPerms } = await seedRmWithDepts();

  const result = await listLopSummaries({
    month: MONTH,
    page: 1,
    limit: 50,
    actor: rm,
    permissions: rmPerms,
  });
  const ids = new Set(result.employees.map((row) => row.userId));

  assert.ok(ids.has(inTeam._id.toString()));
  assert.ok(!ids.has(outsider._id.toString()));
});

test('departmentId filter rejected when out of scope', async () => {
  const { deptA, deptB, rm, rmPerms } = await seedRmWithDepts();

  await assert.rejects(
    () => assertDepartmentInAccessibleSet(rm, rmPerms, deptB._id),
    (error) => error.statusCode === 403,
  );

  await assert.doesNotReject(() =>
    assertDepartmentInAccessibleSet(rm, rmPerms, deptA._id),
  );
});

test('resolveAccessibleDepartmentIds returns managed and lead departments only for scoped users', async () => {
  const { deptA, deptB, rm, rmPerms } = await seedRmWithDepts();

  const accessible = await resolveAccessibleDepartmentIds(rm, rmPerms);
  const accessibleSet = new Set(accessible.map((id) => id.toString()));

  assert.ok(accessibleSet.has(deptA._id.toString()));
  assert.ok(!accessibleSet.has(deptB._id.toString()));
});

test('bulk import rejects out-of-scope department row', async () => {
  const { deptA, deptB, rm, rmPerms } = await seedRmWithDepts();
  const empRole = await Role.create({
    name: 'Employee',
    slug: SYSTEM_ROLE_SLUGS.EMPLOYEE,
    permissions: DEFAULTS.employee,
    isSystem: true,
  });
  const rmRole = await Role.create({
    name: 'Reporting Manager',
    slug: SYSTEM_ROLE_SLUGS.REPORTING_MANAGER,
    permissions: DEFAULTS['reporting-manager'],
    isSystem: true,
  });
  const manager = await seedUser('Mgr', {
    role: 'admin',
    roleId: rmRole._id,
    managedDepartmentIds: [deptA._id],
  });

  const rows = [
    {
      rowNumber: 2,
      data: {
        firstName: 'New',
        lastName: 'Hire',
        email: `newhire.${sequence}@deptscope.test`,
        mobile: `9${String(200000000 + sequence).slice(-9)}`,
        role: empRole.name,
        department: deptB.name,
        designation: 'Engineer',
        joiningDate: '2026-01-01',
        reportingManagerEmail: manager.email,
      },
    },
  ];

  const result = await importEmployeesFromRowsUpsert(rows, rm._id, {
    dryRun: true,
    actorId: rm._id.toString(),
    actorPermissions: rmPerms,
  });

  assert.equal(result.results[0].status, 'validation_error');
  assert.match(result.results[0].message, /department|scope|access/i);
});
