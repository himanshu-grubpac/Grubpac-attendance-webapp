process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { COMPANY_WIDE_SCOPE_SLUG, PERMISSIONS } from
  '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { User } from '../models/User.js';
import { getAdminAttendance } from './attendanceService.js';

const ADMIN_PERMS = [COMPANY_WIDE_SCOPE_SLUG, PERMISSIONS.ATTENDANCE_READ_ALL];

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([AttendanceRecord.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createEmployee() {
  sequence += 1;
  return User.create({
    role: 'employee',
    firstName: 'Filter',
    lastName: `User${sequence}`,
    name: `Filter User${sequence}`,
    email: `type-filter-${sequence}@example.com`,
    mobile: `9000000${String(100 + sequence)}`,
    passwordHash: 'test-hash',
  });
}

function recordFields(userId, type, timestamp) {
  return {
    userId,
    type,
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

test('check-out type filter returns check-outs (orphan filter skipped)', async () => {
  const admin = await createEmployee();
  const employee = await createEmployee();
  const morning = new Date('2026-09-15T04:00:00.000Z');
  const evening = new Date('2026-09-15T13:00:00.000Z');
  await AttendanceRecord.create(recordFields(employee._id, 'check_in', morning));
  await AttendanceRecord.create(recordFields(employee._id, 'check_out', evening));

  const result = await getAdminAttendance({
    type: 'check_out',
    page: 1,
    limit: 20,
    actor: admin,
    permissions: ADMIN_PERMS,
  });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.records.length, 1);
  assert.ok(result.records.every((record) => record.type === 'check_out'));
});

test('check-in type filter still returns check-ins', async () => {
  const admin = await createEmployee();
  const employee = await createEmployee();
  await AttendanceRecord.create(
    recordFields(employee._id, 'check_in', new Date('2026-09-15T04:00:00.000Z')),
  );
  await AttendanceRecord.create(
    recordFields(employee._id, 'check_out', new Date('2026-09-15T13:00:00.000Z')),
  );

  const result = await getAdminAttendance({
    type: 'check_in',
    page: 1,
    limit: 20,
    actor: admin,
    permissions: ADMIN_PERMS,
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].type, 'check_in');
});

test('unfiltered list still drops true orphan check-outs', async () => {
  const admin = await createEmployee();
  const employee = await createEmployee();
  // Check-out with no same-day check-in: stays hidden in the combined view.
  await AttendanceRecord.create(
    recordFields(employee._id, 'check_out', new Date('2026-09-15T13:00:00.000Z')),
  );

  const result = await getAdminAttendance({ page: 1, limit: 20, actor: admin, permissions: ADMIN_PERMS });
  assert.equal(result.records.length, 0);
});
