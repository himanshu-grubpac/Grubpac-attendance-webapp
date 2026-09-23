/**
 * Today-present department/role filters (integration, real Mongo).
 *
 * Filters narrow within the caller's team scope (same contract as the
 * Employee List): they can never widen visibility, and the summary
 * describes the filtered team so cards reconcile with the rows.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import '../models/Department.js';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { getTeamTodayStatusService } from './attendanceService.js';

const ADMIN_PERMS = [
  PERMISSIONS.EMPLOYEES_RECORD_R,
  PERMISSIONS.ATTENDANCE_READ_ALL,
  PERMISSIONS.ATTENDANCE_READ_TEAM,
];

let memoryServer;
let sequence = 0;

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

async function setup() {
  sequence += 1;
  const empRole = await Role.create({ name: 'employee', slug: `employee-${sequence}`, permissions: [] });
  const rmRole = await Role.create({ name: 'rm', slug: `rm-${sequence}`, permissions: [] });
  const adminRole = await Role.create({ name: 'Admin', slug: 'admin', permissions: [] });
  const dev = await Department.create({ name: 'Development', code: `DEV${sequence}` });
  const design = await Department.create({ name: 'Design', code: `DSN${sequence}` });
  const admin = await User.create({
    firstName: 'Admin',
    lastName: 'Test',
    name: 'Admin Test',
    email: `admin.${sequence}@test.example`,
    mobile: `6${String(300000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'admin',
    roleId: adminRole._id,
    isActive: true,
  });
  const devEmp = await User.create({
    firstName: 'Dev',
    lastName: 'Emp',
    name: 'Dev Emp',
    email: `dev.${sequence}@test.example`,
    mobile: `6${String(310000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId: empRole._id,
    departmentId: dev._id,
    isActive: true,
  });
  const designRm = await User.create({
    firstName: 'Design',
    lastName: 'Rm',
    name: 'Design Rm',
    email: `design.${sequence}@test.example`,
    mobile: `6${String(320000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId: rmRole._id,
    departmentId: design._id,
    isActive: true,
  });
  return { admin, adminRole, empRole, rmRole, dev, design, devEmp, designRm };
}

test('no filters returns the whole scoped roster (Employee List parity — admins excluded by default)', async () => {
  const { admin } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, { paginate: true, page: 1, limit: 25 });
  assert.equal(result.pagination.total, 2);
  assert.equal(result.summary.total, 2);
  const names = result.teamStatus.map((row) => row.name);
  assert.ok(!names.includes('Admin Test'), 'admin accounts hidden unless role filter selects Admin');
});

test('departmentId narrows rows, total and summary together', async () => {
  const { admin, dev } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, {
    paginate: true,
    page: 1,
    limit: 25,
    departmentId: dev._id.toString(),
  });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.teamStatus[0].department, 'Development');
  assert.equal(result.summary.total, 1);
});

test('roleId narrows rows, total and summary together', async () => {
  const { admin, rmRole } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, {
    paginate: true,
    page: 1,
    limit: 25,
    roleId: rmRole._id.toString(),
  });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.teamStatus[0].name, 'Design Rm');
  assert.equal(result.summary.total, 1);
});

test('Admin role filter on default roster matches nobody (admins not in base membership)', async () => {
  const { admin, adminRole } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, {
    paginate: true,
    page: 1,
    limit: 25,
    roleId: adminRole._id.toString(),
  });
  assert.equal(result.pagination.total, 0);
  assert.equal(result.teamStatus.length, 0);
  assert.equal(result.summary.total, 0);
});

test('non-admin role selection never surfaces admins', async () => {
  const { admin, rmRole } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, {
    paginate: true,
    page: 1,
    limit: 25,
    roleId: rmRole._id.toString(),
  });
  const names = result.teamStatus.map((row) => row.name);
  assert.ok(!names.includes('Admin Test'));
});

test('unknown department matches nobody (never widens)', async () => {
  const { admin } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, {
    paginate: true,
    page: 1,
    limit: 25,
    departmentId: new mongoose.Types.ObjectId().toString(),
  });
  assert.equal(result.pagination.total, 0);
  assert.equal(result.teamStatus.length, 0);
  assert.equal(result.summary.total, 0);
});

test('userId narrows to one member within scope', async () => {
  const { admin, devEmp } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, {
    paginate: true,
    page: 1,
    limit: 25,
    userId: devEmp._id.toString(),
  });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.teamStatus[0].name, 'Dev Emp');
  assert.equal(result.summary.total, 1);
});

test('userId outside scope matches nobody (never widens)', async () => {
  const { admin } = await setup();
  const result = await getTeamTodayStatusService(admin, ADMIN_PERMS, {
    paginate: true,
    page: 1,
    limit: 25,
    userId: new mongoose.Types.ObjectId().toString(),
  });
  assert.equal(result.pagination.total, 0);
  assert.equal(result.teamStatus.length, 0);
  assert.equal(result.summary.total, 0);
});
