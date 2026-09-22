process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { User } from '../models/User.js';
import {
  adminUpsertAttendanceForDay,
  markAttendance,
  resolveEmployeeMonthDayStatus,
} from './attendanceService.js';
import { computeMonthlySalarySummary } from './salaryService.js';
import { getMonthlySalaryAudit } from './salaryAuditService.js';
import { getAdminReportsSummary } from './reportsService.js';
import { getISTDateInputValue } from '../utils/istDate.js';

const ADMIN_PERMS = [
  PERMISSIONS.EMPLOYEES_RECORD_R,
  PERMISSIONS.ATTENDANCE_READ_ALL,
  PERMISSIONS.ATTENDANCE_RECORD_U,
  PERMISSIONS.SALARY_AUDIT_R,
];

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
    User.deleteMany({}),
    OfficeSettings.deleteMany({}),
  ]);
  await OfficeSettings.create({
    name: 'Test Office',
    latitude: 28.6439,
    longitude: 77.20129,
    radiusMeters: 500,
    officeStartTime: '09:00',
    officeEndTime: '18:00',
    graceThresholdTime: '09:15',
    halfDayThresholdTime: '11:00',
    warningsPerQuarter: 3,
    weekendDays: [0, 6],
  });
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
    lastName: `Emp${sequence}`,
    name: `${name} Emp${sequence}`,
    email: `absent-${sequence}@example.com`,
    mobile: `9100000${String(100 + sequence)}`,
    passwordHash: 'test-hash',
    monthlySalary: 30000,
    isActive: true,
    ...fields,
  });
}

async function createAdmin() {
  return createEmployee('Admin', { role: 'admin' });
}

test('integration: admin marks today absent, LOP reflects it, employee check-in blocked', async () => {
  const todayKey = getISTDateInputValue();
  const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
  const istDay = todayDate.getUTCDay();
  if (istDay === 0 || istDay === 6) {
    return;
  }

  const admin = await createAdmin();
  const employee = await createEmployee('Worker');
  const monthKey = todayKey.slice(0, 7);

  const result = await adminUpsertAttendanceForDay({
    userId: employee._id.toString(),
    dayKey: todayKey,
    payload: { markAbsent: true, attendanceMode: 'office' },
    actor: admin,
    permissions: ADMIN_PERMS,
    auditContext: {},
  });

  assert.equal(result.adminMarkedAbsent, true);
  assert.equal(result.checkInTime, null);

  const stored = await AttendanceRecord.findById(result.checkIn._id);
  assert.equal(stored.adminMarkedAbsent, true);
  assert.equal(stored.attendanceTag, null);

  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: todayKey,
      todayKey,
      isWeekend: false,
      isHoliday: false,
      adminMarkedAbsent: true,
    }),
    'absent',
  );

  const summary = await computeMonthlySalarySummary(employee, monthKey, { asOfDate: todayKey });
  const absentRow = (summary.lopDeductionRows ?? []).find(
    (row) => row.date === todayKey && row.reason === 'Absent',
  );
  assert.ok(absentRow, 'admin-marked today absent must produce an Absent LOP row');
  assert.ok(summary.lopDeduction > 0);

  const checkInAttempt = await markAttendance(
    employee._id,
    'check_in',
    {
      deviceId: 'test-device',
      latitude: 28.6439,
      longitude: 77.20129,
      accuracyMeters: 5,
      clientTimestamp: new Date().toISOString(),
    },
    {},
  );
  assert.equal(checkInAttempt.status, 'rejected');
  assert.match(
    checkInAttempt.rejectionReasons.join(' '),
    /marked absent/i,
  );
});

test('integration: admin clears today absent by adding check-in', async () => {
  const todayKey = getISTDateInputValue();
  const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
  if (todayDate.getUTCDay() === 0 || todayDate.getUTCDay() === 6) {
    return;
  }

  const admin = await createAdmin();
  const employee = await createEmployee('Clear');
  const monthKey = todayKey.slice(0, 7);

  const marked = await adminUpsertAttendanceForDay({
    userId: employee._id.toString(),
    dayKey: todayKey,
    payload: { markAbsent: true },
    actor: admin,
    permissions: ADMIN_PERMS,
    auditContext: {},
  });

  const before = await computeMonthlySalarySummary(employee, monthKey, { asOfDate: todayKey });
  assert.ok(before.lopDeduction > 0);

  const { adminEditAttendanceRecord } = await import('./attendanceService.js');
  await adminEditAttendanceRecord({
    recordId: marked.checkIn._id.toString(),
    payload: {
      checkInTime: '09:15',
      statusCode: 'P',
      attendanceMode: 'office',
    },
    actor: admin,
    permissions: ADMIN_PERMS,
    auditContext: {},
  });

  const updated = await AttendanceRecord.findById(marked.checkIn._id);
  assert.equal(updated.adminMarkedAbsent, false);
  assert.equal(updated.attendanceTag, 'P');

  const after = await computeMonthlySalarySummary(employee, monthKey, { asOfDate: todayKey });
  assert.ok(after.lopDeduction < before.lopDeduction);
});

test('integration: monthly salary audit treats admin-marked today absent as LOP', async () => {
  const todayKey = getISTDateInputValue();
  const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
  if (todayDate.getUTCDay() === 0 || todayDate.getUTCDay() === 6) {
    return;
  }

  const admin = await createAdmin();
  const employee = await createEmployee('AuditAbsent');
  const monthKey = todayKey.slice(0, 7);

  await adminUpsertAttendanceForDay({
    userId: employee._id.toString(),
    dayKey: todayKey,
    payload: { markAbsent: true },
    actor: admin,
    permissions: ADMIN_PERMS,
    auditContext: {},
  });

  const salarySummary = await computeMonthlySalarySummary(employee, monthKey, { asOfDate: todayKey });
  assert.ok(salarySummary.lopDays > 0, 'direct salary summary must count today absent as LOP');

  const audit = await getMonthlySalaryAudit(admin, ADMIN_PERMS, monthKey);
  const row = audit.employees.find((entry) => entry.employeeId === employee._id.toString());
  assert.ok(row, 'audit must include the marked-absent employee');
  assert.equal(row.lopDays, salarySummary.lopDays);
  assert.equal(row.lopDeduction, salarySummary.lopDeduction);
});

test('integration: admin converts existing present check-in to absent and LOP updates', async () => {
  const todayKey = getISTDateInputValue();
  const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
  if (todayDate.getUTCDay() === 0 || todayDate.getUTCDay() === 6) {
    return;
  }

  const admin = await createAdmin();
  const employee = await createEmployee('PresentToAbsent');
  const monthKey = todayKey.slice(0, 7);
  const dayStart = new Date(`${todayKey}T00:00:00.000Z`);

  const checkIn = await AttendanceRecord.create({
    userId: employee._id,
    type: 'check_in',
    status: 'allowed',
    timestamp: dayStart,
    attendanceTag: 'P',
    attendanceMode: 'office',
    latitude: 28.6439,
    longitude: 77.20129,
    accuracyMeters: 5,
    distanceMeters: 0,
    officeLatitude: 28.6439,
    officeLongitude: 77.20129,
    radiusMeters: 500,
  });

  await AttendanceRecord.create({
    userId: employee._id,
    type: 'check_out',
    status: 'allowed',
    timestamp: new Date(dayStart.getTime() + 8 * 60 * 60 * 1000),
    attendanceMode: 'office',
    latitude: 28.6439,
    longitude: 77.20129,
    accuracyMeters: 5,
    distanceMeters: 0,
    officeLatitude: 28.6439,
    officeLongitude: 77.20129,
    radiusMeters: 500,
  });

  const before = await computeMonthlySalarySummary(employee, monthKey, { asOfDate: todayKey });
  const beforeAbsentRow = (before.lopDeductionRows ?? []).find(
    (row) => row.date === todayKey && row.reason === 'Absent',
  );
  assert.equal(beforeAbsentRow, undefined);

  const result = await adminUpsertAttendanceForDay({
    userId: employee._id.toString(),
    dayKey: todayKey,
    payload: { markAbsent: true, attendanceMode: 'office' },
    actor: admin,
    permissions: ADMIN_PERMS,
    auditContext: {},
  });

  assert.equal(result.adminMarkedAbsent, true);
  assert.equal(result.created, false);
  assert.equal(result.checkIn._id.toString(), checkIn._id.toString());

  const updated = await AttendanceRecord.findById(checkIn._id);
  assert.equal(updated.adminMarkedAbsent, true);
  assert.equal(updated.attendanceTag, null);

  const checkOutCount = await AttendanceRecord.countDocuments({
    userId: employee._id,
    type: 'check_out',
    timestamp: { $gte: dayStart, $lte: new Date(`${todayKey}T23:59:59.999Z`) },
  });
  assert.equal(checkOutCount, 0);

  const after = await computeMonthlySalarySummary(employee, monthKey, { asOfDate: todayKey });
  const absentRow = (after.lopDeductionRows ?? []).find(
    (row) => row.date === todayKey && row.reason === 'Absent',
  );
  assert.ok(absentRow, 'present converted to absent must produce an Absent LOP row');
  assert.ok(after.lopDeduction >= before.lopDeduction);
  assert.ok(after.lopDays >= before.lopDays);
});

test('integration: dashboard present/absent excludes admin-marked absent check-ins', async () => {
  const todayKey = getISTDateInputValue();
  const todayDate = new Date(`${todayKey}T00:00:00.000Z`);
  if (todayDate.getUTCDay() === 0 || todayDate.getUTCDay() === 6) {
    return;
  }

  const admin = await createAdmin();
  const presentEmployee = await createEmployee('Present');
  const absentEmployee = await createEmployee('MarkedAbsent');
  const dayStart = new Date(`${todayKey}T00:00:00.000Z`);

  await AttendanceRecord.create({
    userId: presentEmployee._id,
    type: 'check_in',
    status: 'allowed',
    timestamp: dayStart,
    attendanceTag: 'P',
    attendanceMode: 'office',
    latitude: 28.6439,
    longitude: 77.20129,
    accuracyMeters: 5,
    distanceMeters: 0,
    officeLatitude: 28.6439,
    officeLongitude: 77.20129,
    radiusMeters: 500,
  });

  await adminUpsertAttendanceForDay({
    userId: absentEmployee._id.toString(),
    dayKey: todayKey,
    payload: { markAbsent: true },
    actor: admin,
    permissions: ADMIN_PERMS,
    auditContext: {},
  });

  const summary = await getAdminReportsSummary(admin, ADMIN_PERMS);
  assert.equal(summary.presentToday, 1, 'admin-marked absent must not count as present');
  assert.ok(summary.absentToday >= 1, 'admin-marked absent must increase absentToday');
});
