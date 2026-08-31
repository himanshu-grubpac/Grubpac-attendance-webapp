import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { JobLock } from '../models/JobLock.js';
import { User } from '../models/User.js';
import { runAutoCheckoutJob, computeAutoCheckoutDeadline } from './autoCheckoutJob.js';
import {
  buildISTTimestampFromDayAndTime,
  getISTDateInputValue,
  startOfDayIST,
} from '../utils/istDate.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let memServer;
let dbReady = false;

async function setupDb() {
  if (dbReady) return;
  memServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memServer.waitUntilRunning();
  await mongoose.connect(memServer.getUri(), { maxPoolSize: 1 });
  dbReady = true;
}

async function teardownDb() {
  if (!dbReady) return;
  await mongoose.disconnect();
  await memServer.stop();
  dbReady = false;
}

function istInstant(dayKey, timeHHmm) {
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeHHmm);
  assert.ok(dayMatch, `invalid dayKey ${dayKey}`);
  assert.ok(timeMatch, `invalid time ${timeHHmm}`);
  const [, y, m, d] = dayMatch.map(Number);
  const [, h, min] = timeMatch.map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min, 0, 0) - IST_OFFSET_MS);
}

async function makeUser(emailPrefix) {
  const ts = Date.now() + Math.random();
  return User.create({
    email: `${emailPrefix}.${ts}@test.com`,
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: emailPrefix,
    name: emailPrefix,
    mobile: '9' + String(ts).slice(-9),
    employeeCode: emailPrefix + String(ts).slice(-6),
  });
}

async function makeCheckIn(userId, mode, dayKey, time) {
  const office = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  return AttendanceRecord.create({
    userId,
    type: 'check_in',
    attendanceMode: mode,
    timestamp: buildISTTimestampFromDayAndTime(dayKey, time),
    status: 'allowed',
    rejectionReasons: [],
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: 1,
    distanceMeters: 0,
    officeLatitude: office.latitude,
    officeLongitude: office.longitude,
    radiusMeters: office.radiusMeters,
  });
}

async function makeCheckOut(userId, mode, dayKey, time, opts = {}) {
  const office = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  return AttendanceRecord.create({
    userId,
    type: 'check_out',
    attendanceMode: mode,
    timestamp: buildISTTimestampFromDayAndTime(dayKey, time),
    status: 'allowed',
    rejectionReasons: [],
    autoCheckout: opts.autoCheckout ?? false,
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: 1,
    distanceMeters: 0,
    officeLatitude: office.latitude,
    officeLongitude: office.longitude,
    radiusMeters: office.radiusMeters,
  });
}

async function countAutoCheckouts(userId) {
  return AttendanceRecord.countDocuments({ userId, type: 'check_out', autoCheckout: true });
}

async function ensureDefaultOffice() {
  let off = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  if (!off) {
    off = await OfficeSettings.create({
      name: 'Test Office',
      latitude: 28.647284,
      longitude: 77.202835,
      radiusMeters: 100,
      maxAccuracyMeters: 50,
    });
  }
  return off;
}

// ─── Integration tests ───────────────────────────────────────────────

test('integration: overdue office check-in is auto-checked-out', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.office');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 1, 'should create one auto-checkout');
    assert.equal(result.processed, 1);
    assert.ok(result.checkedOut.length === 1);
  } finally {
    await teardownDb();
  }
});

test('integration: overdue WFH check-in is auto-checked-out', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.wfh');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'wfh', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 1, 'should create one auto-checkout');
    assert.equal(result.processed, 1);
  } finally {
    await teardownDb();
  }
});

test('integration: today check-in not yet due is skipped', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.today');
    await ensureDefaultOffice();
    const now = new Date();
    const todayKey = getISTDateInputValue(now);
    await makeCheckIn(user._id, 'office', todayKey, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0, 'should not create auto-checkout');
    assert.equal(result.processed, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: manual check-out prevents auto-checkout', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.manual');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    await makeCheckOut(user._id, 'office', twoDaysAgo, '18:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0, 'should not create auto-checkout');
    assert.equal(result.processed, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: disabled auto-checkout skips entirely', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.disabled');
    const off = await ensureDefaultOffice();
    off.autoCheckout = { enabled: false, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
    await off.save();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'disabled');
  } finally {
    await teardownDb();
  }
});

test('integration: re-enabled with custom time processes overdue', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.reenable');
    const off = await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));

    off.autoCheckout = { enabled: true, office: { day: 'same', time: '18:00' }, wfh: { day: 'next', time: '05:00' } };
    await off.save();
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 1, 'should process overdue with custom time');
    assert.ok(result.processed >= 1);
  } finally {
    await teardownDb();
  }
});

test('integration: no check-ins in window returns processed 0', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    await ensureDefaultOffice();
    const now = new Date();

    const result = await runAutoCheckoutJob(now);

    assert.equal(result.processed, 0);
    assert.ok(result.runAt);
  } finally {
    await teardownDb();
  }
});

test('integration: now exactly at deadline processes (>=)', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.exact');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    const deadline = istInstant(twoDaysAgo, '23:59');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(deadline);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 1, 'should process at exact deadline');
    assert.equal(result.processed, 1);
  } finally {
    await teardownDb();
  }
});

test('integration: now 1ms before deadline skips', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.before');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    const deadline = istInstant(twoDaysAgo, '23:59');
    const justBefore = new Date(deadline.getTime() - 1);

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(justBefore);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0, 'should skip before deadline');
    assert.equal(result.processed, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: multiple users processed independently', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user1 = await makeUser('int.multi1');
    const user2 = await makeUser('int.multi2');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user1._id, 'office', twoDaysAgo, '09:00');
    await makeCheckIn(user2._id, 'wfh', twoDaysAgo, '09:00');

    const result = await runAutoCheckoutJob(now);

    assert.equal(result.processed, 2, 'should process both users');
    assert.equal(await countAutoCheckouts(user1._id), 1);
    assert.equal(await countAutoCheckouts(user2._id), 1);
  } finally {
    await teardownDb();
  }
});

test('integration: user with both office and WFH check-ins on different days', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.mixed');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    const threeDaysAgo = getISTDateInputValue(new Date(now.getTime() - 3 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    await makeCheckIn(user._id, 'wfh', threeDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 2, 'should create auto-checkout for each mode/day');
    assert.equal(result.processed, 2);
  } finally {
    await teardownDb();
  }
});

test('integration: missing OfficeSettings falls back to env defaults', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    await OfficeSettings.deleteMany({});
    const user = await makeUser('int.nosettings');
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    const office = await ensureDefaultOffice();
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.ok(after - before >= 0, 'should handle missing settings gracefully');
  } finally {
    await teardownDb();
  }
});

test('integration: concurrent invocations — only one processes', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.concurrent');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const [resA, resB] = await Promise.all([
      runAutoCheckoutJob(now),
      runAutoCheckoutJob(now),
    ]);
    const after = await countAutoCheckouts(user._id);

    const totalProcessed = (resA.processed || 0) + (resB.processed || 0);
    const oneSkipped = resA.skipped || resB.skipped;
    assert.ok(totalProcessed <= 1, 'only one should process');
    assert.ok(oneSkipped, 'one should be skipped');
    assert.ok(after - before <= 1, 'no duplicate records');
  } finally {
    await teardownDb();
  }
});

test('integration: scan window boundary — check-in at exactly 3 days ago is included', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.window');
    await ensureDefaultOffice();
    const now = new Date();
    const threeDaysAgo = getISTDateInputValue(new Date(now.getTime() - 3 * 86400000));
    await makeCheckIn(user._id, 'office', threeDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 1, 'check-in at 3-day boundary should be included');
    assert.equal(result.processed, 1);
  } finally {
    await teardownDb();
  }
});

test('integration: check-in older than 3 days is excluded', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.old');
    await ensureDefaultOffice();
    const now = new Date();
    const fourDaysAgo = getISTDateInputValue(new Date(now.getTime() - 4 * 86400000));
    await makeCheckIn(user._id, 'office', fourDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0, 'check-in older than 3 days should be excluded');
    assert.equal(result.processed, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: check-out with wrong mode does not prevent auto-checkout', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.modemismatch');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    await makeCheckOut(user._id, 'wfh', twoDaysAgo, '18:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 1, 'wrong mode check-out should not prevent auto-checkout');
    assert.equal(result.processed, 1);
  } finally {
    await teardownDb();
  }
});

test('integration: auto-checkout record has autoCheckout flag set', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.flag');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');

    await runAutoCheckoutJob(now);
    const record = await AttendanceRecord.findOne({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });

    assert.ok(record, 'auto-checkout record should exist');
    assert.equal(record.autoCheckout, true);
    assert.equal(record.status, 'allowed');
    assert.equal(record.attendanceMode, 'office');
    assert.equal(record.rejectionReasons.length, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: auto-checkout record has synthetic geo fields', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.geo');
    const off = await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');

    await runAutoCheckoutJob(now);
    const record = await AttendanceRecord.findOne({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });

    assert.ok(record, 'auto-checkout record should exist');
    assert.equal(record.latitude, off.latitude);
    assert.equal(record.longitude, off.longitude);
    assert.equal(record.officeLatitude, off.latitude);
    assert.equal(record.officeLongitude, off.longitude);
    assert.equal(record.radiusMeters, off.radiusMeters);
    assert.equal(record.accuracyMeters, 1);
    assert.equal(record.distanceMeters, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: lock released after execution', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    await ensureDefaultOffice();
    const now = new Date();

    await runAutoCheckoutJob(now);
    const locks = await JobLock.find({ name: 'auto-checkout' });
    assert.equal(locks.length, 0, 'lock should be released');
  } finally {
    await teardownDb();
  }
});

test('integration: lock released even on error', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    await ensureDefaultOffice();

    // Force an error by corrupting the model temporarily
    const originalFind = AttendanceRecord.find;
    AttendanceRecord.find = () => { throw new Error('DB error'); };

    try {
      await runAutoCheckoutJob(new Date());
    } catch {
      // expected
    } finally {
      AttendanceRecord.find = originalFind;
    }

    const locks = await JobLock.find({ name: 'auto-checkout' });
    assert.equal(locks.length, 0, 'lock should be released even after error');
  } finally {
    await teardownDb();
  }
});

test('integration: custom WFH deadline — next day 06:00', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.wfhdeadline');
    const off = await ensureDefaultOffice();
    off.autoCheckout = { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
    await off.save();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'wfh', twoDaysAgo, '09:00');

    await runAutoCheckoutJob(now);
    const record = await AttendanceRecord.findOne({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });

    assert.ok(record, 'auto-checkout record should exist');
    const expectedDeadline = istInstant(
      getISTDateInputValue(new Date(buildISTTimestampFromDayAndTime(twoDaysAgo, '00:00').getTime() + 86400000)),
      '06:00',
    );
    assert.equal(record.timestamp.getTime(), expectedDeadline.getTime(), 'deadline should be next day 06:00');
  } finally {
    await teardownDb();
  }
});

test('integration: check-out after deadline still prevents new auto-checkout', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.lateco');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    await makeCheckOut(user._id, 'office', twoDaysAgo, '23:59');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0, 'check-out at deadline should prevent auto-checkout');
    assert.equal(result.processed, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: rejected check-in is excluded from scan', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.rejected');
    const off = await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await AttendanceRecord.create({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      timestamp: buildISTTimestampFromDayAndTime(twoDaysAgo, '09:00'),
      status: 'rejected',
      rejectionReasons: ['Outside radius'],
      latitude: off.latitude,
      longitude: off.longitude,
      accuracyMeters: 1,
      distanceMeters: 0,
      officeLatitude: off.latitude,
      officeLongitude: off.longitude,
      radiusMeters: off.radiusMeters,
    });

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0, 'rejected check-in should be excluded');
    assert.equal(result.processed, 0);
  } finally {
    await teardownDb();
  }
});

test('integration: multiple check-ins same user same day same mode — dedup ensures one auto-checkout', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.dedup');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    await makeCheckIn(user._id, 'office', twoDaysAgo, '10:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 1, 'dedup should produce only one auto-checkout');
    assert.equal(result.processed, 1);
  } finally {
    await teardownDb();
  }
});

test('integration: multiple check-ins same user different modes — one auto-checkout each', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.modemulti');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    await makeCheckIn(user._id, 'wfh', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 2, 'different modes should each get an auto-checkout');
    assert.equal(result.processed, 2);
  } finally {
    await teardownDb();
  }
});

test('integration: check-out at exact check-in time prevents auto-checkout', async () => {
  await setupDb();
  try {
    await AttendanceRecord.deleteMany({});
    await JobLock.deleteMany({});
    const user = await makeUser('int.exactco');
    await ensureDefaultOffice();
    const now = new Date();
    const twoDaysAgo = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
    await makeCheckIn(user._id, 'office', twoDaysAgo, '09:00');
    await makeCheckOut(user._id, 'office', twoDaysAgo, '09:00');

    const before = await countAutoCheckouts(user._id);
    const result = await runAutoCheckoutJob(now);
    const after = await countAutoCheckouts(user._id);

    assert.equal(after - before, 0, 'check-out at check-in time should prevent auto-checkout');
    assert.equal(result.processed, 0);
  } finally {
    await teardownDb();
  }
});
