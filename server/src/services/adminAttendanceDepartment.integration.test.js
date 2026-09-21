process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { COMPANY_WIDE_SCOPE_SLUG, PERMISSIONS, SYSTEM_ROLE_SLUGS } from
  '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { Department } from '../models/Department.js';
import { User } from '../models/User.js';
import { getAdminAttendance } from './attendanceService.js';

const ADMIN_PERMS = [COMPANY_WIDE_SCOPE_SLUG, PERMISSIONS.ATTENDANCE_READ_ALL];

// Actor form for company-wide (admin) calls: the scope helper reads roleSlug
// off the actor (production req.user carries the resolved slug).
const asAdmin = (userDoc) => ({
  ...userDoc.toObject(),
  _id: userDoc._id,
  roleSlug: SYSTEM_ROLE_SLUGS.ADMIN,
});

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    AttendanceRecord.deleteMany({}),
    Department.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createEmployee(name, fields = {}) {
  sequence += 1;
  return User.create({
    role: 'employee',
    firstName: name,
    lastName: `Dept${sequence}`,
    name: `${name} Dept${sequence}`,
    email: `dept-${sequence}@example.com`,
    mobile: `9000000${String(100 + sequence)}`,
    passwordHash: 'test-hash',
    ...fields,
  });
}

function checkInFields(userId, timestamp) {
  return {
    userId,
    type: 'check_in',
    attendanceMode: 'office',
    timestamp,
    latitude: 28.6439,
    longitude: 77.20129,
    accuracyMeters: 10,
    distanceMeters: 5,
    officeLatitude: 28.6439,
    officeLongitude: 77.20129,
    radiusMeters: 500,
    status: 'allowed',
    attendanceTag: 'P',
  };
}

test('history resolves department from the ref for users without the legacy string', async () => {
  const admin = await createEmployee('Admin');
  const department = await Department.create({ name: 'Development', code: 'DEV' });
  // Bulk-uploaded shape: departmentId ref set, legacy `department` string absent.
  const employee = await createEmployee('RefOnly', { departmentId: department._id });
  await AttendanceRecord.create(
    checkInFields(employee._id, new Date('2026-09-17T04:00:00.000Z')),
  );

  const result = await getAdminAttendance({
    userId: employee._id.toString(),
    page: 1,
    limit: 20,
    actor: asAdmin(admin),
    permissions: ADMIN_PERMS,
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].userId.departmentName, 'Development');
  assert.equal(result.records[0].userId.department, 'Development');
});

test('history keeps the legacy department string when no ref is set', async () => {
  const admin = await createEmployee('Admin');
  const employee = await createEmployee('Legacy', { department: 'Development' });
  await AttendanceRecord.create(
    checkInFields(employee._id, new Date('2026-09-17T04:00:00.000Z')),
  );

  const result = await getAdminAttendance({
    userId: employee._id.toString(),
    page: 1,
    limit: 20,
    actor: asAdmin(admin),
    permissions: ADMIN_PERMS,
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].userId.departmentName, 'Development');
});
