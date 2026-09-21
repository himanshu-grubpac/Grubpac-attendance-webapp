process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { User } from '../models/User.js';
import { resetQuarterWarningsForUsers } from './attendancePolicyService.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([AttendanceRecord.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser() {
  sequence += 1;
  return User.create({
    role: 'employee',
    firstName: 'Warned',
    lastName: `User${sequence}`,
    name: `Warned User${sequence}`,
    email: `warned.${sequence}@test.example`,
    mobile: `9${String(300000000 + sequence)}`,
    passwordHash: 'hash',
    employeeCode: `WRN${String(400 + sequence)}`,
    isActive: true,
  });
}

function warningCheckIn(userId, timestamp = new Date()) {
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
    warningIssued: true,
    quarterWarningIndex: 1,
  };
}

test('reset traces the exact cleared check-in record ids', async () => {
  const user = await createUser();
  const first = await AttendanceRecord.create(warningCheckIn(user._id));
  const second = await AttendanceRecord.create(warningCheckIn(user._id));

  const result = await resetQuarterWarningsForUsers([user._id.toString()]);

  assert.equal(result.clearedWarnings, 2);
  assert.equal(result.clearedRecordIdsTruncated, false);
  assert.deepEqual(
    [...result.clearedRecordIds].sort(),
    [first._id.toString(), second._id.toString()].sort(),
  );

  const stored = await AttendanceRecord.find({ userId: user._id }).lean();
  assert.ok(stored.every((record) => record.warningIssued === false));
});

test('repeat reset is a no-op with empty trace', async () => {
  const user = await createUser();
  await AttendanceRecord.create(warningCheckIn(user._id));

  const first = await resetQuarterWarningsForUsers([user._id.toString()]);
  assert.equal(first.clearedWarnings, 1);

  const second = await resetQuarterWarningsForUsers([user._id.toString()]);
  assert.equal(second.clearedWarnings, 0);
  assert.deepEqual(second.clearedRecordIds, []);
  assert.equal(second.clearedRecordIdsTruncated, false);
});
