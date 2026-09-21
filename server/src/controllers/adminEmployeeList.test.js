import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { getEmployee, getEmployeeStats, listEmployees, updateEmployee } from './adminController.js';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';

let memServer;

before(async () => {
  memServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memServer.waitUntilRunning();
  await mongoose.connect(memServer.getUri(), { maxPoolSize: 1 });
});

after(async () => {
  await mongoose.disconnect();
  await memServer.stop();
});

const reqFor = (page, limit) => ({
  query: { page: String(page), limit: String(limit) },
  user: { _id: new mongoose.Types.ObjectId(), roleSlug: SYSTEM_ROLE_SLUGS.ADMIN },
  userPermissions: [PERMISSIONS.EMPLOYEES_RECORD_R, PERMISSIONS.EMPLOYEES_ACCOUNT_R],
});

const captureRes = () => {
  let body;
  const res = {
    statusCode: 200,
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (payload) => {
      body = payload;
      return res;
    },
  };
  return { res, getBody: () => body };
};

async function makeEmployee(suffix, name = 'Same Name') {
  const ts = `${Date.now()}${suffix}${Math.floor(Math.random() * 1e6)}`;
  return User.create({
    email: `dup.${ts}@grubpac.com`,
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: name.split(' ')[0],
    name,
    mobile: `9${String(ts).slice(-9)}`,
    employeeCode: `DUP${String(ts).slice(-8)}`,
  });
}

test('same-name employees never appear on two pages (stable _id tiebreaker)', async () => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await makeEmployee(`s${i}`);
  }
  await makeEmployee('other', 'Zed Different');

  const seen = [];
  let total = 0;
  for (const page of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    const { res, getBody } = captureRes();
    // eslint-disable-next-line no-await-in-loop
    await listEmployees(reqFor(page, 2), res);
    const body = getBody();
    total = body.pagination.total;
    seen.push(...body.employees.map((e) => e.id));
  }

  assert.equal(seen.length, new Set(seen).size, 'no employee id repeats across pages');
  assert.equal(seen.length, Math.min(total, 6), 'pages cover every employee exactly once');
});

test('repeated page reads return identical order (deterministic sort)', async () => {
  const first = captureRes();
  await listEmployees(reqFor(1, 10), first.res);
  const second = captureRes();
  await listEmployees(reqFor(1, 10), second.res);

  assert.deepEqual(
    second.getBody().employees.map((e) => e.id),
    first.getBody().employees.map((e) => e.id),
  );
});

async function seedAdminAndEmployee() {
  await User.deleteMany({});
  await Role.deleteMany({});
  const adminRole = await Role.create({ name: 'Admin', slug: 'admin', permissions: [] });
  const empRole = await Role.create({ name: 'Employee', slug: 'employee', permissions: [] });
  const admin = await User.create({
    email: 'sys.admin@test.example',
    passwordHash: 'x',
    role: 'admin',
    roleId: adminRole._id,
    isActive: true,
    firstName: 'Sys',
    name: 'Sys Admin',
    mobile: '9000000001',
    employeeCode: 'ADM001',
  });
  const employee = await User.create({
    email: 'regular@test.example',
    passwordHash: 'x',
    role: 'employee',
    roleId: empRole._id,
    isActive: true,
    firstName: 'Regular',
    name: 'Regular Employee',
    mobile: '9000000002',
    employeeCode: 'EMP001',
  });
  return { adminRole, empRole, admin, employee };
}

const statsReq = () => ({
  query: {},
  user: { _id: new mongoose.Types.ObjectId(), roleSlug: SYSTEM_ROLE_SLUGS.ADMIN },
  userPermissions: [PERMISSIONS.EMPLOYEES_RECORD_R],
});

test('All-roles list includes admins; role filter still scopes', async () => {
  const { adminRole, empRole, admin } = await seedAdminAndEmployee();

  const all = captureRes();
  await listEmployees({ ...reqFor(1, 10), query: { page: '1', limit: '10' } }, all.res);
  const allIds = all.getBody().employees.map((e) => e.id);
  assert.ok(allIds.includes(admin._id.toString()), 'admin visible with All roles');

  const empOnly = captureRes();
  await listEmployees(
    { ...reqFor(1, 10), query: { page: '1', limit: '10', roleId: empRole._id.toString() } },
    empOnly.res,
  );
  const empIds = empOnly.getBody().employees.map((e) => e.id);
  assert.ok(!empIds.includes(admin._id.toString()), 'admin excluded under Employee role');

  const adminOnly = captureRes();
  await listEmployees(
    { ...reqFor(1, 10), query: { page: '1', limit: '10', roleId: adminRole._id.toString() } },
    adminOnly.res,
  );
  assert.deepEqual(
    adminOnly.getBody().employees.map((e) => e.id),
    [admin._id.toString()],
    'explicit Admin role selection lists the admin',
  );
});

test('stats include oldest joining year for dynamic year filters', async () => {
  await User.deleteMany({});
  const base = {
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: 'Old',
    name: 'Old Joiner',
    mobile: '9111111111',
    employeeCode: 'OLD001',
  };
  await User.create({ ...base, email: 'old@test.example', joiningDate: new Date('2021-03-15T00:00:00Z') });
  await User.create({
    ...base,
    email: 'new@test.example',
    mobile: '9222222222',
    employeeCode: 'OLD002',
    joiningDate: new Date('2024-06-01T00:00:00Z'),
  });
  await User.create({
    ...base,
    email: 'nodate@test.example',
    mobile: '9333333333',
    employeeCode: 'OLD003',
    joiningDate: null,
  });

  const { res, getBody } = captureRes();
  await getEmployeeStats(statsReq(), res);
  assert.equal(getBody().stats.oldestJoiningYear, 2021);
});

test('stats oldest joining year is null without dated employees', async () => {
  await User.deleteMany({});
  await makeEmployee('nodate');

  const { res, getBody } = captureRes();
  await getEmployeeStats(statsReq(), res);
  assert.equal(getBody().stats.oldestJoiningYear, null);
});

test('stats cards count admins', async () => {
  await seedAdminAndEmployee();
  const { res, getBody } = captureRes();
  await getEmployeeStats(statsReq(), res);
  assert.equal(getBody().stats.total, 2);
  assert.equal(getBody().stats.active, 2);
});

test('stats include per-role breakdown for dashboard cards', async () => {
  await seedAdminAndEmployee();
  const { res, getBody } = captureRes();
  await getEmployeeStats(statsReq(), res);
  const breakdown = getBody().stats.roleBreakdown;
  assert.ok(Array.isArray(breakdown));
  const bySlug = new Map(breakdown.map((entry) => [entry.slug, entry]));
  assert.equal(bySlug.get('admin')?.count, 1);
  assert.equal(bySlug.get('employee')?.count, 1);
  assert.ok(bySlug.get('admin')?.roleId, 'admin entry carries its role id for deep links');
});

test('direct salary update on an admin is vetoed', async () => {
  const { admin } = await seedAdminAndEmployee();
  const actorId = new mongoose.Types.ObjectId();

  const updated = captureRes();
  await updateEmployee(
    {
      params: { id: admin._id.toString() },
      body: { isActive: false },
      user: { _id: actorId },
      userPermissions: [PERMISSIONS.EMPLOYEES_RECORD_R],
    },
    updated.res,
  );
  assert.equal(updated.res.statusCode, 400);
  assert.match(updated.getBody().message, /Cannot modify the system admin/);
});

let joiningSequence = 0;

async function makeEmployeeWithJoining(email, code, joiningDate) {
  joiningSequence += 1;
  return User.create({
    email,
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: 'Join',
    name: email,
    mobile: `8${String(700000000 + joiningSequence)}`,
    employeeCode: code,
    joiningDate: joiningDate ? new Date(joiningDate) : null,
  });
}

test('joining date range filters the directory', async () => {
  await User.deleteMany({});
  await makeEmployeeWithJoining('may@test.example', 'JOI001', '2022-05-11T00:00:00Z');
  await makeEmployeeWithJoining('sept@test.example', 'JOI002', '2026-09-05T00:00:00Z');
  await makeEmployeeWithJoining('oct@test.example', 'JOI003', '2026-10-02T00:00:00Z');

  const inRange = captureRes();
  await listEmployees(
    { ...reqFor(1, 10), query: { page: '1', limit: '10', joiningFrom: '2026-09-01', joiningTo: '2026-09-30' } },
    inRange.res,
  );
  assert.deepEqual(
    inRange.getBody().employees.map((e) => e.employeeCode),
    ['JOI002'],
  );

  const fromOnly = captureRes();
  await listEmployees(
    { ...reqFor(1, 10), query: { page: '1', limit: '10', joiningFrom: '2026-09-01' } },
    fromOnly.res,
  );
  assert.deepEqual(
    fromOnly.getBody().employees.map((e) => e.employeeCode).sort(),
    ['JOI002', 'JOI003'],
  );

  const toOnly = captureRes();
  await listEmployees(
    { ...reqFor(1, 10), query: { page: '1', limit: '10', joiningTo: '2023-01-01' } },
    toOnly.res,
  );
  assert.deepEqual(
    toOnly.getBody().employees.map((e) => e.employeeCode),
    ['JOI001'],
  );
});

test('malformed joining dates are rejected', async () => {
  const bad = captureRes();
  await assert.rejects(
    listEmployees(
      { ...reqFor(1, 10), query: { page: '1', limit: '10', joiningFrom: 'not-a-date' } },
      bad.res,
    ),
  );
});

async function seedNamedUser(firstName, lastName) {
  await User.deleteMany({});
  await Role.deleteMany({});
  await Role.create({ name: 'Employee', slug: 'employee', permissions: [] });
  const user = await User.create({
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@search.test`,
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    mobile: '9000000001',
    employeeCode: 'SRC001',
  });
  await User.create({
    email: 'unrelated@search.test',
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: 'Zed',
    lastName: 'Unrelated',
    name: 'Zed Unrelated',
    mobile: '9000000002',
    employeeCode: 'SRC002',
  });
  return user;
}

async function searchIds(search) {
  const { res, getBody } = captureRes();
  await listEmployees(
    { ...reqFor(1, 10), query: { page: '1', limit: '10', search } },
    res,
  );
  return getBody().employees.map((e) => e.id);
}

test('search matches partial tokens in any order', async () => {
  const user = await seedNamedUser('Abhishek', 'Anand');

  // Reversed full name.
  assert.deepEqual(await searchIds('Anand Abhishek'), [user._id.toString()]);
  // Partial prefix.
  assert.deepEqual(await searchIds('Abhi'), [user._id.toString()]);
  // Middle substring.
  assert.deepEqual(await searchIds('hek Ana'), [user._id.toString()]);
});

test('admin detail fetch stays masked and admin update stays blocked', async () => {
  const { admin } = await seedAdminAndEmployee();
  const actorId = new mongoose.Types.ObjectId();

  const fetched = captureRes();
  await getEmployee(
    { params: { id: admin._id.toString() }, user: { _id: actorId }, userPermissions: [] },
    fetched.res,
  );
  assert.equal(fetched.res.statusCode, 404);

  const updated = captureRes();
  await updateEmployee(
    {
      params: { id: admin._id.toString() },
      body: { isActive: false },
      user: { _id: actorId },
      userPermissions: [],
    },
    updated.res,
  );
  assert.equal(updated.res.statusCode, 400);
  assert.equal((await User.findById(admin._id).lean()).isActive, true);
});
