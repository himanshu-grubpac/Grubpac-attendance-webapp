import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS, hasPermission } from '../../../shared/permissions.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { Role } from '../models/Role.js';
import { SalarySettings } from '../models/SalarySettings.js';
import { SALARY_TRANSFER_STATUS, SalaryTransfer } from '../models/SalaryTransfer.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { getHolidayDateSet } from './leaveService.js';
import {
  countWorkingDaysIST,
  getISTDateInputValue,
  getISTYear,
  listWorkingDaysIST,
  parseMonthInputAsISTRange,
} from '../utils/istDate.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function salaryAppliesForMonth(user, monthEnd) {
  if (user.monthlySalary == null || user.monthlySalary <= 0) {
    return false;
  }
  if (!user.salaryEffectiveFrom) {
    return true;
  }
  return user.salaryEffectiveFrom <= monthEnd;
}

async function loadAttendanceCreditByDay(userId, monthStart, monthEnd) {
  const records = await AttendanceRecord.find({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: monthStart, $lte: monthEnd },
  }).select('timestamp attendanceTag');

  const creditByDay = new Map();
  for (const record of records) {
    const dayKey = getISTDateInputValue(record.timestamp);
    const credit = record.attendanceTag === 'HD' ? 0.5 : 1;
    // A day can only have one allowed check-in, but retaining the highest credit
    // keeps historic/duplicate records from creating an accidental deduction.
    creditByDay.set(dayKey, Math.max(creditByDay.get(dayKey) ?? 0, credit));
  }
  return creditByDay;
}

async function loadPaidLeaveTypeIds(year = getISTYear()) {
  const policies = await LeavePolicy.find({ isActive: true, paid: true, year }).select('leaveTypeId');
  return new Set(policies.map((policy) => policy.leaveTypeId.toString()));
}

/**
 * Paid leave days overlapping a salary month (total for display).
 * Uses stored request.days (half-day, sandwich, etc.) and prorates when the request spans month boundaries.
 */
function countPaidLeaveDaysInMonth(request, monthStart, monthEnd, holidayDates) {
  const overlapStart = request.startDate > monthStart ? request.startDate : monthStart;
  const overlapEnd = request.endDate < monthEnd ? request.endDate : monthEnd;
  if (overlapEnd < overlapStart) {
    return 0;
  }

  const totalWorkingDays = countWorkingDaysIST(
    request.startDate,
    request.endDate,
    holidayDates,
  );
  if (totalWorkingDays === 0) {
    return 0;
  }

  const overlapWorkingDays = countWorkingDaysIST(overlapStart, overlapEnd, holidayDates);
  if (overlapWorkingDays === 0) {
    return 0;
  }

  // request.days is authoritative (0.5 for half-day, sandwich-adjusted totals, etc.)
  return (request.days * overlapWorkingDays) / totalWorkingDays;
}

async function sumPaidLeaveDays(userId, monthStart, monthEnd, holidayDates) {
  const paidTypeIds = await loadPaidLeaveTypeIds(getISTYear(monthStart));
  if (paidTypeIds.size === 0) {
    return 0;
  }

  const requests = await LeaveRequest.find({
    userId,
    status: 'approved',
    startDate: { $lte: monthEnd },
    endDate: { $gte: monthStart },
  }).select('leaveTypeId startDate endDate days halfDay');

  let total = 0;
  for (const request of requests) {
    if (!paidTypeIds.has(request.leaveTypeId.toString())) {
      continue;
    }
    total += countPaidLeaveDaysInMonth(request, monthStart, monthEnd, holidayDates);
  }
  return roundMoney(total);
}

/**
 * Distributes paid leave fractions across IST working days (for per-day payable cap).
 */
export function buildPaidLeaveDayMap(requests, monthStart, monthEnd, holidayDates, paidTypeIds) {
  const dayMap = new Map();

  for (const request of requests) {
    if (!paidTypeIds.has(request.leaveTypeId.toString())) {
      continue;
    }

    const overlapStart = request.startDate > monthStart ? request.startDate : monthStart;
    const overlapEnd = request.endDate < monthEnd ? request.endDate : monthEnd;
    if (overlapEnd < overlapStart) {
      continue;
    }

    const totalWorkingDays = countWorkingDaysIST(
      request.startDate,
      request.endDate,
      holidayDates,
    );
    if (totalWorkingDays === 0) {
      continue;
    }

    const overlapWorkingDayList = listWorkingDaysIST(overlapStart, overlapEnd, holidayDates);
    if (overlapWorkingDayList.length === 0) {
      continue;
    }

    const leaveInOverlap =
      (request.days * overlapWorkingDayList.length) / totalWorkingDays;
    const perDay = leaveInOverlap / overlapWorkingDayList.length;

    for (const day of overlapWorkingDayList) {
      const key = typeof day === 'string' ? day : getISTDateInputValue(day);
      dayMap.set(key, (dayMap.get(key) ?? 0) + perDay);
    }
  }

  return dayMap;
}

/** Caps payable credit at 1.0 per working calendar day (prevents half-day leave + present double-count). */
export function computeDailyCappedPayableDays(workingDayList, attendanceCreditByDay, paidLeaveByDay) {
  let total = 0;
  for (const day of workingDayList) {
    const dayKey = typeof day === 'string' ? day : getISTDateInputValue(day);
    const attendance = attendanceCreditByDay instanceof Set
      ? (attendanceCreditByDay.has(dayKey) ? 1 : 0)
      : (attendanceCreditByDay.get(dayKey) ?? 0);
    const leave = paidLeaveByDay.get(dayKey) ?? 0;
    total += Math.min(1, attendance + leave);
  }
  return roundMoney(total);
}

/**
 * Monthly salary impact (v1 — estimate only, not payroll).
 *
 * workingDaysInMonth = Mon–Fri in the IST month minus company holidays.
 * presentDays        = attendance credit: 1.0 for Present and 0.5 for Half Day.
 * paidLeaveDays      = approved paid leave working-days overlapping the month.
 * lopDays            = max(0, workingDaysInMonth − presentDays − paidLeaveDays).
 * payableDays        = presentDays + paidLeaveDays (capped at workingDaysInMonth).
 * perDaySalary       = monthlySalary / workingDaysInMonth (handbook encashment basis).
 * payableEstimate    = monthlySalary × (payableDays / workingDaysInMonth).
 */
export async function computeMonthlySalarySummary(user, monthInput) {
  const range = parseMonthInputAsISTRange(monthInput);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const { year, monthKey, start, end } = range;
  const holidayDates = await getHolidayDateSet(year);
  const workingDayList = listWorkingDaysIST(start, end, holidayDates);
  const workingDaysInMonth = workingDayList.length;

  const paidTypeIds = await loadPaidLeaveTypeIds(year);
  const paidLeaveRequests = await LeaveRequest.find({
    userId: user._id,
    status: 'approved',
    startDate: { $lte: end },
    endDate: { $gte: start },
  }).select('leaveTypeId startDate endDate days halfDay');

  const [attendanceCreditByDay, paidLeaveDays] = await Promise.all([
    loadAttendanceCreditByDay(user._id, start, end),
    sumPaidLeaveDays(user._id, start, end, holidayDates),
  ]);

  const presentDays = roundMoney(
    workingDayList.reduce((total, day) => total + (attendanceCreditByDay.get(day) ?? 0), 0),
  );
  const paidLeaveByDay = buildPaidLeaveDayMap(
    paidLeaveRequests,
    start,
    end,
    holidayDates,
    paidTypeIds,
  );
  const payableDays = computeDailyCappedPayableDays(
    workingDayList,
    attendanceCreditByDay,
    paidLeaveByDay,
  );
  const lopDays = Math.max(0, workingDaysInMonth - payableDays);

  const hasSalary = salaryAppliesForMonth(user, end);
  const monthlySalary = hasSalary ? user.monthlySalary : null;

  let perDaySalary = null;
  let payableEstimate = null;
  if (monthlySalary != null && workingDaysInMonth > 0) {
    perDaySalary = roundMoney(monthlySalary / workingDaysInMonth);
    payableEstimate = roundMoney(monthlySalary * (payableDays / workingDaysInMonth));
  }

  return {
    month: monthKey,
    currency: 'INR',
    userId: user._id.toString(),
    userName: user.name,
    employeeCode: user.employeeCode ?? null,
    monthlySalary,
    salaryEffectiveFrom: user.salaryEffectiveFrom ?? null,
    workingDaysInMonth,
    presentDays,
    paidLeaveDays,
    payableDays,
    lopDays,
    perDaySalary,
    payableEstimate,
    hasSalaryConfigured: monthlySalary != null,
  };
}

export async function loadSalarySubject(userId) {
  if (!mongoose.isValidObjectId(userId)) {
    throwError('Employee not found.', 404);
  }
  const user = await User.findById(userId).populate(USER_POPULATE_FIELDS);
  if (!user || !user.isActive) {
    throwError('Employee not found.', 404);
  }
  return user;
}

export function canViewSalarySummary(actor, subject, permissions) {
  const actorId = actor._id.toString();
  const subjectId = subject._id.toString();

  if (actorId === subjectId) {
    return hasPermission(permissions, PERMISSIONS.SALARY_READ);
  }

  if (
    hasPermission(permissions, PERMISSIONS.SALARY_READ) &&
    (hasPermission(permissions, PERMISSIONS.USERS_READ) ||
      hasPermission(permissions, PERMISSIONS.USERS_WRITE))
  ) {
    return true;
  }

  if (hasPermission(permissions, PERMISSIONS.SALARY_READ_TEAM)) {
    const managerId =
      subject.reportingManagerId?._id?.toString() ??
      subject.reportingManagerId?.toString?.() ??
      null;
    if (managerId === actorId) {
      return true;
    }

    const subjectDept =
      subject.departmentId?._id?.toString?.() ??
      subject.departmentId?.toString?.() ??
      null;
    if (Array.isArray(actor.managedDepartmentIds) && actor.managedDepartmentIds.length > 0) {
      return actor.managedDepartmentIds.some((id) => id.toString() === subjectDept);
    }
    return false;
  }

  return false;
}

export async function getSalarySummaryForUser(actor, permissions, userId, month) {
  const subject = await loadSalarySubject(userId);
  if (!canViewSalarySummary(actor, subject, permissions)) {
    throwError('You do not have permission to view this salary summary.', 403);
  }
  const summary = await computeMonthlySalarySummary(subject, month);
  return { summary };
}

export async function listSalarySummariesForMonth(month) {
  const range = parseMonthInputAsISTRange(month);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const employees = await User.find({ isActive: true, monthlySalary: { $ne: null, $gt: 0 } })
    .select('name employeeCode monthlySalary salaryEffectiveFrom')
    .sort({ name: 1 });

  const summaries = [];
  for (const employee of employees) {
    if (!salaryAppliesForMonth(employee, range.end)) {
      continue;
    }
    summaries.push(await computeMonthlySalarySummary(employee, month));
  }
  return summaries;
}

/** Clamp payroll day to the last day of the target month (handles short months). */
function clampPayrollDay(year, month, payrollDayOfMonth) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(payrollDayOfMonth, lastDay);
}

/**
 * Next scheduled payroll date (IST YYYY-MM-DD) from payrollDayOfMonth.
 * Returns null when payroll day is not configured.
 */
export function computeNextPayrollDateIst(payrollDayOfMonth, referenceDate = new Date()) {
  if (payrollDayOfMonth == null || payrollDayOfMonth < 1 || payrollDayOfMonth > 28) {
    return null;
  }

  const todayKey = getISTDateInputValue(referenceDate);
  const [year, month, day] = todayKey.split('-').map(Number);
  const thisMonthDay = clampPayrollDay(year, month, payrollDayOfMonth);
  const thisMonthKey = `${year}-${String(month).padStart(2, '0')}-${String(thisMonthDay).padStart(2, '0')}`;

  if (day <= thisMonthDay) {
    return thisMonthKey;
  }

  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  const nextDay = clampPayrollDay(nextYear, nextMonth, payrollDayOfMonth);
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
}

export function computeSalaryTransferStatsFromRows(rows) {
  let pendingCount = 0;
  let paidCount = 0;
  let failedCount = 0;
  let totalPendingAmount = 0;

  for (const row of rows) {
    if (row.status === SALARY_TRANSFER_STATUS.PENDING) {
      pendingCount += 1;
      totalPendingAmount += row.amount;
    } else if (row.status === SALARY_TRANSFER_STATUS.PAID) {
      paidCount += 1;
    } else if (row.status === SALARY_TRANSFER_STATUS.FAILED) {
      failedCount += 1;
    }
  }

  return {
    pendingCount,
    paidCount,
    failedCount,
    totalPendingAmount: roundMoney(totalPendingAmount),
    totalCount: rows.length,
  };
}

export async function getSalaryTransferStats(periodKey) {
  const rows = await SalaryTransfer.find({ periodKey }).select('status amount');
  return computeSalaryTransferStatsFromRows(rows);
}

function salaryTransferToJSON(transfer) {
  const user = transfer.userId;
  const userId = user?._id?.toString?.() ?? transfer.userId?.toString?.() ?? null;

  return {
    id: transfer._id.toString(),
    userId,
    userName: user?.name ?? null,
    employeeCode: user?.employeeCode ?? null,
    periodKey: transfer.periodKey,
    amount: transfer.amount,
    currency: transfer.currency ?? 'INR',
    status: transfer.status,
    note: transfer.note ?? null,
    failureReason: transfer.failureReason ?? null,
    paidAt: transfer.paidAt ?? null,
    createdAt: transfer.createdAt ?? null,
    updatedAt: transfer.updatedAt ?? null,
  };
}

export async function listSalaryTransfers({ month, status, page = 1, limit = 20 }) {
  const range = parseMonthInputAsISTRange(month);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const query = { periodKey: month };
  if (status) {
    query.status = status;
  }

  const skip = (page - 1) * limit;

  const [transfers, total, stats] = await Promise.all([
    SalaryTransfer.find(query)
      .populate('userId', 'name employeeCode')
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    SalaryTransfer.countDocuments(query),
    getSalaryTransferStats(month),
  ]);

  return {
    month,
    transfers: transfers.map(salaryTransferToJSON),
    stats,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

export async function generatePendingSalaryTransfers(month, actorId) {
  const range = parseMonthInputAsISTRange(month);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const summaries = await listSalarySummariesForMonth(month);
  const eligible = summaries.filter(
    (item) => item.payableEstimate != null || item.monthlySalary != null,
  );

  if (eligible.length === 0) {
    return { created: 0, skipped: 0, totalEligible: 0 };
  }

  const existing = await SalaryTransfer.find({ periodKey: month }).select('userId');
  const existingIds = new Set(existing.map((row) => row.userId.toString()));

  const toCreate = [];
  for (const summary of eligible) {
    if (existingIds.has(summary.userId)) {
      continue;
    }
    const amount = summary.payableEstimate ?? summary.monthlySalary ?? 0;
    toCreate.push({
      userId: summary.userId,
      periodKey: month,
      amount: roundMoney(amount),
      currency: 'INR',
      status: SALARY_TRANSFER_STATUS.PENDING,
      createdBy: actorId,
    });
  }

  if (toCreate.length > 0) {
    await SalaryTransfer.insertMany(toCreate, { ordered: false });
  }

  return {
    created: toCreate.length,
    skipped: eligible.length - toCreate.length,
    totalEligible: eligible.length,
  };
}

export async function updateSalaryTransferStatus(transferId, payload, actorId) {
  if (!mongoose.isValidObjectId(transferId)) {
    throwError('Transfer not found.', 404);
  }

  const transfer = await SalaryTransfer.findById(transferId).populate('userId', 'name employeeCode');
  if (!transfer) {
    throwError('Transfer not found.', 404);
  }

  transfer.status = payload.status;
  transfer.updatedBy = actorId;

  if (payload.note !== undefined) {
    transfer.note = payload.note || null;
  }

  if (payload.status === SALARY_TRANSFER_STATUS.FAILED) {
    transfer.failureReason =
      payload.failureReason !== undefined ? payload.failureReason || null : transfer.failureReason;
    transfer.paidAt = null;
  } else if (payload.status === SALARY_TRANSFER_STATUS.PAID) {
    transfer.paidAt = new Date();
    transfer.failureReason = null;
  } else if (payload.status === SALARY_TRANSFER_STATUS.PENDING) {
    transfer.paidAt = null;
    if (payload.failureReason !== undefined) {
      transfer.failureReason = payload.failureReason || null;
    }
  }

  await transfer.save();
  return salaryTransferToJSON(transfer);
}

export async function getOrCreateSalarySettings() {
  let settings = await SalarySettings.findOne().sort({ updatedAt: -1 });
  if (!settings) {
    settings = await SalarySettings.create({});
  }
  return settings;
}

export function salarySettingsToJSON(settings) {
  return {
    payrollDayOfMonth: settings.payrollDayOfMonth ?? null,
    nextPayrollDate: computeNextPayrollDateIst(settings.payrollDayOfMonth),
    updatedAt: settings.updatedAt ?? null,
  };
}

export async function getSalarySettingsPayload() {
  const settings = await getOrCreateSalarySettings();
  const currentMonth = getISTDateInputValue(new Date()).slice(0, 7);
  const transferStats = await getSalaryTransferStats(currentMonth);

  return {
    settings: salarySettingsToJSON(settings),
    transferStats: {
      month: currentMonth,
      pendingCount: transferStats.pendingCount,
    },
  };
}

export async function updateSalarySettings(payload, actorId) {
  const settings = await getOrCreateSalarySettings();

  if (payload.payrollDayOfMonth !== undefined) {
    settings.payrollDayOfMonth = payload.payrollDayOfMonth;
  }
  settings.updatedBy = actorId;
  await settings.save();

  return { settings: salarySettingsToJSON(settings) };
}

export async function buildSalaryMonthMeta(month, summaries) {
  const configuredCount = await User.countDocuments({
    isActive: true,
    monthlySalary: { $ne: null, $gt: 0 },
  });

  const withEstimate = summaries.filter((item) => item.payableEstimate != null);
  const totalPayroll = withEstimate.reduce((sum, item) => sum + item.payableEstimate, 0);
  const settings = await getOrCreateSalarySettings();
  const transferStats = await getSalaryTransferStats(month);

  return {
    totalPayroll: roundMoney(totalPayroll),
    employeesWithEstimate: withEstimate.length,
    employeesConfigured: configuredCount,
    pendingTransfers: transferStats.pendingCount,
    nextPayrollDate: computeNextPayrollDateIst(settings.payrollDayOfMonth),
    payrollDayOfMonth: settings.payrollDayOfMonth ?? null,
  };
}

async function buildSalaryStructureQuery(search) {
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  const query = { isActive: true };
  if (adminRole) {
    query.roleId = { $ne: adminRole._id };
  } else {
    query.role = { $ne: 'admin' };
  }

  const trimmed = search?.trim();
  if (trimmed) {
    const regex = new RegExp(escapeRegex(trimmed), 'i');
    query.$or = [{ name: regex }, { employeeCode: regex }, { email: regex }];
  }

  return query;
}

export async function listSalaryStructure({ page = 1, limit = 20, search = '' }) {
  const query = await buildSalaryStructureQuery(search);
  const skip = (page - 1) * limit;

  const [employees, total] = await Promise.all([
    User.find(query)
      .select('name employeeCode department designation monthlySalary salaryEffectiveFrom')
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  return {
    employees: employees.map((employee) => ({
      id: employee._id.toString(),
      name: employee.name,
      employeeCode: employee.employeeCode ?? null,
      department: employee.department ?? null,
      designation: employee.designation ?? null,
      monthlySalary: employee.monthlySalary ?? null,
      salaryEffectiveFrom: employee.salaryEffectiveFrom ?? null,
      salaryCurrency: 'INR',
      hasSalaryConfigured: employee.monthlySalary != null && employee.monthlySalary > 0,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

export function buildSalaryExportWorkbook(summaries, month) {
  const rows = summaries.map((item) => ({
    Month: item.month,
    'Employee Name': item.userName,
    'Employee Code': item.employeeCode ?? '',
    'Monthly Salary (INR)': item.monthlySalary ?? '',
    'Working Days': item.workingDaysInMonth,
    Present: item.presentDays,
    'Paid Leave': item.paidLeaveDays,
    'Payable Days': item.payableDays,
    'LOP Days': item.lopDays,
    'Per Day (INR)': item.perDaySalary ?? '',
    'Payable Estimate (INR)': item.payableEstimate ?? '',
  }));

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Salary Summary');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

export async function updateUserSalary(userId, payload, actorId) {
  const user = await loadSalarySubject(userId);

  if (payload.monthlySalary !== undefined) {
    user.monthlySalary = payload.monthlySalary;
  }
  if (payload.salaryEffectiveFrom !== undefined) {
    user.salaryEffectiveFrom = payload.salaryEffectiveFrom;
  }

  await user.save();
  await user.populate(USER_POPULATE_FIELDS);

  return user;
}
