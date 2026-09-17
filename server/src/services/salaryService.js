import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS, hasPermission } from '../../../shared/permissions.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveType } from '../models/LeaveType.js';
import { Role } from '../models/Role.js';
import { SalarySettings } from '../models/SalarySettings.js';
import { SALARY_TRANSFER_STATUS, SalaryTransfer } from '../models/SalaryTransfer.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { getHolidayDateSet } from './leaveService.js';
import { getPaidLeaveQuota } from './leaveBalanceService.js';
import {
  countWorkingDaysIST,
  getISTDateInputValue,
  getISTYear,
  listWorkingDaysIST,
  parseDateInputAsISTDay,
  parseMonthInputAsISTRange,
  startOfDayIST,
} from '../utils/istDate.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/** Fixed 30-day month divisor for per-day salary (team-lead spec). */
export const SALARY_DAYS_DIVISOR = 30;

export function computePerDaySalary(monthlySalary) {
  if (monthlySalary == null || monthlySalary <= 0) {
    return null;
  }
  return roundMoney(monthlySalary / SALARY_DAYS_DIVISOR);
}

/** LOP amount from monthly salary and day fraction — avoids perDay rounding drift on half days. */
export function computeLopDeductionAmount(monthlySalary, dayFraction) {
  if (monthlySalary == null || monthlySalary <= 0 || dayFraction <= 0) {
    return 0;
  }
  return roundMoney((monthlySalary / SALARY_DAYS_DIVISOR) * dayFraction);
}

/**
 * Resolves MTD cutoff within a salary month.
 * Defaults: today when viewing current month, month-end for past months, month-start for future.
 */
export function resolveSalaryAsOfDate(monthInput, asOfDateInput = null) {
  const range = parseMonthInputAsISTRange(monthInput);
  if (!range) {
    return null;
  }

  const monthStartKey = getISTDateInputValue(range.start);
  const monthEndKey = getISTDateInputValue(range.end);
  const todayKey = getISTDateInputValue(new Date());

  let asOfKey;
  if (asOfDateInput != null && asOfDateInput !== '') {
    const parsed = String(asOfDateInput).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
      return null;
    }
    asOfKey = parsed;
  } else if (todayKey >= monthStartKey && todayKey <= monthEndKey) {
    asOfKey = todayKey;
  } else if (todayKey > monthEndKey) {
    asOfKey = monthEndKey;
  } else {
    asOfKey = monthStartKey;
  }

  if (asOfKey < monthStartKey) {
    asOfKey = monthStartKey;
  }
  if (asOfKey > monthEndKey) {
    asOfKey = monthEndKey;
  }

  return { ...range, asOfDateKey: asOfKey };
}

export function salaryAppliesForMonth(user, monthEnd) {
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

/** WFH stays in the payable type set; overdraw still becomes LOP via paidQuota. */
export function unionWfhLeaveTypeId(paidTypeIds, wfhLeaveTypeId) {
  const result = new Set(paidTypeIds);
  if (wfhLeaveTypeId) {
    result.add(wfhLeaveTypeId.toString());
  }
  return result;
}

export async function loadPaidLeaveTypeIds(year = getISTYear()) {
  const [policies, wfhType] = await Promise.all([
    LeavePolicy.find({ isActive: true, paid: true, year }).select('leaveTypeId'),
    LeaveType.findOne({ code: 'WFH' }).select('_id'),
  ]);
  const paidIds = new Set(policies.map((policy) => policy.leaveTypeId.toString()));
  return unionWfhLeaveTypeId(paidIds, wfhType?._id);
}

function requestSortKey(request) {
  const start = request.startDate instanceof Date ? request.startDate.getTime() : 0;
  const end = request.endDate instanceof Date ? request.endDate.getTime() : 0;
  const id = request._id?.toString?.() ?? request.id?.toString?.() ?? '';
  return { start, end, id };
}

function compareLeaveRequestsChronologically(a, b) {
  const ka = requestSortKey(a);
  const kb = requestSortKey(b);
  if (ka.start !== kb.start) return ka.start - kb.start;
  if (ka.end !== kb.end) return ka.end - kb.end;
  return ka.id.localeCompare(kb.id);
}

/**
 * Distributes paid leave fractions across IST working days (for per-day payable cap).
 *
 * V1 paid vs overdrawn (LOP): per leave type per calendar year, only the first
 * `paidQuota` approved leave days — chronological by request start, then working day —
 * count as paid. `paidQuota` = entitled + carried − encashed (see getPaidLeaveQuota).
 * Approved days beyond that quota are unpaid/LOP even when LeavePolicy.paid is true
 * (including WFH). Pending never counts as paid.
 *
 * When `paidQuotaByTypeId` is provided, pass year-scoped approved requests (year start
 * through salary month end) so earlier months consume quota first. When omitted, all
 * approved days of paid types in the month overlap count as paid (legacy/tests).
 */
export function buildPaidLeaveDayMap(
  requests,
  monthStart,
  monthEnd,
  holidayDates,
  paidTypeIds,
  paidQuotaByTypeId = null,
) {
  const dayMap = new Map();
  const useQuota = paidQuotaByTypeId instanceof Map;
  const remainingQuota = useQuota ? new Map(paidQuotaByTypeId) : null;
  const monthStartKey = getISTDateInputValue(monthStart);
  const monthEndKey = getISTDateInputValue(monthEnd);

  const ordered = useQuota
    ? [...requests].sort(compareLeaveRequestsChronologically)
    : requests;

  for (const request of ordered) {
    const typeId = request.leaveTypeId?.toString?.() ?? String(request.leaveTypeId);
    if (!paidTypeIds.has(typeId)) {
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

    const perDay = request.days / totalWorkingDays;
    let quotaLeft = useQuota ? (remainingQuota.get(typeId) ?? 0) : null;

    if (useQuota) {
      const workingDayList = listWorkingDaysIST(
        request.startDate,
        request.endDate,
        holidayDates,
      );
      for (const day of workingDayList) {
        const key = typeof day === 'string' ? day : getISTDateInputValue(day);
        const paidSlice = Math.min(perDay, quotaLeft);
        quotaLeft -= paidSlice;

        if (paidSlice > 0 && key >= monthStartKey && key <= monthEndKey) {
          dayMap.set(key, (dayMap.get(key) ?? 0) + paidSlice);
        }
      }
      remainingQuota.set(typeId, quotaLeft);
      continue;
    }

    const overlapStart = request.startDate > monthStart ? request.startDate : monthStart;
    const overlapEnd = request.endDate < monthEnd ? request.endDate : monthEnd;
    if (overlapEnd < overlapStart) {
      continue;
    }

    const overlapWorkingDayList = listWorkingDaysIST(overlapStart, overlapEnd, holidayDates);
    if (overlapWorkingDayList.length === 0) {
      continue;
    }

    const leaveInOverlap =
      (request.days * overlapWorkingDayList.length) / totalWorkingDays;
    const overlapPerDay = leaveInOverlap / overlapWorkingDayList.length;

    for (const day of overlapWorkingDayList) {
      const key = typeof day === 'string' ? day : getISTDateInputValue(day);
      dayMap.set(key, (dayMap.get(key) ?? 0) + overlapPerDay);
    }
  }

  return dayMap;
}

/**
 * Per IST working day: unpaid leave fraction beyond yearly paid quota.
 * Same chronological quota consumption as buildPaidLeaveDayMap.
 *
 * @returns {Map<string, { fraction: number, leaveTypeCode: string, leaveTypeId: string }>}
 */
export function buildUnpaidLeaveDayMap(
  requests,
  monthStart,
  monthEnd,
  holidayDates,
  paidTypeIds,
  paidQuotaByTypeId,
  leaveTypeCodeById = new Map(),
) {
  const dayMap = new Map();
  if (!(paidQuotaByTypeId instanceof Map)) {
    return dayMap;
  }
  // Empty quota map means zero paid stock for all types — still tag overdrawn days.

  const remainingQuota = new Map(paidQuotaByTypeId);
  const ordered = [...requests].sort(compareLeaveRequestsChronologically);
  const monthStartKey = getISTDateInputValue(monthStart);
  const monthEndKey = getISTDateInputValue(monthEnd);

  for (const request of ordered) {
    const typeId = request.leaveTypeId?.toString?.() ?? String(request.leaveTypeId);
    if (!paidTypeIds.has(typeId)) {
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

    const perDay = request.days / totalWorkingDays;
    let quotaLeft = remainingQuota.get(typeId) ?? 0;
    const typeCode =
      leaveTypeCodeById.get(typeId)
      ?? request.leaveTypeId?.code
      ?? 'Leave';

    const workingDayList = listWorkingDaysIST(
      request.startDate,
      request.endDate,
      holidayDates,
    );

    for (const day of workingDayList) {
      const key = typeof day === 'string' ? day : getISTDateInputValue(day);
      const paidSlice = Math.min(perDay, quotaLeft);
      quotaLeft -= paidSlice;
      const unpaidSlice = perDay - paidSlice;

      if (unpaidSlice > 0.001 && key >= monthStartKey && key <= monthEndKey) {
        const existing = dayMap.get(key);
        if (existing) {
          existing.fraction = roundMoney(existing.fraction + unpaidSlice);
        } else {
          dayMap.set(key, {
            fraction: roundMoney(unpaidSlice),
            leaveTypeCode: typeCode,
            leaveTypeId: typeId,
          });
        }
      }
    }

    remainingQuota.set(typeId, quotaLeft);
  }

  return dayMap;
}

/**
 * Builds LOP deduction rows from attendance + leave source data (recompute-on-read).
 * Reasons: Absent (100%), Half day (50%), Unpaid {type} (100% per unpaid fraction).
 */
export function computeLopDeductionRows({
  workingDayList,
  attendanceCreditByDay,
  paidLeaveByDay,
  unpaidLeaveByDay,
  monthlySalary,
  asOfDateKey,
}) {
  const rows = [];
  if (monthlySalary == null || monthlySalary <= 0 || !asOfDateKey) {
    return rows;
  }

  for (const day of workingDayList) {
    if (day > asOfDateKey) {
      continue;
    }

    const attendance = attendanceCreditByDay.get(day) ?? 0;
    const paidLeave = paidLeaveByDay.get(day) ?? 0;
    const unpaidInfo = unpaidLeaveByDay.get(day);
    const unpaidLeave = unpaidInfo?.fraction ?? 0;

    if (unpaidLeave > 0.001) {
      rows.push({
        date: day,
        reason: `Unpaid ${unpaidInfo.leaveTypeCode ?? 'Leave'}`,
        amount: computeLopDeductionAmount(monthlySalary, unpaidLeave),
        category: 'unpaid_leave',
        days: unpaidLeave,
        leaveTypeId: unpaidInfo.leaveTypeId ?? null,
      });
    }

    const covered = Math.min(1, attendance + paidLeave + unpaidLeave);
    const uncovered = roundMoney(1 - covered);
    if (uncovered <= 0.001) {
      continue;
    }

    const isHalfDay = Math.abs(uncovered - 0.5) < 0.001;
    rows.push({
      date: day,
      reason: isHalfDay ? 'Half day' : 'Absent',
      amount: computeLopDeductionAmount(monthlySalary, uncovered),
      category: isHalfDay ? 'half_day' : 'absent',
      days: uncovered,
      leaveTypeId: null,
    });
  }

  return rows;
}

/**
 * Pure MTD salary metrics — payable = monthlySalary − sum(LOP deductions through asOfDate).
 */
export function computeMtdSalaryMetrics({
  monthlySalary,
  workingDayList,
  attendanceCreditByDay,
  paidLeaveByDay,
  unpaidLeaveByDay,
  asOfDateKey,
}) {
  const perDaySalary = computePerDaySalary(monthlySalary);
  const mtdWorkingDays = workingDayList.filter((day) => day <= asOfDateKey);

  const lopDeductionRows = computeLopDeductionRows({
    workingDayList,
    attendanceCreditByDay,
    paidLeaveByDay,
    unpaidLeaveByDay,
    monthlySalary,
    asOfDateKey,
  });

  const lopDeductionTotal = roundMoney(lopDeductionRows.reduce((sum, row) => sum + row.amount, 0));
  const lopDeduction = monthlySalary != null ? lopDeductionTotal : null;
  const lopDays = roundMoney(lopDeductionRows.reduce((sum, row) => sum + row.days, 0));
  const payableEstimate =
    monthlySalary != null ? roundMoney(monthlySalary - lopDeductionTotal) : null;

  const presentDays = roundMoney(
    mtdWorkingDays.reduce((total, day) => total + (attendanceCreditByDay.get(day) ?? 0), 0),
  );
  const paidLeaveDays = roundMoney(
    mtdWorkingDays.reduce((total, day) => total + (paidLeaveByDay.get(day) ?? 0), 0),
  );
  const payableDays = computeDailyCappedPayableDays(
    mtdWorkingDays,
    attendanceCreditByDay,
    paidLeaveByDay,
  );

  const lopDates = lopDeductionRows.map((row) => ({
    date: row.date,
    reason: row.reason,
    unpaidDays: row.days,
    amount: row.amount,
  }));

  return {
    perDaySalary,
    payableEstimate,
    lopDeduction,
    lopDays,
    lopDeductionRows,
    lopDates,
    presentDays,
    paidLeaveDays,
    payableDays,
    asOfDate: asOfDateKey,
    mtdPayable: payableEstimate,
  };
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
 * Monthly salary impact — recompute-on-read from attendance + leave source of truth.
 *
 * perDaySalary    = monthlySalary / 30 (fixed 30-day month).
 * payableEstimate = monthlySalary − sum(LOP deductions from month start through asOfDate).
 * LOP reasons     = Absent (100%), Half day (50%), Unpaid {type} (100% per unpaid fraction).
 *
 * @param {object} user
 * @param {string} monthInput - YYYY-MM
 * @param {{ asOfDate?: string }} [options] - IST YYYY-MM-DD cutoff within month
 */
export async function computeMonthlySalarySummary(user, monthInput, options = {}) {
  const resolved = resolveSalaryAsOfDate(monthInput, options.asOfDate);
  if (!resolved) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const { year, monthKey, start, end, asOfDateKey } = resolved;
  const holidayDates = await getHolidayDateSet(year);
  const workingDayList = listWorkingDaysIST(start, end, holidayDates);
  const workingDaysInMonth = workingDayList.length;
  const yearStart = startOfDayIST(parseDateInputAsISTDay(`${year}-01-01`));

  const paidTypeIds = await loadPaidLeaveTypeIds(year);

  const [attendanceCreditByDay, balances, yearLeaveRequests, leaveTypes] = await Promise.all([
    loadAttendanceCreditByDay(user._id, start, end),
    LeaveBalance.find({ userId: user._id, year }).select('leaveTypeId entitled carried compOffEarned encashed'),
    LeaveRequest.find({
      userId: user._id,
      status: 'approved',
      startDate: { $lte: end },
      endDate: { $gte: yearStart },
    }).select('leaveTypeId startDate endDate days halfDay'),
    LeaveType.find({ isActive: true }).select('_id code'),
  ]);

  const leaveTypeCodeById = new Map(
    leaveTypes.map((leaveType) => [leaveType._id.toString(), leaveType.code]),
  );

  const paidQuotaByTypeId = new Map(
    balances.map((balance) => [
      balance.leaveTypeId.toString(),
      getPaidLeaveQuota(balance),
    ]),
  );

  const paidLeaveByDay = buildPaidLeaveDayMap(
    yearLeaveRequests,
    start,
    end,
    holidayDates,
    paidTypeIds,
    paidQuotaByTypeId,
  );
  const unpaidLeaveByDay = buildUnpaidLeaveDayMap(
    yearLeaveRequests,
    start,
    end,
    holidayDates,
    paidTypeIds,
    paidQuotaByTypeId,
    leaveTypeCodeById,
  );

  const hasSalary = salaryAppliesForMonth(user, end);
  const monthlySalary = hasSalary ? user.monthlySalary : null;

  const mtdMetrics = computeMtdSalaryMetrics({
    monthlySalary,
    workingDayList,
    attendanceCreditByDay,
    paidLeaveByDay,
    unpaidLeaveByDay,
    asOfDateKey,
  });

  return {
    month: monthKey,
    currency: 'INR',
    userId: user._id.toString(),
    userName: user.name,
    employeeCode: user.employeeCode ?? null,
    monthlySalary,
    salaryEffectiveFrom: user.salaryEffectiveFrom ?? null,
    workingDaysInMonth,
    presentDays: mtdMetrics.presentDays,
    paidLeaveDays: mtdMetrics.paidLeaveDays,
    payableDays: mtdMetrics.payableDays,
    lopDays: mtdMetrics.lopDays,
    lopDates: mtdMetrics.lopDates,
    lopDeductionRows: mtdMetrics.lopDeductionRows,
    lopDeduction: mtdMetrics.lopDeduction,
    perDaySalary: mtdMetrics.perDaySalary,
    payableEstimate: mtdMetrics.payableEstimate,
    mtdPayable: mtdMetrics.mtdPayable,
    asOfDate: mtdMetrics.asOfDate,
    hasSalaryConfigured: monthlySalary != null,
  };
}

export async function loadSalarySubject(userId, { allowInactive = false } = {}) {
  if (!mongoose.isValidObjectId(userId)) {
    throwError('Employee not found.', 404);
  }
  const user = await User.findById(userId).populate(USER_POPULATE_FIELDS);
  if (!user || (!user.isActive && !allowInactive)) {
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
  // Reads tolerate deactivated subjects (empty-state downstream); writes keep
  // the strict loader so inactive records stay uneditable.
  const subject = await loadSalarySubject(userId, { allowInactive: true });
  if (!canViewSalarySummary(actor, subject, permissions)) {
    throwError('You do not have permission to view this salary summary.', 403);
  }
  if (!subject.isActive) {
    return { summary: null, inactive: true };
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

/**
 * Next payroll date with a month-end fallback: when no payroll day is
 * configured, the last day of the current IST month is used so payroll
 * surfaces always show a date instead of an empty state. Today can never
 * pass the last day of its own month, so the fallback is always ahead.
 */
export function resolveNextPayrollDateIst(payrollDayOfMonth, referenceDate = new Date()) {
  const configured = computeNextPayrollDateIst(payrollDayOfMonth, referenceDate);
  if (configured) return { date: configured, isDefault: false };
  const todayKey = getISTDateInputValue(referenceDate);
  const [year, month] = todayKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthKey = String(month).padStart(2, '0');
  return { date: `${year}-${monthKey}-${String(lastDay).padStart(2, '0')}`, isDefault: true };
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

export async function generatePendingSalaryTransfers(month, actorId, session = null) {
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

  const existingQuery = SalaryTransfer.find({ periodKey: month }).select('userId');
  if (session) existingQuery.session(session);
  const existing = await existingQuery;
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
    await SalaryTransfer.insertMany(toCreate, { ordered: false, ...(session ? { session } : {}) });
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

  const previousStatus = transfer.status;
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
  return { ...salaryTransferToJSON(transfer), previousStatus };
}

export async function getOrCreateSalarySettings() {
  let settings = await SalarySettings.findOne().sort({ updatedAt: -1 });
  if (!settings) {
    settings = await SalarySettings.create({});
  }
  return settings;
}

export function salarySettingsToJSON(settings) {
  const resolved = resolveNextPayrollDateIst(settings.payrollDayOfMonth);
  return {
    payrollDayOfMonth: settings.payrollDayOfMonth ?? null,
    nextPayrollDate: resolved.date,
    payrollDayIsDefault: resolved.isDefault,
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
  const resolvedPayroll = resolveNextPayrollDateIst(settings.payrollDayOfMonth);

  return {
    totalPayroll: roundMoney(totalPayroll),
    employeesWithEstimate: withEstimate.length,
    employeesConfigured: configuredCount,
    pendingTransfers: transferStats.pendingCount,
    nextPayrollDate: resolvedPayroll.date,
    payrollDayOfMonth: settings.payrollDayOfMonth ?? null,
    payrollDayIsDefault: resolvedPayroll.isDefault,
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
      .select('name employeeCode department departmentId designation monthlySalary salaryEffectiveFrom')
      .populate('departmentId', 'name code')
      // _id tiebreaker keeps offset pagination stable when names tie.
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  return {
    employees: employees.map((employee) => ({
      id: employee._id.toString(),
      name: employee.name,
      employeeCode: employee.employeeCode ?? null,
      // Live department name from the Department master; legacy text fallback.
      department: employee.departmentId?.name ?? employee.department ?? null,
      departmentId: employee.departmentId?._id?.toString() ?? employee.departmentId?.toString?.() ?? null,
      departmentName: employee.departmentId?.name ?? null,
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

export function mapLopListRow(summary) {
  return {
    userId: summary.userId,
    name: summary.userName,
    employeeCode: summary.employeeCode ?? null,
    totalSalary: summary.monthlySalary,
    mtdPayable: summary.mtdPayable,
    totalLopDeduction: summary.lopDeduction,
    asOfDate: summary.asOfDate,
    hasLop: (summary.lopDeduction ?? 0) > 0,
  };
}

export function mapLopDetail(summary) {
  return {
    userId: summary.userId,
    name: summary.userName,
    month: summary.month,
    asOfDate: summary.asOfDate,
    deductions: (summary.lopDeductionRows ?? []).map((row) => ({
      date: row.date,
      reason: row.reason,
      amountDeducted: row.amount,
    })),
  };
}

function validateLopAsOfDate(month, asOf) {
  if (asOf == null || asOf === '') {
    return;
  }
  const trimmed = String(asOf).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throwError('Invalid as-of date. Use YYYY-MM-DD within the selected month.');
  }
  const parsed = parseDateInputAsISTDay(trimmed);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throwError('Invalid as-of date. Use YYYY-MM-DD within the selected month.');
  }
  if (getISTDateInputValue(parsed) !== trimmed) {
    throwError('Invalid as-of date. Use YYYY-MM-DD within the selected month.');
  }
  const resolved = resolveSalaryAsOfDate(month, trimmed);
  if (!resolved) {
    throwError('Invalid as-of date. Use YYYY-MM-DD within the selected month.');
  }
}

export async function listLopSummaries({ month, asOf, page = 1, limit = 20 }) {
  const range = parseMonthInputAsISTRange(month);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }
  validateLopAsOfDate(month, asOf);

  const query = {
    isActive: true,
    monthlySalary: { $ne: null, $gt: 0 },
  };
  const skip = (page - 1) * limit;

  const [employees, total] = await Promise.all([
    User.find(query)
      .select('name employeeCode monthlySalary salaryEffectiveFrom')
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  const resolved = resolveSalaryAsOfDate(month, asOf);
  const employeesInMonth = employees.filter((employee) => salaryAppliesForMonth(employee, range.end));
  const rows = [];
  for (const employee of employeesInMonth) {
    const summary = await computeMonthlySalarySummary(employee, month, { asOfDate: asOf });
    rows.push(mapLopListRow(summary));
  }

  return {
    month,
    asOfDate: resolved?.asOfDateKey ?? null,
    employees: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

export async function listAllLopSummariesForMonth(month, asOf) {
  const range = parseMonthInputAsISTRange(month);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }
  validateLopAsOfDate(month, asOf);

  const employees = await User.find({
    isActive: true,
    monthlySalary: { $ne: null, $gt: 0 },
  })
    .select('name employeeCode monthlySalary salaryEffectiveFrom')
    .sort({ name: 1, _id: 1 });

  const summaries = [];
  for (const employee of employees) {
    if (!salaryAppliesForMonth(employee, range.end)) {
      continue;
    }
    summaries.push(await computeMonthlySalarySummary(employee, month, { asOfDate: asOf }));
  }
  return summaries;
}

export async function getLopDetailForUser(actor, permissions, userId, month, asOf) {
  const subject = await loadSalarySubject(userId);
  if (!canViewSalarySummary(actor, subject, permissions)) {
    throwError('You do not have permission to view this LOP detail.', 403);
  }
  validateLopAsOfDate(month, asOf);
  const summary = await computeMonthlySalarySummary(subject, month, { asOfDate: asOf });
  return mapLopDetail(summary);
}

export function lopDeductionRowsToExportRows(summary) {
  const rows = [];
  for (const row of summary.lopDeductionRows ?? []) {
    rows.push({
      'Employee Name': summary.userName,
      'Employee Code': summary.employeeCode ?? '',
      Month: summary.month,
      'As Of Date': summary.asOfDate,
      Date: row.date,
      Reason: row.reason,
      'Amount Deducted (INR)': row.amount,
    });
  }
  return rows;
}

const LOP_EXPORT_COMPANY_NAME = 'Grubpac Technologies';
const LOP_EXPORT_BRAND_ORANGE = 'FFE85D04';
const LOP_EXPORT_HEADER_DARK = 'FF1F2937';
const LOP_EXPORT_WHITE = 'FFFFFFFF';
const LOP_EXPORT_ROW_EVEN = 'FFF9FAFB';
const LOP_EXPORT_ROW_ODD = 'FFFFFFFF';
const LOP_EXPORT_INSTRUCTION_FILL = 'FFFFF7ED';
const LOP_EXPORT_INSTRUCTION_TEXT = 'FF9A3412';
const LOP_EXPORT_BORDER_COLOR = 'FFE5E7EB';

export const LOP_EXPORT_SHEET_HEADER_ROW = 5;
const LOP_EXPORT_DATA_START_ROW = 6;

export const LOP_EXPORT_HEADERS = [
  'Employee Name',
  'Employee Code',
  'Month',
  'As Of Date',
  'Date',
  'Reason',
  'Amount Deducted (INR)',
];

const LOP_EXPORT_COLUMN_WIDTHS = [24, 14, 10, 12, 12, 20, 22];

function lopExportThinBorder() {
  return {
    top: { style: 'thin', color: { argb: LOP_EXPORT_BORDER_COLOR } },
    left: { style: 'thin', color: { argb: LOP_EXPORT_BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: LOP_EXPORT_BORDER_COLOR } },
    right: { style: 'thin', color: { argb: LOP_EXPORT_BORDER_COLOR } },
  };
}

function applyLopExportHeaderStyle(row, colCount) {
  row.height = 22;
  for (let column = 1; column <= colCount; column += 1) {
    const cell = row.getCell(column);
    cell.font = { bold: true, color: { argb: LOP_EXPORT_WHITE }, size: 11, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LOP_EXPORT_HEADER_DARK } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = lopExportThinBorder();
  }
}

function styleLopExportDataRow(row, rowIndex, colCount) {
  const fill = rowIndex % 2 === 0 ? LOP_EXPORT_ROW_EVEN : LOP_EXPORT_ROW_ODD;
  for (let column = 1; column <= colCount; column += 1) {
    const cell = row.getCell(column);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.border = lopExportThinBorder();
    cell.alignment = { vertical: 'middle', wrapText: false };
    cell.font = { size: 10, name: 'Calibri' };
    if (column === LOP_EXPORT_HEADERS.length) {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
    }
  }
}

export async function buildLopExportWorkbook(
  exportRows,
  {
    sheetName = 'LOP Deductions',
    subtitle = 'LOP Deduction Export',
    instructionText = 'Amounts are in INR. Per-day rate uses a fixed 30-day month (monthly salary ÷ 30).',
  } = {},
) {
  const colCount = LOP_EXPORT_HEADERS.length;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = LOP_EXPORT_COMPANY_NAME;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: LOP_EXPORT_SHEET_HEADER_ROW }],
    properties: { defaultRowHeight: 18 },
  });

  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = LOP_EXPORT_COMPANY_NAME;
  titleCell.font = { bold: true, size: 16, name: 'Calibri', color: { argb: LOP_EXPORT_WHITE } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LOP_EXPORT_BRAND_ORANGE } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, colCount);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: LOP_EXPORT_HEADER_DARK } };
  subtitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LOP_EXPORT_ROW_EVEN } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(2).height = 22;

  sheet.mergeCells(3, 1, 3, colCount);
  const instructionCell = sheet.getCell(3, 1);
  instructionCell.value = instructionText;
  instructionCell.font = {
    italic: true,
    size: 10,
    name: 'Calibri',
    color: { argb: LOP_EXPORT_INSTRUCTION_TEXT },
  };
  instructionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LOP_EXPORT_INSTRUCTION_FILL } };
  instructionCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  sheet.getRow(3).height = 20;

  sheet.getRow(4).height = 6;

  const headerRow = sheet.getRow(LOP_EXPORT_SHEET_HEADER_ROW);
  LOP_EXPORT_HEADERS.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  applyLopExportHeaderStyle(headerRow, colCount);

  exportRows.forEach((rowObject, rowIndex) => {
    const row = sheet.getRow(LOP_EXPORT_DATA_START_ROW + rowIndex);
    LOP_EXPORT_HEADERS.forEach((header, columnIndex) => {
      row.getCell(columnIndex + 1).value = rowObject[header] ?? '';
    });
    styleLopExportDataRow(row, rowIndex, colCount);
  });

  LOP_EXPORT_COLUMN_WIDTHS.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  sheet.autoFilter = {
    from: { row: LOP_EXPORT_SHEET_HEADER_ROW, column: 1 },
    to: { row: LOP_EXPORT_SHEET_HEADER_ROW, column: colCount },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
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

export { settleMonthPayroll, listRecentSettlements } from './lopSettlementService.js';
