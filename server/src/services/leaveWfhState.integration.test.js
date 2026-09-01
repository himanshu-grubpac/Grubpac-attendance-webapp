import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { Department } from '../models/Department.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest, LEAVE_REQUEST_POPULATE } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Notification } from '../models/Notification.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import {
  cancelLeaveRequest,
  consumeLeaveDecisionToken,
  dispatchSubmitNotifications,
  editLeaveRequest,
  processLeaveDecision,
  recoverPendingSubmitNotifications,
  runLeaveDecisionNotifyJob,
  undoLeaveDecision,
} from './leaveService.js';
import {
  buildISTTimestampFromDayAndTime,
  getISTDateInputValue,
  getISTYear,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
    AttendanceRecord.deleteMany({}),
    Department.deleteMany({}),
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    Notification.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

function nextDay(dayKey, days = 1) {
  const day = parseDateInputAsISTDay(dayKey);
  return getISTDateInputValue(new Date(day.getTime() + days * 24 * 60 * 60 * 1000));
}

async function createUser(name, { role = 'employee', reportingManagerId = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: '',
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `T${String(sequence).padStart(8, '0')}`,
    passwordHash: 'test-password-hash',
    role,
    reportingManagerId,
    isActive: true,
  });
}

async function createWfhFixture({ dayKey = nextDay(getISTDateInputValue(), 3), manager = null } = {}) {
  const applicant = await createUser('Applicant', {
    reportingManagerId: manager?._id ?? null,
  });
  const leaveType = await LeaveType.create({ code: 'WFH', name: 'Work From Home', isActive: true });
  const year = getISTYear(parseDateInputAsISTDay(dayKey));
  await LeavePolicy.create({
    leaveTypeId: leaveType._id,
    year,
    annualQuota: 20,
    accrualPerMonth: 0,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: applicant._id,
    leaveTypeId: leaveType._id,
    year,
    entitled: 20,
    pending: 1,
    used: 0,
    carried: 0,
    encashed: 0,
  });
  const request = await LeaveRequest.create({
    userId: applicant._id,
    leaveTypeId: leaveType._id,
    startDate: parseDateInputAsISTDay(dayKey),
    endDate: parseDateInputAsISTDay(dayKey),
    days: 1,
    reason: 'Work from home',
    status: 'pending',
    notificationsSent: false,
    submitNotificationsSent: false,
  });
  await request.populate(LEAVE_REQUEST_POPULATE);
  return { applicant, leaveType, request, year };
}

async function createAttendance({ userId, requestId = null, dayKey, time = '09:00', leaveStatus = 'pending', attendanceMode = 'wfh' }) {
  return AttendanceRecord.create({
    userId,
    type: 'check_in',
    attendanceMode,
    leaveRequestId: requestId,
    leaveStatus,
    timestamp: buildISTTimestampFromDayAndTime(dayKey, time),
    status: 'allowed',
    rejectionReasons: [],
    latitude: 28.647284,
    longitude: 77.202835,
    accuracyMeters: 1,
    distanceMeters: 0,
    officeLatitude: 28.647284,
    officeLongitude: 77.202835,
    radiusMeters: 100,
  });
}

const managerPermissions = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_READ_ALL];

test('WFH rejection clears the red marker and undo restores pending state', async () => {
  const manager = await createUser('Manager', { role: 'admin' });
  const { applicant, request } = await createWfhFixture({ manager });
  const checkIn = await createAttendance({
    userId: applicant._id,
    requestId: request._id,
    dayKey: getISTDateInputValue(request.startDate),
  });

  await processLeaveDecision(request, manager, 'reject', 'WFH is not available today.');
  let saved = await AttendanceRecord.findById(checkIn._id).lean();
  assert.equal(saved.leaveStatus, 'rejected');
  assert.equal(String(saved.leaveRequestId), String(request._id));

  await undoLeaveDecision(request._id, manager, managerPermissions);
  saved = await AttendanceRecord.findById(checkIn._id).lean();
  assert.equal(saved.leaveStatus, 'pending');
  assert.equal(String(saved.leaveRequestId), String(request._id));
});

test('pending WFH cancellation removes its red marker', async () => {
  const { applicant, request } = await createWfhFixture();
  const checkIn = await createAttendance({
    userId: applicant._id,
    requestId: request._id,
    dayKey: getISTDateInputValue(request.startDate),
  });

  await cancelLeaveRequest(request._id, applicant);
  const saved = await AttendanceRecord.findById(checkIn._id).lean();
  assert.equal(saved.leaveStatus, undefined);
  assert.equal(saved.leaveRequestId, undefined);
});

test('approved WFH undo does not recolor an unrelated unlinked check-in', async () => {
  const manager = await createUser('Manager', { role: 'admin' });
  const { applicant, request } = await createWfhFixture({ manager });
  const dayKey = getISTDateInputValue(request.startDate);
  const linked = await createAttendance({
    userId: applicant._id,
    requestId: request._id,
    dayKey,
    leaveStatus: 'pending',
  });
  const unrelated = await createAttendance({
    userId: applicant._id,
    dayKey,
    time: '10:00',
    leaveStatus: 'approved',
  });

  await processLeaveDecision(request, manager, 'approve', 'Approved.');
  await undoLeaveDecision(request._id, manager, managerPermissions);

  const linkedSaved = await AttendanceRecord.findById(linked._id).lean();
  const unrelatedSaved = await AttendanceRecord.findById(unrelated._id).lean();
  assert.equal(linkedSaved.leaveStatus, 'pending');
  assert.equal(String(linkedSaved.leaveRequestId), String(request._id));
  assert.equal(unrelatedSaved.leaveStatus, 'approved');
  assert.equal(unrelatedSaved.leaveRequestId, null);
});

test('editing a pending WFH request clears old markers and reserves the new balance', async () => {
  const { applicant, leaveType, request, year } = await createWfhFixture();
  const oldDay = getISTDateInputValue(request.startDate);
  const newDay = nextDay(oldDay);
  const checkIn = await createAttendance({
    userId: applicant._id,
    requestId: request._id,
    dayKey: oldDay,
  });

  const result = await editLeaveRequest(request._id, applicant, {
    leaveTypeId: leaveType._id,
    startDate: newDay,
    endDate: newDay,
    halfDay: null,
    reason: 'Updated WFH date',
    documentUrl: null,
  });

  const oldRecord = await AttendanceRecord.findById(checkIn._id).lean();
  const balance = await LeaveBalance.findOne({ userId: applicant._id, leaveTypeId: leaveType._id, year }).lean();
  assert.equal(oldRecord.leaveStatus, undefined);
  assert.equal(oldRecord.leaveRequestId, undefined);
  assert.equal(getISTDateInputValue(result.startDate), newDay);
  assert.equal(balance.pending, 1);
  assert.equal(result.status, 'pending');
});

test('expired pending WFH check-ins stop showing as pending', async () => {
  const oldDay = nextDay(getISTDateInputValue(), -3);
  const { applicant, request } = await createWfhFixture({ dayKey: oldDay });
  await createAttendance({
    userId: applicant._id,
    requestId: request._id,
    dayKey: oldDay,
  });

  const result = await runLeaveDecisionNotifyJob(new Date());
  const saved = await AttendanceRecord.findOne({ userId: applicant._id }).lean();
  assert.equal(result.expiredPendingWfh, 1);
  assert.equal(saved.leaveStatus, 'rejected');
});

test('undo does not cause submit-notification recovery to email the manager again', async () => {
  const manager = await createUser('Manager', { role: 'admin' });
  const { request } = await createWfhFixture({ manager });

  await dispatchSubmitNotifications(request._id);
  const before = await Notification.countDocuments({ userId: manager._id, type: 'leave.pending' });
  const decided = await LeaveRequest.findById(request._id).populate(LEAVE_REQUEST_POPULATE);
  await processLeaveDecision(decided, manager, 'approve', 'Approved.');
  await undoLeaveDecision(request._id, manager, managerPermissions);

  const recovered = await recoverPendingSubmitNotifications();
  const after = await Notification.countDocuments({ userId: manager._id, type: 'leave.pending' });
  const saved = await LeaveRequest.findById(request._id).lean();
  assert.equal(before, 1);
  assert.equal(after, 1);
  assert.equal(recovered.recovered, 0);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.submitNotificationsSent, true);
});

test('decision token consumption is atomic under concurrent use', async () => {
  const manager = await createUser('Manager', { role: 'admin' });
  const { request } = await createWfhFixture({ manager });
  const { issueLeaveDecisionToken } = await import('./leaveService.js');
  const rawToken = await issueLeaveDecisionToken(request._id, manager._id, 'approve');

  const [first, second] = await Promise.all([
    consumeLeaveDecisionToken(request._id, 'approve', rawToken),
    consumeLeaveDecisionToken(request._id, 'approve', rawToken),
  ]);
  assert.equal(Boolean(first) === Boolean(second), false);
});
