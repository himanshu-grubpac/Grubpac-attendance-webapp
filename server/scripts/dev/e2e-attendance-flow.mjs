import { app } from '../../src/index.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { User } from '../../src/models/User.js';
import { AttendanceRecord } from '../../src/models/AttendanceRecord.js';
import { OfficeSettings } from '../../src/models/OfficeSettings.js';
import { UndoAction } from '../../src/models/UndoAction.js';
import { LeaveRequest } from '../../src/models/LeaveRequest.js';
import { LeaveType } from '../../src/models/LeaveType.js';
import { getOfficeSettings } from '../../src/services/geoService.js';
import {
  markAttendance,
  undoAttendance,
  getTodayStatus,
  getMonthDayStatusSummary,
  getAdminAttendanceCreateDayBlockReason,
  adminEditAttendanceRecord,
} from '../../src/services/attendanceService.js';
import { runAutoCheckoutJob } from '../../src/jobs/autoCheckoutJob.js';
import {
  getISTDateInputValue,
  buildISTTimestampFromDayAndTime,
} from '../../src/utils/istDate.js';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import bcrypt from 'bcryptjs';

if (!process.env.USE_MEMORY_DB) process.env.USE_MEMORY_DB = 'true';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, detail ? '— ' + detail : ''); }
}

function makeUser(prefix) {
  const ts = Date.now() + Math.random();
  return User.create({
    email: `${prefix}.${ts}@grubpac.com`,
    passwordHash: bcrypt.hashSync('Password123!', 8),
    role: 'employee',
    isActive: true,
    firstName: prefix,
    name: `${prefix} Test`,
    mobile: '9' + String(ts).slice(-9),
    employeeCode: `${prefix}${ts}`,
  });
}

function geoInside(office) {
  return {
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: 5,
    clientTimestamp: new Date().toISOString(),
  };
}

function geoOutside(office) {
  return {
    latitude: office.latitude + 1,
    longitude: office.longitude + 1,
    accuracyMeters: 5,
    clientTimestamp: new Date().toISOString(),
  };
}

function geoNullIsland() {
  return {
    latitude: 0,
    longitude: 0,
    accuracyMeters: 5,
    clientTimestamp: new Date().toISOString(),
  };
}

function geoStale() {
  return {
    latitude: 12.97,
    longitude: 77.59,
    accuracyMeters: 5,
    clientTimestamp: new Date(Date.now() - 60000).toISOString(),
  };
}

function geoFuture() {
  return {
    latitude: 12.97,
    longitude: 77.59,
    accuracyMeters: 5,
    clientTimestamp: new Date(Date.now() + 10000).toISOString(),
  };
}

function geoPoorAccuracy(office) {
  return {
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: office.maxAccuracyMeters + 10,
    clientTimestamp: new Date().toISOString(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
await connectDatabase();

try {
  // ═══════════════════════════════════════════════════════════
  // GROUP 0: Cold-start warm-up (in-memory DB only)
  // The first write transaction against a fresh in-memory replica set can
  // stall ~45s (primary election), which would push geo clientTimestamps
  // past the 30s freshness window and cause false "stale" rejections.
  // One throwaway check-in warms the txn path; its data is removed after.
  // ═══════════════════════════════════════════════════════════
  {
    const office = await getOfficeSettings();
    const warmUser = await makeUser('warmup');
    await markAttendance(warmUser._id, 'check_in', { ...geoInside(office), attendanceMode: 'office' });
    await AttendanceRecord.deleteMany({ userId: warmUser._id });
    await UndoAction.deleteMany({ actorId: warmUser._id });
    await User.deleteOne({ _id: warmUser._id });
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 1: Basic Check-In / Check-Out Flow
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 1: Basic Check-In / Check-Out Flow');

  {
    const office = await getOfficeSettings();
    const user = await makeUser('basic1');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    const result = await markAttendance(user._id, 'check_in', payload);
    check('1.1 successful check-in → allowed', result.status === 'allowed');
    check('1.1 undo token returned', Boolean(result.undoToken));
    check('1.1 record has attendanceTag (P or HD based on current time)',
      result.record.attendanceTag === 'P' || result.record.attendanceTag === 'HD');

    const status = await getTodayStatus(user._id);
    check('1.1 canCheckIn = false after check-in', status.canCheckIn === false);
    check('1.1 canCheckOut = true after check-in', status.canCheckOut === true);
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('basic2');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    await markAttendance(user._id, 'check_in', payload);
    const coResult = await markAttendance(user._id, 'check_out', {
      ...geoInside(office),
      attendanceMode: 'office',
    });
    check('1.2 successful check-out → allowed', coResult.status === 'allowed');

    const status = await getTodayStatus(user._id);
    check('1.2 canCheckIn = false after both', status.canCheckIn === false);
    check('1.2 canCheckOut = false after both', status.canCheckOut === false);
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('basic3');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    const result = await markAttendance(user._id, 'check_out', payload);
    check('1.3 check-out without check-in → rejected', result.status === 'rejected');
    check('1.3 rejection reason mentions check-in required',
      result.rejectionReasons.some((r) => r.includes('Check-in is required')));
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('basic4');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    await markAttendance(user._id, 'check_in', payload);
    const second = await markAttendance(user._id, 'check_in', payload);
    check('1.4 double check-in → rejected', second.status === 'rejected');
    check('1.4 rejection reason mentions already checked in',
      second.rejectionReasons.some((r) => r.includes('already checked in')));
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('basic5');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    await markAttendance(user._id, 'check_in', payload);
    await markAttendance(user._id, 'check_out', { ...geoInside(office), attendanceMode: 'office' });
    const second = await markAttendance(user._id, 'check_out', {
      ...geoInside(office),
      attendanceMode: 'office',
    });
    check('1.5 double check-out → rejected', second.status === 'rejected');
    check('1.5 rejection reason mentions already checked out',
      second.rejectionReasons.some((r) => r.includes('already checked out')));
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 2: Geofence & Location Edge Cases
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 2: Geofence & Location Edge Cases');

  {
    const office = await getOfficeSettings();
    const user = await makeUser('geo1');
    const payload = { ...geoOutside(office), attendanceMode: 'office' };

    const result = await markAttendance(user._id, 'check_in', payload);
    check('2.1 outside geofence → rejected', result.status === 'rejected');
    check('2.1 rejection reason mentions radius or distance',
      result.rejectionReasons.some((r) => r.includes('radius') || r.includes('outside') || r.includes('km')));
  }

  {
    const user = await makeUser('geo2');
    const payload = { ...geoNullIsland(), attendanceMode: 'office' };

    const result = await markAttendance(user._id, 'check_in', payload);
    check('2.2 null island (0,0) → rejected', result.status === 'rejected');
    check('2.2 rejection reason mentions invalid coordinates',
      result.rejectionReasons.some((r) => r.includes('0,0') || r.includes('invalid')));
  }

  {
    const user = await makeUser('geo3');
    const payload = { ...geoStale(), attendanceMode: 'office' };

    const result = await markAttendance(user._id, 'check_in', payload);
    check('2.3 stale GPS (>30s) → rejected', result.status === 'rejected');
    check('2.3 rejection reason mentions stale',
      result.rejectionReasons.some((r) => r.includes('stale')));
  }

  {
    const user = await makeUser('geo4');
    const payload = { ...geoFuture(), attendanceMode: 'office' };

    const result = await markAttendance(user._id, 'check_in', payload);
    check('2.4 future-skewed timestamp → rejected', result.status === 'rejected');
    check('2.4 rejection reason mentions timestamp',
      result.rejectionReasons.some((r) => r.includes('timestamp') || r.includes('invalid')));
  }

  {
    // Test poor accuracy: employee within radius but GPS accuracy exceeds maxAccuracyMeters.
    // Temporarily set office radius=200m, maxAccuracy=50m so that:
    //   distance ~89m (0.0008 deg lat offset), accuracy=60m
    //   effectiveDistance = 89+60 = 149 < 200 (within radius)
    //   but 60 > 50 (poor accuracy) → accuracy rejection
    const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
    const origRadius = settings.radiusMeters;
    const origMaxAcc = settings.maxAccuracyMeters;
    settings.radiusMeters = 200;
    settings.maxAccuracyMeters = 50;
    await settings.save();

    const user = await makeUser('geo5');
    const payload = {
      latitude: settings.latitude + 0.0008,
      longitude: settings.longitude,
      accuracyMeters: 60,
      clientTimestamp: new Date().toISOString(),
      attendanceMode: 'office',
    };

    const result = await markAttendance(user._id, 'check_in', payload);
    check('2.5 poor accuracy (within radius) → rejected', result.status === 'rejected');
    check('2.5 rejection reason mentions accuracy or metres',
      result.rejectionReasons.some((r) => r.includes('accuracy') || r.includes('metres') || r.includes('better')));

    // Restore
    settings.radiusMeters = origRadius;
    settings.maxAccuracyMeters = origMaxAcc;
    await settings.save();
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('geo6');

    const wfhType = await LeaveType.findOne({ code: 'WFH', isActive: true })
      || await LeaveType.create({ code: 'WFH', name: 'Work From Home', isActive: true });
    const todayKey = getISTDateInputValue();
    const todayIST = buildISTTimestampFromDayAndTime(todayKey, '12:00');
    await LeaveRequest.create({
      userId: user._id,
      leaveTypeId: wfhType._id,
      startDate: todayIST,
      endDate: todayIST,
      days: 1,
      reason: 'WFH test',
      status: 'approved',
    });

    const payload = {
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      clientTimestamp: new Date().toISOString(),
      attendanceMode: 'wfh',
    };
    const result = await markAttendance(user._id, 'check_in', payload);
    check('2.6 WFH mode bypasses geofence → allowed', result.status === 'allowed');
    check('2.6 attendanceMode = wfh', result.record.attendanceMode === 'wfh');
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('geo7');
    const payload = {
      latitude: office.latitude + 0.0008,
      longitude: office.longitude,
      accuracyMeters: 20,
      clientTimestamp: new Date().toISOString(),
      attendanceMode: 'office',
    };

    const result = await markAttendance(user._id, 'check_in', payload);
    check('2.7 effective distance (distance+accuracy) > radius → rejected',
      result.status === 'rejected');
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 3: Attendance Policy Edge Cases
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 3: Attendance Policy Edge Cases');

  {
    check('3.1-3.4 (policy edge cases covered in attendancePolicyService.test.js)', true);
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('pol2');

    const clType = await LeaveType.findOne({ code: 'CL', isActive: true })
      || await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
    const todayKey = getISTDateInputValue();
    const todayIST = buildISTTimestampFromDayAndTime(todayKey, '12:00');
    await LeaveRequest.create({
      userId: user._id,
      leaveTypeId: clType._id,
      startDate: todayIST,
      endDate: todayIST,
      days: 1,
      reason: 'Leave test',
      status: 'approved',
    });

    const payload = { ...geoInside(office), attendanceMode: 'office' };
    const result = await markAttendance(user._id, 'check_in', payload);
    check('3.5 approved leave blocks check-in → rejected', result.status === 'rejected');
    check('3.5 rejection reason mentions leave',
      result.rejectionReasons.some((r) => r.includes('leave') || r.includes('Leave')));
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 4: Undo Flow
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 4: Undo Flow');

  {
    const office = await getOfficeSettings();
    const user = await makeUser('undo1');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    const checkIn = await markAttendance(user._id, 'check_in', payload);
    const token = checkIn.undoToken;

    const undoResult = await undoAttendance(token, user._id);
    check('4.1 undo check-in within window → success', undoResult.status === 'undone');
    check('4.1 record type = check_in', undoResult.type === 'check_in');

    const afterUndo = await getTodayStatus(user._id);
    check('4.1 canCheckIn = true after undo', afterUndo.canCheckIn === true);
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('undo2');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    await markAttendance(user._id, 'check_in', payload);
    const checkOut = await markAttendance(user._id, 'check_out', {
      ...geoInside(office),
      attendanceMode: 'office',
    });
    const token = checkOut.undoToken;

    const undoResult = await undoAttendance(token, user._id);
    check('4.2 undo check-out within window → success', undoResult.status === 'undone');
    check('4.2 record type = check_out', undoResult.type === 'check_out');

    const afterUndo = await getTodayStatus(user._id);
    check('4.2 canCheckOut = true after undo', afterUndo.canCheckOut === true);
  }

  {
    // Test expired undo: create a record + UndoAction manually via raw MongoDB
    // with a createdAt 6 minutes in the past (bypasses Mongoose immutable timestamps)
    const office = await getOfficeSettings();
    const user = await makeUser('undo3');
    const todayKey = getISTDateInputValue();

    const record = await AttendanceRecord.create({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      timestamp: new Date(),
      status: 'allowed',
      rejectionReasons: [],
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      distanceMeters: 0,
      officeLatitude: office.latitude,
      officeLongitude: office.longitude,
      radiusMeters: office.radiusMeters,
    });

    // Insert UndoAction via raw MongoDB with a past createdAt
    const pastDate = new Date(Date.now() - 6 * 60 * 1000);
    const db = mongoose.connection.db;
    const undoInsert = await db.collection('undoactions').insertOne({
      actorId: user._id,
      targetType: 'attendance',
      targetId: record._id,
      status: 'active',
      usedAt: null,
      createdAt: pastDate,
      updatedAt: pastDate,
    });
    const undoToken = undoInsert.insertedId;

    try {
      await undoAttendance(undoToken.toString(), user._id);
      check('4.3 undo after window expired → throws', false);
    } catch (err) {
      check('4.3 undo after window expired → error message',
        err.message.includes('5 minutes'));
    }
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('undo4');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    const checkIn = await markAttendance(user._id, 'check_in', payload);
    const token = checkIn.undoToken;

    await undoAttendance(token, user._id);

    try {
      await undoAttendance(token, user._id);
      check('4.4 undo already-used token → throws', false);
    } catch (err) {
      check('4.4 undo already-used token → error message',
        err.message.includes('invalid') || err.message.includes('used'));
    }
  }

  {
    // Test non-last action: create two records and an active UndoAction for the first,
    // then try to undo the first (which is no longer the last action)
    const office = await getOfficeSettings();
    const user = await makeUser('undo5');
    const todayKey = getISTDateInputValue();

    const checkIn = await AttendanceRecord.create({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      timestamp: new Date(Date.now() - 1000),
      status: 'allowed',
      rejectionReasons: [],
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      distanceMeters: 0,
      officeLatitude: office.latitude,
      officeLongitude: office.longitude,
      radiusMeters: office.radiusMeters,
    });

    const checkOut = await AttendanceRecord.create({
      userId: user._id,
      type: 'check_out',
      attendanceMode: 'office',
      timestamp: new Date(),
      status: 'allowed',
      rejectionReasons: [],
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      distanceMeters: 0,
      officeLatitude: office.latitude,
      officeLongitude: office.longitude,
      radiusMeters: office.radiusMeters,
    });

    // Create an active UndoAction for the check-in (the earlier record)
    const db = mongoose.connection.db;
    const undoInsert = await db.collection('undoactions').insertOne({
      actorId: user._id,
      targetType: 'attendance',
      targetId: checkIn._id,
      status: 'active',
      usedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    try {
      await undoAttendance(undoInsert.insertedId.toString(), user._id);
      check('4.5 undo non-last action → throws', false);
    } catch (err) {
      check('4.5 undo non-last action → error message',
        err.message.includes('last'));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 5: Auto-Checkout Integration
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 5: Auto-Checkout Integration');

  {
    const office = await getOfficeSettings();
    const user = await makeUser('ac1');

    const twoDaysAgoKey = getISTDateInputValue(new Date(Date.now() - 2 * 86400000));
    await AttendanceRecord.create({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
      status: 'allowed',
      rejectionReasons: [],
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      distanceMeters: 0,
      officeLatitude: office.latitude,
      officeLongitude: office.longitude,
      radiusMeters: office.radiusMeters,
    });

    const beforeCount = await AttendanceRecord.countDocuments({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });

    const result = await runAutoCheckoutJob(new Date());
    const afterCount = await AttendanceRecord.countDocuments({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });

    check('5.1 auto-checkout creates record for overdue check-in',
      afterCount > beforeCount);
    check('5.1 processed count >= 1', (result.processed ?? 0) >= 1);
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('ac2');

    const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
    const origEnabled = settings.autoCheckout?.enabled;
    settings.autoCheckout.enabled = false;
    settings.markModified('autoCheckout');
    await settings.save();

    const twoDaysAgoKey = getISTDateInputValue(new Date(Date.now() - 2 * 86400000));
    await AttendanceRecord.create({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
      status: 'allowed',
      rejectionReasons: [],
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      distanceMeters: 0,
      officeLatitude: office.latitude,
      officeLongitude: office.longitude,
      radiusMeters: office.radiusMeters,
    });

    const result = await runAutoCheckoutJob(new Date());
    const afterCount = await AttendanceRecord.countDocuments({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });

    check('5.2 auto-checkout disabled → no record created', afterCount === 0);
    check('5.2 result skipped = true', result.skipped === true);

    settings.autoCheckout.enabled = origEnabled !== undefined ? origEnabled : true;
    settings.markModified('autoCheckout');
    await settings.save();
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('ac3');

    const twoDaysAgoKey = getISTDateInputValue(new Date(Date.now() - 2 * 86400000));
    await AttendanceRecord.create({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
      status: 'allowed',
      rejectionReasons: [],
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      distanceMeters: 0,
      officeLatitude: office.latitude,
      officeLongitude: office.longitude,
      radiusMeters: office.radiusMeters,
    });

    await runAutoCheckoutJob(new Date());

    const beforeCount = await AttendanceRecord.countDocuments({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });
    await runAutoCheckoutJob(new Date());
    const afterCount = await AttendanceRecord.countDocuments({
      userId: user._id,
      type: 'check_out',
      autoCheckout: true,
    });

    check('5.3 auto-checkout does not double-create',
      afterCount === beforeCount);
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 6: Month Summary & Calendar
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 6: Month Summary & Calendar');

  {
    const office = await getOfficeSettings();
    const user = await makeUser('month1');

    const payload = { ...geoInside(office), attendanceMode: 'office' };
    await markAttendance(user._id, 'check_in', payload);

    const now = new Date();
    const monthInput = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const summary = await getMonthDayStatusSummary(user._id, monthInput);

    const todayKey = getISTDateInputValue();
    // days is an object keyed by dayKey, not an array
    const todayStatus = summary.days[todayKey];
    check('6.1 month summary has today', Boolean(todayStatus));
    check('6.1 today status is present or half_day',
      todayStatus === 'present' || todayStatus === 'half_day');
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 7: Admin Attendance Edge Cases
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 7: Admin Attendance Edge Cases');

  {
    const todayKey = getISTDateInputValue();
    const blockReason = getAdminAttendanceCreateDayBlockReason(todayKey);
    const now = new Date();
    const istDay = now.getUTCDay();
    if (istDay === 0 || istDay === 6) {
      check('7.1 today is weekend → blocked', Boolean(blockReason));
    } else {
      check('7.1 today is weekday → not blocked', !blockReason);
    }
  }

  {
    const futureDate = new Date(Date.now() + 7 * 86400000);
    const futureKey = getISTDateInputValue(futureDate);
    const blockReason = getAdminAttendanceCreateDayBlockReason(futureKey);
    check('7.2 future day → blocked', Boolean(blockReason));
  }

  {
    const office = await getOfficeSettings();
    const user = await makeUser('admin1');
    const todayKey = getISTDateInputValue();
    const checkInTime = buildISTTimestampFromDayAndTime(todayKey, '09:00');

    const record = await AttendanceRecord.create({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      timestamp: checkInTime,
      status: 'allowed',
      rejectionReasons: [],
      latitude: office.latitude,
      longitude: office.longitude,
      accuracyMeters: 5,
      distanceMeters: 0,
      officeLatitude: office.latitude,
      officeLongitude: office.longitude,
      radiusMeters: office.radiusMeters,
      attendanceTag: 'P',
    });

    const admin = await User.findOne({ role: { $ne: 'employee' } }) || await makeUser('adm');
    const editResult = await adminEditAttendanceRecord({
      recordId: record._id.toString(),
      payload: {
        checkInTime: '09:30',
        statusCode: 'P',
        attendanceMode: 'office',
      },
      actor: admin,
      permissions: [PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM],
      auditContext: {},
    });

    check('7.3 admin edit → record updated', Boolean(editResult));
    const updated = await AttendanceRecord.findById(record._id);
    check('7.3 editHistory appended', (updated.editHistory?.length ?? 0) > 0);
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 8: Idempotency
  // ═══════════════════════════════════════════════════════════
  console.log('\nGROUP 8: Idempotency');

  {
    const office = await getOfficeSettings();
    const user = await makeUser('idem1');
    const payload = { ...geoInside(office), attendanceMode: 'office' };

    await markAttendance(user._id, 'check_in', payload);
    const second = await markAttendance(user._id, 'check_in', payload);

    check('8.1 without idempotency layer, duplicate check-in → rejected',
      second.status === 'rejected');
  }

} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await disconnectDatabase();
  await new Promise((r) => server.close(r));
}

console.log('\nATTENDANCE FLOW E2E:', passed, 'passed,', failed, 'failed');
process.exit(failed === 0 ? 0 : 1);


