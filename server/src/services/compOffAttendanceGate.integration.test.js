// Pin test mode (see compOff.integration.test.js): without this, email/SMS
// assertions bypass the outbox seams and hit real providers.
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { CompOffRequest } from '../models/CompOffRequest.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Notification } from '../models/Notification.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { Role } from '../models/Role.js';
import { UndoAction } from '../models/UndoAction.js';
import { User } from '../models/User.js';
import { markAttendance } from './attendanceService.js';
import { assessCompOffWork, decideCompOffRequest, createCompOffRequest, runCompOffSweep } from './compOffService.js';
import { clearTestEmailOutbox, testEmailOutbox } from './emailService.js';
import { clearTestSmsOutbox, testSmsOutbox } from './smsService.js';
import { seedLeaveTypesAndPolicies } from './leaveBalanceService.js';
import {
  endOfDayIST,
  getISTDateInputValue,
  getISTMonth,
  getISTWeekday,
  getISTYear,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';

const MANAGER_PERMS = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_READ];
const OFFICE = { latitude: 28.647284, longitude: 77.202835, radiusMeters: 100, maxAccuracyMeters: 100 };
const FUTURE = new Date(Date.now() + 60_000);

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence = 0;
  clearTestEmailOutbox();
  clearTestSmsOutbox();
  await Promise.all([
    AttendanceRecord.deleteMany({}),
    CompOffRequest.deleteMany({}),
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    Notification.deleteMany({}),
    OfficeSettings.deleteMany({}),
    Role.deleteMany({}),
    UndoAction.deleteMany({}),
    User.deleteMany({}),
  ]);
  await seedLeaveTypesAndPolicies();
});

after(async () => {
  const { closeEmailTransport } = await import('./emailService.js');
  closeEmailTransport();
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser(name, { reportingManagerId = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: '',
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `T${String(sequence).padStart(8, '0')}`,
    passwordHash: 'test-password-hash',
    role: reportingManagerId ? 'admin' : 'employee',
    reportingManagerId,
    isActive: true,
  });
}

/** Makes TODAY a "weekend" by configuring office weekendDays to include today. */
async function makeTodayAWeekend(overrides = {}) {
  const todayDow = getISTWeekday();
  const base = {
    ...OFFICE,
    name: 'Test Office',
    officeStartTime: '00:00',
    officeEndTime: '23:59',
    graceThresholdTime: '23:59',
    halfDayThresholdTime: '23:59',
    warningsPerQuarter: 3,
    weekendDays: [todayDow],
  };
  return OfficeSettings.create({ ...base, ...overrides });
}

function todayKey() {
  return getISTDateInputValue();
}

function geoPayload(overrides = {}) {
  return {
    latitude: OFFICE.latitude,
    longitude: OFFICE.longitude,
    accuracyMeters: 5,
    clientTimestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function createApprovedCompOffToday(employee, manager) {
  const created = await createCompOffRequest(employee._id, {
    startDate: todayKey(),
    endDate: todayKey(),
    reason: 'Working today for comp off',
  });
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  return CompOffRequest.findById(created.id).lean();
}

test('weekend check-in without comp-off approval is rejected with the generic gate message', async () => {
  await makeTodayAWeekend();
  const employee = await createUser('Weekend Worker');

  const result = await markAttendance(employee._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(result.status, 'rejected');
  assert.ok(
    result.rejectionReasons.includes('Comp off approval is required to mark attendance on weekends/holidays.'),
    `reasons: ${result.rejectionReasons.join(' | ')}`,
  );
});

test('weekend check-in with a PENDING comp-off request shows the pending message', async () => {
  await makeTodayAWeekend();
  const manager = await createUser('Manager');
  const employee = await createUser('Pending Worker', { reportingManagerId: manager._id });
  await createCompOffRequest(employee._id, {
    startDate: todayKey(),
    endDate: todayKey(),
    reason: 'Pending comp off for today',
  });

  const result = await markAttendance(employee._id, 'check_in', geoPayload({ attendanceMode: 'wfh' }), {});
  assert.equal(result.status, 'rejected');
  assert.ok(result.rejectionReasons.includes('Your comp off request for this day is pending approval.'));
});

test('weekend check-in with APPROVED comp-off is allowed in office AND wfh modes', async () => {
  await makeTodayAWeekend();
  const manager = await createUser('Manager');
  const officeEmployee = await createUser('Office Comp Off', { reportingManagerId: manager._id });
  const wfhEmployee = await createUser('Wfh Comp Off', { reportingManagerId: manager._id });
  await createApprovedCompOffToday(officeEmployee, manager);
  await createApprovedCompOffToday(wfhEmployee, manager);

  const officeIn = await markAttendance(officeEmployee._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(officeIn.status, 'allowed', officeIn.rejectionReasons?.join(' | '));

  const wfhIn = await markAttendance(wfhEmployee._id, 'check_in', geoPayload({ attendanceMode: 'wfh' }), {});
  assert.equal(wfhIn.status, 'allowed', wfhIn.rejectionReasons?.join(' | '));
});

test('weekday check-in is unaffected when the office weekend set excludes today', async () => {
  const todayDow = getISTWeekday();
  await makeTodayAWeekend({ ...OFFICE, weekendDays: [(todayDow + 1) % 7] });
  const employee = await createUser('Plain Weekday');
  const result = await markAttendance(employee._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(result.status, 'allowed', result.rejectionReasons?.join(' | '));
});

test('approved comp-off day: check-out flips request to worked + manager in-app notice, NO email', async () => {
  await makeTodayAWeekend();
  const manager = await createUser('Manager');
  const employee = await createUser('Comp Off Worker', { reportingManagerId: manager._id });
  await createApprovedCompOffToday(employee, manager);
  // Submit + approval notifications already went out; the checkout must add
  // none to the outboxes.
  const emailCountBefore = testEmailOutbox.length;
  const smsCountBefore = testSmsOutbox.length;

  const checkIn = await markAttendance(employee._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(checkIn.status, 'allowed');
  assert.equal(testEmailOutbox.length, emailCountBefore, 'check-in emits no email');

  const checkOut = await markAttendance(employee._id, 'check_out', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(checkOut.status, 'allowed');

  const request = await CompOffRequest.findOne({ userId: employee._id }).lean();
  assert.equal(request.status, 'worked', 'checkout flips request to worked');
  assert.ok(request.checkoutRecordId, 'checkout record linked');
  assert.equal(await Notification.countDocuments({ type: 'comp_off_assess' }), 1, 'manager in-app notice');
  assert.equal(testEmailOutbox.length, emailCountBefore, 'checkout emits NO email');
  assert.equal(testSmsOutbox.length, smsCountBefore, 'checkout emits NO sms');
});

test('check-out on a comp-off day without a check-in is unchanged (existing attendance error)', async () => {
  await makeTodayAWeekend();
  const manager = await createUser('Manager');
  const employee = await createUser('No Checkin', { reportingManagerId: manager._id });
  await createApprovedCompOffToday(employee, manager);

  const result = await markAttendance(employee._id, 'check_out', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(result.status, 'rejected');
  assert.ok(result.rejectionReasons.some((r) => /check-in is required/i.test(r)));
  const request = await CompOffRequest.findOne({ userId: employee._id }).lean();
  assert.equal(request.status, 'approved', 'no status change without check-in');
});

test('rejected/lapsed comp-off still gates a weekend check-in', async () => {
  await makeTodayAWeekend();
  const manager = await createUser('Manager');
  const employee = await createUser('Gated Worker', { reportingManagerId: manager._id });
  const created = await createCompOffRequest(employee._id, {
    startDate: todayKey(),
    endDate: todayKey(),
    reason: 'Will be rejected',
  });
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'reject', { comment: 'No.' });
  await runCompOffSweep(FUTURE);

  const result = await markAttendance(employee._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(result.status, 'rejected');
  assert.ok(result.rejectionReasons.includes('Comp off approval is required to mark attendance on weekends/holidays.'));
});

test('approved comp-off on an active-holiday weekday also opens the gate', async () => {
  // Mark today as a working weekday (excluded from weekendDays) but create an
  // active holiday covering today — comp-off eligibility + gate must honor it.
  const todayDow = getISTWeekday();
  await makeTodayAWeekend({ ...OFFICE, weekendDays: [(todayDow + 1) % 7] });
  const holidayDate = parseDateInputAsISTDay(todayKey());
  const { Holiday } = await import('../models/Holiday.js');
  await Holiday.create({ date: holidayDate, name: 'Test Holiday', isActive: true });
  const manager = await createUser('Manager');
  const noApproval = await createUser('Holiday No Approval');
  const blocked = await markAttendance(noApproval._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(blocked.status, 'rejected');
  assert.ok(blocked.rejectionReasons.includes('Comp off approval is required to mark attendance on weekends/holidays.'));

  const approvedEmployee = await createUser('Holiday Approved', { reportingManagerId: manager._id });
  const created = await createCompOffRequest(approvedEmployee._id, {
    startDate: todayKey(),
    endDate: todayKey(),
    reason: 'Working the holiday',
  });
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  const allowed = await markAttendance(approvedEmployee._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(allowed.status, 'allowed', allowed.rejectionReasons?.join(' | '));
});

test('end-to-end: submit → approve → real check-in/out → assess → credit + mails', async () => {
  await makeTodayAWeekend();
  const manager = await createUser('Manager');
  const employee = await createUser('E2E Worker', { reportingManagerId: manager._id });

  const created = await createCompOffRequest(employee._id, {
    startDate: todayKey(),
    endDate: todayKey(),
    reason: 'End-to-end comp off coverage',
  });
  await runCompOffSweep(FUTURE);
  assert.equal(
    testEmailOutbox.filter((m) => m.tag === 'comp-off-manager').length,
    1,
    'manager notified once after submit finalize',
  );

  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  assert.equal(
    testEmailOutbox.filter((m) => m.tag === 'comp-off-status').length,
    1,
    'employee notified once after approve finalize',
  );

  const checkIn = await markAttendance(employee._id, 'check_in', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(checkIn.status, 'allowed', checkIn.rejectionReasons?.join(' | '));
  const checkOut = await markAttendance(employee._id, 'check_out', geoPayload({ attendanceMode: 'office' }), {});
  assert.equal(checkOut.status, 'allowed', checkOut.rejectionReasons?.join(' | '));

  const worked = await CompOffRequest.findById(created.id).lean();
  assert.equal(worked.status, 'worked');
  assert.ok(worked.checkoutRecordId, 'checkout record linked on the credited path');

  await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', { comment: 'Well done.' });
  await runCompOffSweep(FUTURE);

  const final = await CompOffRequest.findById(created.id).lean();
  assert.equal(final.status, 'assessed');
  assert.equal(final.creditedDays, 1);
  const coType = await LeaveType.findOne({ code: 'CO' });
  const year = getISTYear(parseDateInputAsISTDay(todayKey()));
  const balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id, year }).lean();
  assert.ok(balance, 'CO balance exists after credit');
  assert.equal(balance.compOffEarned, 1, 'credit posted once to the worked year');
  assert.equal(
    testEmailOutbox.filter((m) => m.tag === 'comp-off-assessed').length,
    1,
    'employee notified once about the credit',
  );
});

test('comp-off gate helpers tolerate year/month boundaries (sanity)', () => {
  assert.equal(typeof getISTYear(new Date()), 'number');
  assert.equal(typeof getISTMonth(new Date()), 'number');
  const dayStart = endOfDayIST(new Date());
  assert.ok(dayStart instanceof Date);
});
