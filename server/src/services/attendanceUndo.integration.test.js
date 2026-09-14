process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { UndoAction } from '../models/UndoAction.js';
import { User } from '../models/User.js';
import { markAttendance, undoAttendance } from './attendanceService.js';

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
    OfficeSettings.deleteMany({}),
    UndoAction.deleteMany({}),
    User.deleteMany({}),
  ]);
  await OfficeSettings.create({
    name: 'Test Office',
    latitude: 28.6439,
    longitude: 77.20129,
    radiusMeters: 500,
    maxAccuracyMeters: 100,
    // No weekends: these undo tests check in "today", and the comp-off
    // weekend gate would otherwise reject check-ins on Saturdays/Sundays,
    // making the suite fail only on weekends (day-dependent flake).
    weekendDays: [],
  });
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createEmployee() {
  sequence += 1;
  return User.create({
    role: 'employee',
    firstName: 'Test',
    lastName: `User${sequence}`,
    name: `Test User${sequence}`,
    email: `undo-test-${sequence}@example.com`,
    mobile: `9000000${String(100 + sequence)}`,
    passwordHash: 'test-hash',
  });
}

function coords() {
  return { latitude: 28.6439, longitude: 77.20129, accuracyMeters: 10 };
}

test('undo succeeds after a duplicate (rejected) check-in attempt', async () => {
  const user = await createEmployee();
  const first = await markAttendance(user._id, 'check_in', coords(), {});
  assert.equal(first.status, 'allowed');
  assert.ok(first.undoToken);

  const retry = await markAttendance(user._id, 'check_in', coords(), {});
  assert.equal(retry.status, 'rejected');
  assert.ok(!retry.undoToken);

  const undone = await undoAttendance(first.undoToken, user._id, {});
  assert.equal(undone.status, 'undone');

  const remaining = await AttendanceRecord.find({ userId: user._id });
  // Only the rejected audit marker survives; the allowed check-in is removed.
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].status, 'rejected');
});

test('undo of check-in rejected after an allowed check-out (token expired)', async () => {
  const user = await createEmployee();
  const checkIn = await markAttendance(user._id, 'check_in', coords(), {});
  assert.equal(checkIn.status, 'allowed');

  const checkOut = await markAttendance(user._id, 'check_out', coords(), {});
  assert.equal(checkOut.status, 'allowed');

  // The newer allowed action expires the check-in token (one chance at a time).
  await assert.rejects(
    undoAttendance(checkIn.undoToken, user._id, {}),
    (err) => {
      assert.match(err.message, /Undo action is invalid or already used/);
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('stale active token for a non-latest record still gets 409', async () => {
  const user = await createEmployee();
  const checkIn = await markAttendance(user._id, 'check_in', coords(), {});
  await markAttendance(user._id, 'check_out', coords(), {});

  // Simulate a token that stayed active while a newer allowed action landed.
  await UndoAction.updateOne({ _id: checkIn.undoToken }, { $set: { status: 'active' } });

  await assert.rejects(
    undoAttendance(checkIn.undoToken, user._id, {}),
    (err) => {
      assert.match(err.message, /Only the last attendance action can be undone/);
      assert.equal(err.statusCode, 409);
      return true;
    },
  );
});

test('undo of the latest allowed check-out still works', async () => {
  const user = await createEmployee();
  await markAttendance(user._id, 'check_in', coords(), {});
  const checkOut = await markAttendance(user._id, 'check_out', coords(), {});
  assert.equal(checkOut.status, 'allowed');

  const undone = await undoAttendance(checkOut.undoToken, user._id, {});
  assert.equal(undone.status, 'undone');
  assert.equal(undone.type, 'check_out');
});
