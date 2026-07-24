import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { getHolidayDateSet } from './leaveService.js';
import {
  countWorkingDaysIST,
  getISTDateInputValue,
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

async function countPresentDays(userId, monthStart, monthEnd) {
  const records = await AttendanceRecord.find({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: monthStart, $lte: monthEnd },
  }).select('timestamp');

  const uniqueDays = new Set(records.map((record) => getISTDateInputValue(record.timestamp)));
  return uniqueDays.size;
}

async function loadPaidLeaveTypeIds() {
  const policies = await LeavePolicy.find({ isActive: true, paid: true }).select('leaveTypeId');
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
  const paidTypeIds = await loadPaidLeaveTypeIds();
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
export function computeDailyCappedPayableDays(workingDayList, presentDaySet, paidLeaveByDay) {
  let total = 0;
  for (const day of workingDayList) {
    const dayKey = typeof day === 'string' ? day : getISTDateInputValue(day);
    const present = presentDaySet.has(dayKey) ? 1 : 0;
    const leave = paidLeaveByDay.get(dayKey) ?? 0;
    total += Math.min(1, present + leave);
  }
  return roundMoney(total);
}

async function loadPresentDaySet(userId, monthStart, monthEnd) {
  const records = await AttendanceRecord.find({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: monthStart, $lte: monthEnd },
  }).select('timestamp');

  return new Set(records.map((record) => getISTDateInputValue(record.timestamp)));
}

/**
 * Monthly salary impact (v1 — estimate only, not payroll).
 *
 * workingDaysInMonth = Mon–Fri in the IST month minus company holidays.
 * presentDays        = unique IST dates with an allowed check-in in the month.
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

  const paidTypeIds = await loadPaidLeaveTypeIds();
  const paidLeaveRequests = await LeaveRequest.find({
    userId: user._id,
    status: 'approved',
    startDate: { $lte: end },
    endDate: { $gte: start },
  }).select('leaveTypeId startDate endDate days halfDay');

  const [presentDaySet, paidLeaveDays] = await Promise.all([
    loadPresentDaySet(user._id, start, end),
    sumPaidLeaveDays(user._id, start, end, holidayDates),
  ]);

  const presentDays = presentDaySet.size;
  const paidLeaveByDay = buildPaidLeaveDayMap(
    paidLeaveRequests,
    start,
    end,
    holidayDates,
    paidTypeIds,
  );
  const payableDays = computeDailyCappedPayableDays(
    workingDayList,
    presentDaySet,
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
    return managerId === actorId;
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
