/**
 * Phase 2 — Salary/LOP API integration tests (handlers + RBAC + asOfDate).
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';
import {
  getLopDetailForUser,
  listLopSummaries,
  listAllLopSummariesForMonth,
  buildLopExportWorkbook,
  lopDeductionRowsToExportRows,
  computeMonthlySalarySummary,
} from '../services/salaryService.js';
import {
  exportLopBulkHandler,
  exportLopSingleHandler,
  getLopDetailHandler,
  listLopSummariesHandler,
} from './salaryController.js';

const MONTH = '2026-06';
const AS_OF_MID = '2026-06-10';
const ABSENT_DAY = '2026-06-03';
let memoryServer;
let sequence = 0;
let employee;
let outsider;
let adminUser;
let adminPermissions;

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: null,
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.setHeader = (key, value) => {
    res.headers[key.toLowerCase()] = value;
    return res;
  };
  res.end = (buffer) => {
    res.ended = buffer;
    return res;
  };
  return res;
}

function assertForbidden(error) {
  assert.equal(error?.statusCode, 403);
  return true;
}

async function seedCheckIn(userId, dayKey, attendanceTag = null) {
  return AttendanceRecord.create({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: parseDateInputAsISTDay(dayKey),
    attendanceTag,
    latitude: 28.647284,
    longitude: 77.202835,
    accuracyMeters: 1,
    distanceMeters: 0,
    officeLatitude: 28.647284,
    officeLongitude: 77.202835,
    radiusMeters: 100,
  });
}

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    AttendanceRecord.deleteMany({}),
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);

  await Role.create({
    name: 'Admin',
    slug: 'admin',
    isSystem: true,
    permissions: Object.values(PERMISSIONS),
  });

  employee = await User.create({
    firstName: 'Lop',
    lastName: 'Employee',
    name: 'Lop Employee',
    email: `lop.employee.${sequence}@test.example`,
    mobile: `9${String(600000000 + sequence)}`,
    employeeCode: `LOPE${String(sequence).padStart(6, '0')}`,
    passwordHash: 'hash',
    role: 'employee',
    monthlySalary: 30000,
    isActive: true,
  });

  outsider = await User.create({
    firstName: 'Other',
    lastName: 'Employee',
    name: 'Other Employee',
    email: `other.employee.${sequence}@test.example`,
    mobile: `9${String(700000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    monthlySalary: 25000,
    isActive: true,
  });

  adminUser = await User.create({
    firstName: 'Admin',
    lastName: 'User',
    name: 'Admin User',
    email: `admin.${sequence}@test.example`,
    mobile: `9${String(800000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'admin',
    isActive: true,
  });
  adminPermissions = Object.values(PERMISSIONS);

  await seedCheckIn(employee._id, ABSENT_DAY);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

test('listLopSummaries returns MTD payable and LOP totals', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  for (const day of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10']) {
    await seedCheckIn(employee._id, day);
  }

  const result = await listLopSummaries({ month: MONTH, asOf: AS_OF_MID, page: 1, limit: 20 });

  assert.equal(result.month, MONTH);
  assert.equal(result.asOfDate, AS_OF_MID);
  assert.ok(result.employees.length >= 1);

  const row = result.employees.find((item) => item.userId === employee._id.toString());
  assert.ok(row, 'employee with salary appears in list');
  assert.equal(row.name, 'Lop Employee');
  assert.equal(row.totalSalary, 30000);
  assert.equal(row.totalLopDeduction, 0);
  assert.equal(row.mtdPayable, 30000);
  assert.equal(row.hasLop, false);
  assert.equal(row.asOfDate, AS_OF_MID);
  assert.ok(result.pagination.total >= 1);
});

test('listLopSummariesHandler happy path via controller', async () => {
  const res = mockRes();
  await listLopSummariesHandler(
    { query: { month: MONTH, asOf: AS_OF_MID, page: '1', limit: '20' } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.month, MONTH);
  assert.ok(Array.isArray(res.body.employees));
});

test('asOfDate excludes LOP deductions after cutoff', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  for (const day of ['2026-06-01', '2026-06-02', '2026-06-03']) {
    await seedCheckIn(employee._id, day);
  }

  const midMonth = await computeMonthlySalarySummary(employee, MONTH, { asOfDate: '2026-06-03' });
  const fullMonth = await computeMonthlySalarySummary(employee, MONTH, { asOfDate: '2026-06-30' });

  assert.ok(fullMonth.lopDeduction > midMonth.lopDeduction);
  assert.equal(fullMonth.mtdPayable, 30000 - fullMonth.lopDeduction);
  assert.equal(midMonth.mtdPayable, 30000 - midMonth.lopDeduction);
});

test('getLopDetail returns deductions only without payable total', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  // No attendance → working days in June count as absent LOP rows.

  const detail = await getLopDetailForUser(
    adminUser,
    adminPermissions,
    employee._id.toString(),
    MONTH,
    '2026-06-30',
  );

  assert.equal(detail.userId, employee._id.toString());
  assert.equal(detail.name, 'Lop Employee');
  assert.equal(detail.month, MONTH);
  assert.ok(Array.isArray(detail.deductions));
  assert.ok(detail.deductions.length >= 1);
  assert.ok(detail.deductions.every((row) => row.date && row.reason && row.amountDeducted != null));
  assert.equal(Object.hasOwn(detail, 'mtdPayable'), false);
  assert.equal(Object.hasOwn(detail, 'payableEstimate'), false);
  assert.equal(Object.hasOwn(detail, 'totalSalary'), false);
});

test('getLopDetailHandler happy path via controller', async () => {
  const res = mockRes();
  await getLopDetailHandler(
    {
      params: { userId: employee._id.toString() },
      query: { month: MONTH, asOf: '2026-06-30' },
      user: adminUser,
      userPermissions: adminPermissions,
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.deductions));
  assert.equal(Object.hasOwn(res.body, 'mtdPayable'), false);
});

test('getLopDetailForUser rejects unauthorized viewer', async () => {
  await assert.rejects(
    getLopDetailForUser(
      outsider,
      [PERMISSIONS.SALARY_READ],
      employee._id.toString(),
      MONTH,
      AS_OF_MID,
    ),
    assertForbidden,
  );
});

test('exportLopSingleHandler returns xlsx matching on-screen deductions', async () => {
  const res = mockRes();
  await exportLopSingleHandler(
    {
      params: { userId: employee._id.toString() },
      query: { month: MONTH, asOf: '2026-06-30' },
      user: adminUser,
      userPermissions: adminPermissions,
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /spreadsheetml/);
  assert.ok(Buffer.isBuffer(res.ended));

  const detail = await getLopDetailForUser(
    adminUser,
    adminPermissions,
    employee._id.toString(),
    MONTH,
    '2026-06-30',
  );
  const workbook = XLSX.read(res.ended, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);

  assert.equal(rows.length, detail.deductions.length);
  for (let index = 0; index < detail.deductions.length; index += 1) {
    assert.equal(rows[index].Date, detail.deductions[index].date);
    assert.equal(rows[index].Reason, detail.deductions[index].reason);
    assert.equal(rows[index]['Amount Deducted (INR)'], detail.deductions[index].amountDeducted);
  }
});

test('exportLopBulkHandler returns xlsx for all employees', async () => {
  const res = mockRes();
  await exportLopBulkHandler(
    {
      query: { month: MONTH, asOf: '2026-06-30' },
      user: adminUser,
      userPermissions: adminPermissions,
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(Buffer.isBuffer(res.ended));

  const summaries = await listAllLopSummariesForMonth(MONTH, '2026-06-30');
  const expectedRows = summaries.flatMap((summary) =>
    lopDeductionRowsToExportRows(summary, { bulk: true }),
  );
  const workbook = XLSX.read(res.ended, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);

  assert.equal(rows.length, expectedRows.length);
});

test('buildLopExportWorkbook produces valid empty sheet headers', () => {
  const buffer = buildLopExportWorkbook([]);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepEqual(rows[0], ['Date', 'Reason', 'Amount Deducted (INR)']);
});

async function seedZeroBalanceUnpaidLeave({ code, dayKey }) {
  const leaveType = await LeaveType.create({ code, name: `${code} Leave`, isActive: true });
  await LeavePolicy.create({
    leaveTypeId: leaveType._id,
    year: 2026,
    annualQuota: 0,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: employee._id,
    leaveTypeId: leaveType._id,
    year: 2026,
    entitled: 0,
    used: 0,
    pending: 0,
    carried: 0,
    compOffEarned: 0,
    encashed: 0,
  });
  await LeaveRequest.create({
    userId: employee._id,
    leaveTypeId: leaveType._id,
    startDate: parseDateInputAsISTDay(dayKey),
    endDate: parseDateInputAsISTDay(dayKey),
    days: 1,
    status: 'approved',
    reason: `zero balance ${code}`,
  });
  return { leaveType, dayKey };
}

test('getLopDetail includes Unpaid SL when balance was zero on apply', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  const { dayKey } = await seedZeroBalanceUnpaidLeave({ code: 'SL', dayKey: '2026-06-05' });

  const detail = await getLopDetailForUser(
    adminUser,
    adminPermissions,
    employee._id.toString(),
    MONTH,
    '2026-06-30',
  );

  const unpaidRow = detail.deductions.find((row) => row.reason === 'Unpaid SL');
  assert.ok(unpaidRow, 'expected Unpaid SL deduction row');
  assert.equal(unpaidRow.date, dayKey);
  assert.equal(unpaidRow.amountDeducted, 1000);
  assert.ok(
    !detail.deductions.some((row) => row.date === dayKey && row.reason === 'Absent'),
    'unpaid leave day must not also appear as Absent',
  );
});

test('getLopDetail includes Unpaid CL when quota exhausted', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  const clType = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
  await LeavePolicy.create({
    leaveTypeId: clType._id,
    year: 2026,
    annualQuota: 1,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: employee._id,
    leaveTypeId: clType._id,
    year: 2026,
    entitled: 1,
    used: 0,
    pending: 0,
    carried: 0,
    compOffEarned: 0,
    encashed: 0,
  });
  await LeaveRequest.create({
    userId: employee._id,
    leaveTypeId: clType._id,
    startDate: parseDateInputAsISTDay('2026-06-02'),
    endDate: parseDateInputAsISTDay('2026-06-02'),
    days: 1,
    status: 'approved',
    reason: 'paid CL',
  });
  await LeaveRequest.create({
    userId: employee._id,
    leaveTypeId: clType._id,
    startDate: parseDateInputAsISTDay('2026-06-04'),
    endDate: parseDateInputAsISTDay('2026-06-04'),
    days: 1,
    status: 'approved',
    reason: 'unpaid CL overdraw',
  });

  const detail = await getLopDetailForUser(
    adminUser,
    adminPermissions,
    employee._id.toString(),
    MONTH,
    '2026-06-30',
  );

  const unpaidRow = detail.deductions.find((row) => row.reason === 'Unpaid CL');
  assert.ok(unpaidRow);
  assert.equal(unpaidRow.date, '2026-06-04');
  assert.equal(unpaidRow.amountDeducted, 1000);
  assert.ok(!detail.deductions.some((row) => row.date === '2026-06-02'));
});

test('exportLopSingleHandler includes unpaid leave rows matching detail', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  await seedZeroBalanceUnpaidLeave({ code: 'SL', dayKey: '2026-06-08' });

  const detail = await getLopDetailForUser(
    adminUser,
    adminPermissions,
    employee._id.toString(),
    MONTH,
    '2026-06-30',
  );
  const unpaidDetail = detail.deductions.find((row) => row.reason === 'Unpaid SL');
  assert.ok(unpaidDetail);

  const res = mockRes();
  await exportLopSingleHandler(
    {
      params: { userId: employee._id.toString() },
      query: { month: MONTH, asOf: '2026-06-30' },
      user: adminUser,
      userPermissions: adminPermissions,
    },
    res,
  );

  const workbook = XLSX.read(res.ended, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);
  const exportedUnpaid = rows.find((row) => row.Reason === 'Unpaid SL' && row.Date === '2026-06-08');

  assert.ok(exportedUnpaid);
  assert.equal(exportedUnpaid['Amount Deducted (INR)'], unpaidDetail.amountDeducted);
});

test('listLopSummaries rejects invalid asOf date', async () => {
  await assert.rejects(
    listLopSummaries({ month: MONTH, asOf: '2026-13-40', page: 1, limit: 20 }),
    (error) => {
      assert.equal(error?.statusCode, 400);
      assert.match(error?.message ?? '', /as-of date/i);
      return true;
    },
  );
});
