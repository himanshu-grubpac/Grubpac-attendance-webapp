/**
 * A4 fix: Bulk upload mobile lookup normalization.
 *
 * The import loop normalizes the incoming mobile with `.slice(-10)` (last 10
 * digits) to strip +91 country-code prefixes. Before the fix, `.slice(0, 10)`
 * was used — taking the FIRST 10 digits — which kept the country-code digits
 * and missed the actual mobile, causing upserts to create duplicates instead
 * of updating existing users.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import '../models/Department.js';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { importEmployeesFromRowsUpsert } from './excelImportService.js';
import { normalizeMobile } from '../../../shared/validation/common.js';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';

let memoryServer;
let sequence = 0;
let roles;
let department;
let actor;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([Role.deleteMany({}), User.deleteMany({}), Department.deleteMany({})]);
  sequence = 0;
  roles = {
    employee: await Role.create({ name: 'Employee', slug: 'employee', permissions: [] }),
    admin: await Role.create({
      name: 'Admin',
      slug: SYSTEM_ROLE_SLUGS.ADMIN,
      permissions: [PERMISSIONS.EMPLOYEES_RECORD_R, PERMISSIONS.USERS_READ, PERMISSIONS.USERS_WRITE],
    }),
  };
  department = await Department.create({ name: 'Engineering', code: 'ENG', isActive: true });
  actor = await User.create({
    role: 'admin',
    roleId: roles.admin._id,
    firstName: 'Admin',
    lastName: 'Actor',
    name: 'Admin Actor',
    email: 'admin.actor@bulk.test',
    mobile: '9000000001',
    passwordHash: 'hash',
    employeeCode: 'ADM001',
    isActive: true,
  });
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

const ACTOR_PERMS = [
  PERMISSIONS.EMPLOYEES_EMPLOYMENT_U,
  PERMISSIONS.EMPLOYEES_EMPLOYMENT_C,
  PERMISSIONS.EMPLOYEES_RECORD_R,
  PERMISSIONS.USERS_READ,
  PERMISSIONS.USERS_WRITE,
];

test('normalizeMobile strips +91 prefix to last 10 digits', () => {
  assert.equal(normalizeMobile('+919876543210'), '9876543210');
  assert.equal(normalizeMobile('  +91  8888 777766  '), '8888777766');
  assert.equal(normalizeMobile('9876543210'), '9876543210');
  assert.equal(normalizeMobile('987 654 3210'), '9876543210');
});

test('bulk import matches existing user when mobile has +91 prefix', async () => {
  const existing = await User.create({
    role: 'employee',
    roleId: roles.employee._id,
    firstName: 'Existing',
    lastName: 'User',
    name: 'Existing User',
    email: 'existing.mobile@bulk.test',
    mobile: '9876543210',
    passwordHash: 'hash',
    employeeCode: 'EXM100',
    designation: 'Engineer',
    joiningDate: new Date('2024-06-01'),
    departmentId: department._id,
    isActive: true,
  });

  const rows = [
    {
      rowNumber: 1,
      data: {
        firstName: 'Existing',
        lastName: 'User',
        email: 'existing.mobile@bulk.test',
        mobile: '+919876543210',
        employeeCode: 'EXM100',
        designation: 'Engineer',
        joiningDate: '2024-06-01',
        department: 'Engineering',
      },
    },
  ];

  const { results } = await importEmployeesFromRowsUpsert(rows, actor._id, {
    dryRun: true,
    actorId: actor._id.toString(),
    actorPermissions: ACTOR_PERMS,
  });

  const result = results[0];
  assert.ok(result, 'result row should exist');
  assert.equal(result.id, existing._id.toString(), 'should match the existing user');
  assert.notEqual(result.status, 'validation_error', `should not be validation_error: ${result.message || ''}`);
});

test('bulk import matches existing user when mobile has spaces and dashes', async () => {
  const existing = await User.create({
    role: 'employee',
    roleId: roles.employee._id,
    firstName: 'Spaced',
    lastName: 'Mobile',
    name: 'Spaced Mobile',
    email: 'spaced.mobile@bulk.test',
    mobile: '9876543210',
    passwordHash: 'hash',
    employeeCode: 'SPM200',
    designation: 'Engineer',
    joiningDate: new Date('2024-06-01'),
    departmentId: department._id,
    isActive: true,
  });

  const rows = [
    {
      rowNumber: 1,
      data: {
        firstName: 'Spaced',
        lastName: 'Mobile',
        email: 'spaced.mobile@bulk.test',
        mobile: '987 654 3210',
        employeeCode: 'SPM200',
        designation: 'Engineer',
        joiningDate: '2024-06-01',
        department: 'Engineering',
      },
    },
  ];

  const { results } = await importEmployeesFromRowsUpsert(rows, actor._id, {
    dryRun: true,
    actorId: actor._id.toString(),
    actorPermissions: ACTOR_PERMS,
  });

  const result = results[0];
  assert.ok(result, 'result row should exist');
  assert.equal(result.id, existing._id.toString(), 'should match the existing user');
  assert.notEqual(result.status, 'validation_error', `should not be validation_error: ${result.message || ''}`);
});

test('bulk import matches existing user when mobile is plain 10-digit', async () => {
  const existing = await User.create({
    role: 'employee',
    roleId: roles.employee._id,
    firstName: 'Plain',
    lastName: 'Mobile',
    name: 'Plain Mobile',
    email: 'plain.mobile@bulk.test',
    mobile: '8765432109',
    passwordHash: 'hash',
    employeeCode: 'PLM300',
    designation: 'Engineer',
    joiningDate: new Date('2024-06-01'),
    departmentId: department._id,
    isActive: true,
  });

  const rows = [
    {
      rowNumber: 1,
      data: {
        firstName: 'Plain',
        lastName: 'Mobile',
        email: 'plain.mobile@bulk.test',
        mobile: '8765432109',
        employeeCode: 'PLM300',
        designation: 'Engineer',
        joiningDate: '2024-06-01',
        department: 'Engineering',
      },
    },
  ];

  const { results } = await importEmployeesFromRowsUpsert(rows, actor._id, {
    dryRun: true,
    actorId: actor._id.toString(),
    actorPermissions: ACTOR_PERMS,
  });

  const result = results[0];
  assert.ok(result, 'result row should exist');
  assert.equal(result.id, existing._id.toString(), 'should match the existing user');
  assert.notEqual(result.status, 'validation_error', `should not be validation_error: ${result.message || ''}`);
});

test('bulk import does NOT create duplicate when mobile has +91 prefix', async () => {
  const existing = await User.create({
    role: 'employee',
    roleId: roles.employee._id,
    firstName: 'NoDup',
    lastName: 'User',
    name: 'NoDup User',
    email: 'nodup.mobile@bulk.test',
    mobile: '9876543210',
    passwordHash: 'hash',
    employeeCode: 'NDP400',
    designation: 'Engineer',
    joiningDate: new Date('2024-06-01'),
    departmentId: department._id,
    isActive: true,
  });

  const rows = [
    {
      rowNumber: 1,
      data: {
        firstName: 'NoDup',
        lastName: 'User',
        email: 'nodup.mobile@bulk.test',
        mobile: '+919876543210',
        employeeCode: 'NDP400',
        designation: 'Engineer',
        joiningDate: '2024-06-01',
        department: 'Engineering',
      },
    },
  ];

  const { results, summary } = await importEmployeesFromRowsUpsert(rows, actor._id, {
    dryRun: false,
    actorId: actor._id.toString(),
    actorPermissions: ACTOR_PERMS,
  });

  assert.equal(summary.created, 0, 'should not create a new user');
  const count = await User.countDocuments({ mobile: '9876543210' });
  assert.equal(count, 1, 'should not create a duplicate user');
});

test('bulk import matches mobile-only row with +91 prefix via mobile lookup', async () => {
  const existing = await User.create({
    role: 'employee',
    roleId: roles.employee._id,
    firstName: 'MobileOnly',
    lastName: 'Lookup',
    name: 'MobileOnly Lookup',
    email: 'mobileonly@bulk.test',
    mobile: '7777888899',
    passwordHash: 'hash',
    employeeCode: 'MOL500',
    designation: 'Engineer',
    joiningDate: new Date('2024-06-01'),
    departmentId: department._id,
    isActive: true,
  });

  const rows = [
    {
      rowNumber: 1,
      data: {
        firstName: 'MobileOnly',
        lastName: 'Lookup',
        email: '',
        mobile: '+917777888899',
        employeeCode: 'MOL500',
        designation: 'Engineer',
        joiningDate: '2024-06-01',
        department: 'Engineering',
      },
    },
  ];

  const { results } = await importEmployeesFromRowsUpsert(rows, actor._id, {
    dryRun: true,
    actorId: actor._id.toString(),
    actorPermissions: ACTOR_PERMS,
  });

  const result = results[0];
  assert.ok(result, 'result row should exist');
  assert.equal(result.id, existing._id.toString(), 'should match existing user via mobile lookup');
  assert.notEqual(result.status, 'validation_error', `should not be validation_error: ${result.message || ''}`);
});
