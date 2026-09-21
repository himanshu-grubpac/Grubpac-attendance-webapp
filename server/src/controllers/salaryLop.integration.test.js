/**
 * Phase 2 — Salary/LOP API integration tests (handlers + RBAC + asOfDate).
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import {
  getISTDateInputValue,
  getISTMonthInputValue,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';
import {
  getLopDetailForUser,
  listLopSummaries,
  listAllLopSummariesForMonth,
  buildLopBulkExportWorkbook,
  buildLopDetailedExportRows,
  buildLopExportWorkbook,
  buildLopOverviewExportRows,
  formatLopReasonSummary,
  lopDeductionRowsToExportRows,
  computeMonthlySalarySummary,
  resolveSalaryAsOfDate,
  LOP_BULK_DETAILED_HEADERS,
  LOP_BULK_OVERVIEW_HEADERS,
  LOP_EXPORT_HEADERS,
  LOP_EXPORT_SHEET_HEADER_ROW,
} from '../services/salaryService.js';
import {
  exportLopBulkHandler,
  exportLopSingleHandler,
  getLopDetailHandler,
  listLopSummariesHandler,
} from './salaryController.js';

const MONTH = '2026-06';

function readLopExportSheetRows(buffer, sheetName = null) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const resolvedSheetName = sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[resolvedSheetName];
  return XLSX.utils.sheet_to_json(sheet, { range: LOP_EXPORT_SHEET_HEADER_ROW - 1 });
}

function readLopExportHeaderRow(buffer, sheetName = null) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const resolvedSheetName = sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[resolvedSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  return rows[LOP_EXPORT_SHEET_HEADER_ROW - 1];
}

function normalizeExportDateValue(value) {
  if (value == null || value === '') {
    return value;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const utcDays = Math.floor(value - 25569);
    const date = new Date(utcDays * 86400000);
    return date.toISOString().slice(0, 10);
  }
  return value;
}
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
  // Actor form for scope-aware calls: the scope helper reads roleSlug off
  // the actor (production req.user carries the resolved slug).
  adminUser = { ...adminUser.toObject(), _id: adminUser._id, roleSlug: SYSTEM_ROLE_SLUGS.ADMIN };
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

test('resolveSalaryAsOfDate — past month defaults to month-end, current month to today', () => {
  const past = resolveSalaryAsOfDate(MONTH);
  assert.equal(past.asOfDateKey, '2026-06-30');

  const currentMonth = getISTMonthInputValue();
  const current = resolveSalaryAsOfDate(currentMonth);
  assert.equal(current.asOfDateKey, getISTDateInputValue(new Date()));
});

test('listLopSummaries without asOf uses month-end for completed past months', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  for (const day of ['2026-06-01', '2026-06-02', '2026-06-03']) {
    await seedCheckIn(employee._id, day);
  }

  const withoutAsOf = await listLopSummaries({ month: MONTH, page: 1, limit: 20 });
  const withMonthEnd = await listLopSummaries({ month: MONTH, asOf: '2026-06-30', page: 1, limit: 20 });

  assert.equal(withoutAsOf.asOfDate, '2026-06-30');
  const rowDefault = withoutAsOf.employees.find((item) => item.userId === employee._id.toString());
  const rowFull = withMonthEnd.employees.find((item) => item.userId === employee._id.toString());
  assert.ok(rowDefault);
  assert.ok(rowFull);
  assert.equal(rowDefault.mtdPayable, rowFull.mtdPayable);
  assert.equal(rowDefault.totalLopDeduction, rowFull.totalLopDeduction);
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
  assert.equal(detail.joiningDate, null);
  assert.equal(detail.endingDate, null);
  assert.ok(Array.isArray(detail.deductions));
  assert.ok(detail.deductions.length >= 1);
  assert.ok(detail.deductions.every((row) => row.date && row.reason && row.amountDeducted != null));
  assert.equal(Object.hasOwn(detail, 'mtdPayable'), false);
  assert.equal(Object.hasOwn(detail, 'payableEstimate'), false);
  assert.equal(Object.hasOwn(detail, 'totalSalary'), false);
});

test('getLopDetail returns joiningDate and endingDate for employee period bounds', async () => {
  employee.joiningDate = parseDateInputAsISTDay('2026-06-15');
  employee.endingDate = parseDateInputAsISTDay('2026-08-31');
  await employee.save();

  const detail = await getLopDetailForUser(
    adminUser,
    adminPermissions,
    employee._id.toString(),
    MONTH,
    '2026-06-30',
  );

  assert.equal(detail.joiningDate, '2026-06-15');
  assert.equal(detail.endingDate, '2026-08-31');
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
  const rows = readLopExportSheetRows(res.ended);

  assert.equal(rows.length, detail.deductions.length);
  for (let index = 0; index < detail.deductions.length; index += 1) {
    assert.equal(rows[index]['Employee Name'], detail.name);
    assert.equal(rows[index].Year, 2026);
    assert.equal(rows[index].Month, 'June');
    assert.equal(normalizeExportDateValue(rows[index]['From Date']), `${MONTH}-01`);
    assert.equal(normalizeExportDateValue(rows[index]['To Date']), '2026-06-30');
    assert.equal(normalizeExportDateValue(rows[index]['Calculated as of date']), '2026-06-30');
    assert.equal(
      normalizeExportDateValue(rows[index]['Loss of pay date']),
      detail.deductions[index].date,
    );
    assert.equal(rows[index].Reason, detail.deductions[index].reason);
    assert.equal(rows[index]['Amount Deducted (INR)'], detail.deductions[index].amountDeducted);
  }
});

test('exportLopBulkHandler returns 2-sheet xlsx for all employees', async () => {
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

  const workbook = XLSX.read(res.ended, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Overview', 'Detailed']);
  assert.deepEqual(readLopExportHeaderRow(res.ended, 'Overview'), LOP_BULK_OVERVIEW_HEADERS);
  assert.deepEqual(readLopExportHeaderRow(res.ended, 'Detailed'), LOP_BULK_DETAILED_HEADERS);

  const summaries = await listAllLopSummariesForMonth(MONTH, '2026-06-30');
  const overviewRows = readLopExportSheetRows(res.ended, 'Overview');
  const detailedRows = readLopExportSheetRows(res.ended, 'Detailed');
  const expectedOverview = buildLopOverviewExportRows(summaries);
  const expectedDetailed = buildLopDetailedExportRows(summaries);

  assert.equal(overviewRows.length, summaries.length);
  assert.equal(overviewRows.length, expectedOverview.length);
  assert.equal(detailedRows.length, expectedDetailed.length);

  const expectedDeductionCount = summaries.reduce(
    (total, summary) => total + (summary.lopDeductionRows?.length ?? 0),
    0,
  );
  assert.equal(detailedRows.length, expectedDeductionCount);

  if (overviewRows.length > 0) {
    assert.ok(overviewRows[0]['Employee Name']);
    assert.ok(overviewRows[0]['Employee Code'] !== undefined);
    assert.equal(overviewRows[0].Year, 2026);
    assert.equal(overviewRows[0].Month, 'June');
    assert.equal(normalizeExportDateValue(overviewRows[0]['From Date']), `${MONTH}-01`);
    assert.equal(normalizeExportDateValue(overviewRows[0]['To Date']), '2026-06-30');
    assert.equal(normalizeExportDateValue(overviewRows[0]['Calculated as of date']), '2026-06-30');
    assert.ok(!('Loss of pay reason' in (detailedRows[0] ?? {})));
  }

  if (detailedRows.length > 0) {
    assert.ok(detailedRows[0].Reason);
    assert.equal(normalizeExportDateValue(detailedRows[0].Date), expectedDetailed[0].Date);
    assert.ok(!('Attendance credit' in detailedRows[0]));
    assert.ok(!('Paid leave (days)' in detailedRows[0]));
    assert.ok(!('Unpaid leave (days)' in detailedRows[0]));
    assert.ok(!('Working day' in detailedRows[0]));
  }
});

test('buildLopBulkExportWorkbook produces valid empty 2-sheet headers', async () => {
  const buffer = await buildLopBulkExportWorkbook([], [], { month: MONTH, asOfDate: '2026-06-30' });
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Overview', 'Detailed']);
  assert.deepEqual(readLopExportHeaderRow(buffer, 'Overview'), LOP_BULK_OVERVIEW_HEADERS);
  assert.deepEqual(readLopExportHeaderRow(buffer, 'Detailed'), LOP_BULK_DETAILED_HEADERS);
});

test('buildLopExportWorkbook produces valid empty sheet headers', async () => {
  const buffer = await buildLopExportWorkbook([]);
  assert.deepEqual(readLopExportHeaderRow(buffer), LOP_EXPORT_HEADERS);
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

  const rows = readLopExportSheetRows(res.ended);
  const exportedUnpaid = rows.find(
    (row) =>
      row.Reason === 'Unpaid SL' &&
      normalizeExportDateValue(row['Loss of pay date']) === '2026-06-08',
  );

  assert.ok(exportedUnpaid);
  assert.equal(exportedUnpaid['Amount Deducted (INR)'], unpaidDetail.amountDeducted);
});

test('formatLopReasonSummary groups deductions by reason with day counts', () => {
  const summary = formatLopReasonSummary([
    { reason: 'Absent', days: 1, amount: 1000 },
    { reason: 'Absent', days: 1, amount: 1000 },
    { reason: 'Half day', days: 0.5, amount: 500 },
    { reason: 'Unpaid CL', days: 0.5, amount: 500 },
  ]);
  assert.equal(summary, 'Absent (2 days); Half day (0.5 days); Unpaid CL (0.5 days)');
});

test('buildLopOverviewExportRows uses English month and summarized reasons', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  await seedCheckIn(employee._id, '2026-06-02');
  await seedCheckIn(employee._id, '2026-06-04', 'HD');

  const summary = await computeMonthlySalarySummary(employee, MONTH, { asOfDate: '2026-06-30' });
  const [overviewRow] = buildLopOverviewExportRows([summary]);

  assert.equal(overviewRow.Year, 2026);
  assert.equal(overviewRow.Month, 'June');
  assert.equal(overviewRow['From Date'], `${MONTH}-01`);
  assert.equal(overviewRow['To Date'], '2026-06-30');
  assert.equal(overviewRow['Calculated as of date'], '2026-06-30');
  assert.match(overviewRow['Loss of pay reason'], /Absent \(\d+ days\)/);
  assert.match(overviewRow['Loss of pay reason'], /Half day \(0\.5 days\)/);
  assert.doesNotMatch(overviewRow['Loss of pay reason'], /Absent; Half day/);
});

test('computeMonthlySalarySummary treats LV check-in as half day LOP', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  await seedCheckIn(employee._id, '2026-06-02');
  await seedCheckIn(employee._id, '2026-06-04', 'LV');

  const summary = await computeMonthlySalarySummary(employee, MONTH, { asOfDate: '2026-06-30' });
  const lvRow = summary.lopDeductionRows.find((row) => row.date === '2026-06-04');

  assert.ok(lvRow);
  assert.equal(lvRow.reason, 'Half day');
  assert.equal(lvRow.days, 0.5);
  assert.equal(lvRow.category, 'half_day');
});

test('buildLopDetailedExportRows emits one row per deduction with reason', async () => {
  await AttendanceRecord.deleteMany({ userId: employee._id });
  await seedCheckIn(employee._id, '2026-06-02');
  await seedCheckIn(employee._id, '2026-06-04', 'HD');

  const summary = await computeMonthlySalarySummary(employee, MONTH, {
    asOfDate: '2026-06-30',
  });
  const detailedRows = buildLopDetailedExportRows([summary]);

  assert.equal(detailedRows.length, summary.lopDeductionRows.length);
  assert.ok(detailedRows.every((row) => row.Reason));
  assert.ok(detailedRows.some((row) => row.Reason === 'Half day'));
  assert.ok(detailedRows.some((row) => row.Reason === 'Absent'));
  assert.equal(detailedRows[0].Month, 'June');
  assert.match(detailedRows[0].Date, /^\d{4}-\d{2}-\d{2}$/);
});

test('lopDeductionRowsToExportRows keeps ISO date keys before Excel write', async () => {
  const summary = await computeMonthlySalarySummary(employee, MONTH, { asOfDate: '2026-06-30' });
  const exportRows = lopDeductionRowsToExportRows(summary);

  assert.ok(exportRows.length >= 1);
  assert.equal(exportRows[0].Year, 2026);
  assert.equal(exportRows[0].Month, 'June');
  assert.equal(exportRows[0]['From Date'], `${MONTH}-01`);
  assert.equal(exportRows[0]['To Date'], '2026-06-30');
  assert.match(exportRows[0]['Calculated as of date'], /^\d{4}-\d{2}-\d{2}$/);
  assert.match(exportRows[0]['Loss of pay date'], /^\d{4}-\d{2}-\d{2}$/);
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
