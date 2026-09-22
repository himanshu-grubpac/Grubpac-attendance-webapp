import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import { User } from '../models/User.js';
import { LopRecord } from '../models/LopRecord.js';
import { MonthSettlement } from '../models/MonthSettlement.js';
import { SalaryTransfer } from '../models/SalaryTransfer.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Department } from '../models/Department.js';
import {
  getISTYear,
  getISTMonth,
  getISTDateInputValue,
  listWorkingDaysIST,
  parseMonthInputAsISTRange,
  parseDateInputAsISTDay,
  startOfDayIST,
} from '../utils/istDate.js';
import {
  loadPaidLeaveTypeIds,
  buildPaidLeaveDayMap,
  buildUnpaidLeaveDayMap,
  computeMtdSalaryMetrics,
  resolveSalaryAsOfDate,
  salaryAppliesForMonth,
  attendanceCreditForTag,
} from './salaryService.js';
import { getHolidayDateSet } from './leaveService.js';
import { getPaidLeaveQuota } from './leaveBalanceService.js';
import {
  assertDepartmentInAccessibleSet,
  resolveTeamScopedUserIds,
} from './teamScopeService.js';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { parseSalaryPeriodKey } from './salaryService.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Resolves the set of employee IDs the actor is authorized to view salary for.
 * Returns null for unscoped (admin read-all), [] for no access, or array of ObjectIds.
 */
async function getAuditScope(actor, permissions) {
  return resolveTeamScopedUserIds(actor, permissions);
}

/**
 * Validates and parses a periodKey (YYYY-MM).
 */
function validatePeriodKey(periodKey) {
  const range = parseMonthInputAsISTRange(periodKey);
  if (!range) {
    throwError('Invalid periodKey. Use YYYY-MM format.');
  }
  return range;
}

// ── Bulk data fetching ───────────────────────────────────────────────

/**
 * Bulk-fetches attendance credit by user for a month.
 * Returns Map<userId_string, Map<dayKey, credit>>.
 * credit = 1.0 for Present, 0.5 for HD/LV.
 */
async function bulkFetchAttendanceByUser(userIds, monthStart, monthEnd) {
  if (userIds.length === 0) return new Map();

  const records = await AttendanceRecord.find({
    userId: { $in: userIds },
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: monthStart, $lte: monthEnd },
  }).select('userId timestamp attendanceTag adminMarkedAbsent').lean();

  const outerMap = new Map();
  for (const record of records) {
    if (record.adminMarkedAbsent) {
      continue;
    }
    const uid = record.userId.toString();
    if (!outerMap.has(uid)) outerMap.set(uid, new Map());
    const dayMap = outerMap.get(uid);
    const dayKey = getISTDateInputValue(record.timestamp);
    const credit = attendanceCreditForTag(record.attendanceTag);
    dayMap.set(dayKey, Math.max(dayMap.get(dayKey) ?? 0, credit));
  }
  return outerMap;
}

/**
 * Bulk-fetches leave balances by user for a year.
 * Returns Map<userId_string, LeaveBalance[]>.
 */
async function bulkFetchLeaveBalancesByUser(userIds, year) {
  if (userIds.length === 0) return new Map();

  const balances = await LeaveBalance.find({
    userId: { $in: userIds },
    year,
  }).select('userId leaveTypeId entitled carried compOffEarned encashed').lean();

  const outerMap = new Map();
  for (const balance of balances) {
    const uid = balance.userId.toString();
    if (!outerMap.has(uid)) outerMap.set(uid, []);
    outerMap.get(uid).push(balance);
  }
  return outerMap;
}

/**
 * Bulk-fetches approved leave requests by user for a year range.
 * Returns Map<userId_string, LeaveRequest[]>.
 */
async function bulkFetchLeaveRequestsByUser(userIds, yearStart, monthEnd) {
  if (userIds.length === 0) return new Map();

  const requests = await LeaveRequest.find({
    userId: { $in: userIds },
    status: 'approved',
    startDate: { $lte: monthEnd },
    endDate: { $gte: yearStart },
  }).select('userId leaveTypeId startDate endDate days halfDay').lean();

  const outerMap = new Map();
  for (const request of requests) {
    const uid = request.userId.toString();
    if (!outerMap.has(uid)) outerMap.set(uid, []);
    outerMap.get(uid).push(request);
  }
  return outerMap;
}

/**
 * Bulk-fetches departments by their IDs.
 * Returns Map<departmentId_string, Department>.
 */
async function bulkFetchDepartments(departmentIds) {
  if (departmentIds.length === 0) return new Map();

  const departments = await Department.find({
    _id: { $in: departmentIds },
  }).select('name code').lean();

  const map = new Map();
  for (const dept of departments) {
    map.set(dept._id.toString(), dept);
  }
  return map;
}

// ── In-memory salary computation (replaces per-employee DB calls) ─────

/**
 * Computes a monthly salary summary entirely in-memory from pre-fetched data.
 * This is the same logic as computeMonthlySalarySummary() but zero DB queries.
 *
 * @param {object} user - lean User document
 * @param {string} monthInput - "YYYY-MM"
 * @param {object} bulkData - pre-fetched data maps
 * @returns {object} salary summary
 */
function computeMonthlySalarySummaryInMemory(user, monthInput, bulkData, options = {}) {
  const resolved = resolveSalaryAsOfDate(monthInput, options.asOfDate);
  if (!resolved) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const { monthKey, start, end, asOfDateKey } = resolved;
  const {
    holidayDates,
    paidTypeIds,
    attendanceByUser,
    balancesByUser,
    requestsByUser,
    leaveTypeCodeById = new Map(),
  } = bulkData;

  const workingDayList = listWorkingDaysIST(start, end, holidayDates);
  const workingDaysInMonth = workingDayList.length;

  const userId = user._id.toString();
  const userAttendance = attendanceByUser.get(userId) ?? new Map();
  const userBalances = balancesByUser.get(userId) ?? [];
  const userRequests = requestsByUser.get(userId) ?? [];

  const paidQuotaByTypeId = new Map(
    userBalances.map((balance) => [
      balance.leaveTypeId.toString(),
      getPaidLeaveQuota(balance),
    ]),
  );

  const paidLeaveByDay = buildPaidLeaveDayMap(
    userRequests,
    start,
    end,
    holidayDates,
    paidTypeIds,
    paidQuotaByTypeId,
  );
  const unpaidLeaveByDay = buildUnpaidLeaveDayMap(
    userRequests,
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
    attendanceCreditByDay: userAttendance,
    paidLeaveByDay,
    unpaidLeaveByDay,
    asOfDateKey,
  });

  return {
    month: monthKey,
    currency: 'INR',
    userId,
    userName: user.name,
    employeeCode: user.employeeCode ?? null,
    monthlySalary,
    salaryEffectiveFrom: user.salaryEffectiveFrom ?? null,
    workingDaysInMonth,
    presentDays: mtdMetrics.presentDays,
    paidLeaveDays: mtdMetrics.paidLeaveDays,
    payableDays: mtdMetrics.payableDays,
    paidDaysOutOf30: mtdMetrics.paidDaysOutOf30,
    lopDays: mtdMetrics.lopDays,
    lopDeduction: mtdMetrics.lopDeduction,
    perDaySalary: mtdMetrics.perDaySalary,
    payableEstimate: mtdMetrics.payableEstimate,
    asOfDate: mtdMetrics.asOfDate,
    hasSalaryConfigured: monthlySalary != null,
  };
}

// ── Shared audit row builder ─────────────────────────────────────────

/**
 * Builds a single audit row for an employee in a given month.
 *
 * This is the SINGLE source of truth for audit row construction —
 * both the API, history, and export use this function.
 *
 * Uses in-memory computation (no per-employee DB calls).
 * Settled months use SalaryTransfer.amount as netSalary.
 * Inconsistent state (settled but no transfer) returns status: 'inconsistent'.
 *
 * @param {object} employee - lean User document
 * @param {string} month - "YYYY-MM"
 * @param {Map<string, object[]>} lopRecordsByUser - Map<userId, settled LopRecord[]>
 * @param {Map<string, object>} transfersByUser - Map<userId, SalaryTransfer>
 * @param {Set<string>} settledPeriods - Set of settled periodKeys
 * @param {object} bulkData - pre-fetched bulk data (attendance, balances, requests, holidays, paidTypes)
 * @returns {object} audit row
 */
function buildAuditRow(employee, month, lopRecordsByUser, transfersByUser, settledPeriods, bulkData) {
  const summary = computeMonthlySalarySummaryInMemory(employee, month, bulkData);

  const userId = employee._id.toString();

  // Use ONLY finalized (settled) LOP records
  const lopRecords = lopRecordsByUser.get(userId) ?? [];
  const totalLopDeduction = lopRecords.reduce((sum, r) => sum + (r.deductionAmount ?? 0), 0);
  const totalLopDays = lopRecords.reduce((sum, r) => sum + (r.days ?? 0), 0);

  // Prefer finalized LOP from settled records; fall back to computed
  const finalLopDays = lopRecords.length > 0 ? roundMoney(totalLopDays) : summary.lopDays;
  const finalLopDeduction = lopRecords.length > 0 ? roundMoney(totalLopDeduction) : (summary.lopDeduction ?? 0);

  const grossSalary = summary.monthlySalary ?? 0;
  const otherDeductions = 0;
  const totalDeductions = roundMoney(finalLopDeduction + otherDeductions);

  const transfer = transfersByUser.get(userId);
  const isSettled = settledPeriods.has(month);

  const paidDaysOutOf30 = summary.hasSalaryConfigured ? summary.paidDaysOutOf30 : null;
  const payableEstimate = summary.hasSalaryConfigured ? summary.payableEstimate : null;
  const asOfDate = summary.asOfDate ?? null;

  // Inconsistent state: settled but no SalaryTransfer
  if (isSettled && !transfer) {
    return {
      employeeId: userId,
      employeeCode: employee.employeeCode ?? null,
      employeeName: employee.name,
      department: employee.departmentId?.toString?.() ?? null,
      periodKey: month,
      grossSalary,
      workingDays: summary.workingDaysInMonth,
      presentDays: summary.presentDays,
      paidLeaveDays: summary.paidLeaveDays,
      payableDays: summary.payableDays,
      paidDaysOutOf30,
      payableEstimate,
      asOfDate,
      lopDays: finalLopDays,
      lopDeduction: finalLopDeduction,
      perDaySalary: summary.perDaySalary,
      otherDeductions,
      totalDeductions,
      netSalary: null,
      hasSalaryConfigured: summary.hasSalaryConfigured,
      transferStatus: null,
      status: 'inconsistent',
    };
  }

  // If settled and transfer exists, use transfer.amount as the source of truth
  const netSalary = !summary.hasSalaryConfigured
    ? null
    : isSettled && transfer
      ? transfer.amount
      : roundMoney(grossSalary - totalDeductions);

  return {
    employeeId: userId,
    employeeCode: employee.employeeCode ?? null,
    employeeName: employee.name,
    department: employee.departmentId?.toString?.() ?? null,
    periodKey: month,
    grossSalary,
    workingDays: summary.workingDaysInMonth,
    presentDays: summary.presentDays,
    paidLeaveDays: summary.paidLeaveDays,
    payableDays: summary.payableDays,
    paidDaysOutOf30,
    payableEstimate,
    asOfDate,
    lopDays: finalLopDays,
    lopDeduction: finalLopDeduction,
    perDaySalary: summary.perDaySalary,
    otherDeductions,
    totalDeductions,
    netSalary,
    hasSalaryConfigured: summary.hasSalaryConfigured,
    transferStatus: transfer?.status ?? null,
    status: isSettled ? 'settled' : 'pending',
  };
}

// ── Bulk fetch helpers for LOP, settlements, transfers ────────────────

/**
 * Bulk-fetches settled LopRecords for the given user IDs and period.
 * Only returns records with status: 'settled'.
 * Returns Map<userId, LopRecord[]>.
 */
async function fetchSettledLopRecordsByUser(userIds, periodKey) {
  if (userIds.length === 0) return new Map();

  const records = await LopRecord.find({
    userId: { $in: userIds },
    periodKey,
    status: 'settled',
  }).sort({ leaveDate: 1 }).lean();

  const map = new Map();
  for (const record of records) {
    const uid = record.userId.toString();
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(record);
  }
  return map;
}

/**
 * Bulk-fetches settled LopRecords for a single user across all months in a year.
 * Only returns records with status: 'settled'.
 * Returns Map<periodKey, LopRecord[]>.
 */
async function fetchSettledLopRecordsByPeriod(userId, year) {
  const records = await LopRecord.find({
    userId,
    year,
    status: 'settled',
  }).sort({ leaveDate: 1 }).lean();

  const map = new Map();
  for (const record of records) {
    const pk = record.periodKey;
    if (!map.has(pk)) map.set(pk, []);
    map.get(pk).push(record);
  }
  return map;
}

/**
 * Fetches MonthSettlement records for the given period(s).
 * Returns Set<periodKey>.
 */
async function fetchSettledPeriods(periodKeys) {
  const keys = Array.isArray(periodKeys) ? periodKeys : [periodKeys];
  if (keys.length === 0) return new Set();

  const settlements = await MonthSettlement.find({
    periodKey: { $in: keys },
  }).lean();
  return new Set(settlements.map((s) => s.periodKey));
}

/**
 * Bulk-fetches SalaryTransfer records for the given user IDs and period.
 * Returns Map<userId, SalaryTransfer>.
 */
async function fetchSalaryTransfersByUser(userIds, periodKey) {
  if (userIds.length === 0) return new Map();

  const transfers = await SalaryTransfer.find({
    userId: { $in: userIds },
    periodKey,
  }).lean();

  const map = new Map();
  for (const transfer of transfers) {
    map.set(transfer.userId.toString(), transfer);
  }
  return map;
}

/**
 * Bulk-fetches SalaryTransfer records for a single user across multiple periods.
 * Returns Map<periodKey, SalaryTransfer>.
 */
async function fetchSalaryTransfersByPeriod(userId, periodKeys) {
  if (periodKeys.length === 0) return new Map();

  const transfers = await SalaryTransfer.find({
    userId,
    periodKey: { $in: periodKeys },
  }).lean();

  const map = new Map();
  for (const transfer of transfers) {
    map.set(transfer.periodKey, transfer);
  }
  return map;
}

// ── Pre-fetch bulk salary computation data ────────────────────────────

/**
 * Pre-fetches all data needed for in-memory salary computation across multiple employees.
 * Returns a single bulkData object with all maps, shared across all employees.
 *
 * Fixed number of queries regardless of employee count:
 * 1. getHolidayDateSet (1 query)
 * 2. loadPaidLeaveTypeIds (1-2 queries)
 * 3. bulkFetchAttendanceByUser (1 query)
 * 4. bulkFetchLeaveBalancesByUser (1 query)
 * 5. bulkFetchLeaveRequestsByUser (1 query)
 */
async function preFetchBulkSalaryData(userIds, year, monthStart, monthEnd) {
  const yearStart = startOfDayIST(parseDateInputAsISTDay(`${year}-01-01`));

  const [holidayDates, paidTypeIds, attendanceByUser, balancesByUser, requestsByUser, leaveTypes] = await Promise.all([
    getHolidayDateSet(year),
    loadPaidLeaveTypeIds(year),
    bulkFetchAttendanceByUser(userIds, monthStart, monthEnd),
    bulkFetchLeaveBalancesByUser(userIds, year),
    bulkFetchLeaveRequestsByUser(userIds, yearStart, monthEnd),
    LeaveType.find({ isActive: true }).select('_id code').lean(),
  ]);

  const leaveTypeCodeById = new Map(
    leaveTypes.map((leaveType) => [leaveType._id.toString(), leaveType.code]),
  );

  return {
    holidayDates,
    paidTypeIds,
    attendanceByUser,
    balancesByUser,
    requestsByUser,
    leaveTypeCodeById,
  };
}

// ── API: Employee salary history ──────────────────────────────────────

/**
 * Month keys (YYYY-MM) in scope for an employee's salary history in a calendar year.
 * Clamps to joiningDate (or createdAt), endingDate, and current IST month.
 */
export function buildEmployeeHistoryMonthKeys(subject, year, referenceDate = new Date()) {
  const currentIstYear = getISTYear(referenceDate);
  const currentIstMonth = getISTMonth(referenceDate);
  let maxMonth = currentIstYear === year ? currentIstMonth : 12;

  if (subject.endingDate) {
    const ending = new Date(subject.endingDate);
    const endYear = getISTYear(ending);
    if (endYear < year) {
      return [];
    }
    if (endYear === year) {
      maxMonth = Math.min(maxMonth, getISTMonth(ending));
    }
  }

  const effectiveStartDate = subject.joiningDate ?? subject.createdAt;
  let minMonth = 1;
  if (effectiveStartDate) {
    const start = new Date(effectiveStartDate);
    const startYear = getISTYear(start);
    if (startYear > year) {
      return [];
    }
    if (startYear === year) {
      minMonth = getISTMonth(start);
    }
  }

  if (minMonth > maxMonth) {
    return [];
  }

  const months = [];
  for (let m = minMonth; m <= maxMonth; m += 1) {
    months.push(`${year}-${String(m).padStart(2, '0')}`);
  }
  return months;
}

function buildEmployeeHistoryPayload(subject) {
  return {
    id: subject._id.toString(),
    name: subject.name,
    employeeCode: subject.employeeCode ?? null,
    monthlySalary: subject.monthlySalary ?? null,
    salaryEffectiveFrom: subject.salaryEffectiveFrom ?? null,
    salaryCurrency: 'INR',
    joiningDate: subject.joiningDate ?? null,
    endingDate: subject.endingDate ?? null,
    createdAt: subject.createdAt ?? null,
  };
}

/**
 * Employee salary history: returns monthly salary records for a given employee.
 *
 * Uses the shared buildAuditRow() function — same logic as audit and export.
 * Uses IST-based current month calculation.
 *
 * @param {object} actor - requesting user
 * @param {Array} permissions - actor's permissions
 * @param {string} userId - target employee ID
 * @param {object} options - { year? }
 * @returns {object} { employee, history }
 */
export async function getEmployeeSalaryHistory(actor, permissions, userId, options = {}) {
  const subject = await User.findById(userId)
    .select('_id name employeeCode monthlySalary salaryEffectiveFrom departmentId reportingManagerId isActive joiningDate endingDate createdAt')
    .lean();
  if (!subject) {
    throwError('Employee not found.', 404);
  }

  // Scope check: RM can only view team members
  const scopedIds = await getAuditScope(actor, permissions);
  if (scopedIds !== null) {
    const inScope = scopedIds.some((id) => id.toString() === userId);
    if (!inScope) {
      throwError('You do not have permission to view this employee\'s salary history.', 403);
    }
  }

  // Deactivated subjects stay viewable with an empty history (the UI renders
  // an empty state instead of an error).
  if (!subject.isActive) {
    return {
      employee: {
        id: subject._id.toString(),
        name: subject.name,
        employeeCode: subject.employeeCode ?? null,
        monthlySalary: subject.monthlySalary ?? null,
        salaryEffectiveFrom: subject.salaryEffectiveFrom ?? null,
        salaryCurrency: 'INR',
        joiningDate: subject.joiningDate ?? null,
        endingDate: subject.endingDate ?? null,
      },
      history: [],
      inactive: true,
    };
  }

  const year = options.year ?? getISTYear();
  const istNow = new Date();
  const employee = buildEmployeeHistoryPayload(subject);
  const months = buildEmployeeHistoryMonthKeys(subject, year, istNow);

  if (months.length === 0) {
    return {
      employee,
      history: [],
    };
  }

  // Determine date range for bulk fetch (need full year data for quota consumption)
  const lastMonthRange = parseMonthInputAsISTRange(months[months.length - 1]);
  if (!lastMonthRange) {
    return {
      employee,
      history: [],
    };
  }

  // Bulk fetch: LOP records, settlements, transfers, salary computation data
  const [lopByPeriod, settledPeriods, transferByPeriod, bulkData] = await Promise.all([
    fetchSettledLopRecordsByPeriod(userId, year),
    fetchSettledPeriods(months),
    fetchSalaryTransfersByPeriod(userId, months),
    preFetchBulkSalaryData([userId], year, startOfDayIST(parseDateInputAsISTDay(`${year}-01-01`)), lastMonthRange.end),
  ]);

  // Build history using the SHARED buildAuditRow function (in-memory computation)
  const history = [];

  for (const monthKey of months) {
    const monthLopRecords = lopByPeriod.get(monthKey) ?? [];
    const monthTransfer = transferByPeriod.get(monthKey) ?? null;

    const monthLopByUser = new Map([[userId, monthLopRecords]]);
    const monthTransferByUser = monthTransfer
      ? new Map([[userId, monthTransfer]])
      : new Map();

    const row = buildAuditRow(
      subject,
      monthKey,
      monthLopByUser,
      monthTransferByUser,
      settledPeriods,
      bulkData,
    );

    history.push({
      periodKey: row.periodKey,
      grossSalary: row.grossSalary,
      workingDays: row.workingDays,
      presentDays: row.presentDays,
      paidLeaveDays: row.paidLeaveDays,
      payableDays: row.payableDays,
      paidDaysOutOf30: row.paidDaysOutOf30,
      payableEstimate: row.payableEstimate,
      asOfDate: row.asOfDate,
      lopDays: row.lopDays,
      lopDeduction: row.lopDeduction,
      perDaySalary: row.perDaySalary,
      otherDeductions: row.otherDeductions,
      totalDeductions: row.totalDeductions,
      netSalary: row.netSalary,
      hasSalaryConfigured: row.hasSalaryConfigured,
      transferStatus: row.transferStatus,
      status: row.status,
    });
  }

  return {
    employee,
    history,
  };
}

// ── API: Monthly salary audit ─────────────────────────────────────────

/**
 * Deactivates employees whose ending date has passed (same sweep as admin employee list).
 */
async function sweepExpiredEmploymentEndings() {
  const now = new Date();
  await User.updateMany(
    { endingDate: { $lte: now }, isActive: true },
    { $set: { isActive: false } },
  );
}

/**
 * Employees who were employed at any point during the audit month.
 * joiningDate (or createdAt fallback) must be on or before month end;
 * still active, no ending date, or ending date on/after month start.
 */
function buildMonthlyAuditEmployeeQuery(periodKey, scopedIds, departmentId) {
  const range = parseMonthInputAsISTRange(periodKey);
  const monthStart = range.start;
  const monthEnd = range.end;

  const employeeQuery = {
    $and: [
      {
        $or: [
          { joiningDate: { $lte: monthEnd } },
          { joiningDate: null, createdAt: { $lte: monthEnd } },
        ],
      },
      {
        $or: [
          { isActive: true },
          { endingDate: { $gte: monthStart } },
          { endingDate: null },
        ],
      },
    ],
  };

  if (scopedIds !== null) {
    employeeQuery._id = { $in: scopedIds };
  }
  if (departmentId) {
    employeeQuery.departmentId = departmentId;
  }

  return employeeQuery;
}

/**
 * Monthly salary audit for RM/Admin: returns audit rows for all employees in scope.
 *
 * Includes employees WITHOUT salary (hasSalaryConfigured: false, monthlySalary: null).
 * Fixed number of DB queries regardless of employee count.
 *
 * @param {object} actor - requesting user
 * @param {Array} permissions - actor's permissions
 * @param {string} periodKey - "YYYY-MM"
 * @returns {object} { periodKey, asOfDate, employees[], totals{} }
 */
export async function getMonthlySalaryAudit(actor, permissions, periodKey, options = {}) {
  validatePeriodKey(periodKey);

  if (options.departmentId) {
    await assertDepartmentInAccessibleSet(actor, permissions, options.departmentId);
  }

  const scopedIds = await getAuditScope(actor, permissions);
  const resolvedAsOf = resolveSalaryAsOfDate(periodKey);
  const asOfDate = resolvedAsOf?.asOfDateKey ?? null;

  await sweepExpiredEmploymentEndings();

  const employeeQuery = buildMonthlyAuditEmployeeQuery(periodKey, scopedIds, options.departmentId);

  const employees = await User.find(employeeQuery)
    .select('_id name employeeCode monthlySalary salaryEffectiveFrom departmentId reportingManagerId joiningDate endingDate createdAt')
    .sort({ name: 1 })
    .lean();

  if (employees.length === 0) {
    return {
      periodKey,
      asOfDate,
      employees: [],
      totals: { employees: 0, lopDays: 0, lopDeduction: 0, totalDeductions: 0, totalNetSalary: 0 },
    };
  }

  const userIds = employees.map((e) => e._id);
  const range = parseMonthInputAsISTRange(periodKey);

  // Bulk fetch: LOP records, settlements, transfers, salary computation data, departments
  const [lopRecordsByUser, settledPeriods, transfersByUser, bulkData] = await Promise.all([
    fetchSettledLopRecordsByUser(userIds, periodKey),
    fetchSettledPeriods(periodKey),
    fetchSalaryTransfersByUser(userIds, periodKey),
    preFetchBulkSalaryData(userIds, range.year, range.start, range.end),
  ]);

  // Bulk fetch departments for name resolution
  const deptIds = [...new Set(employees.map((e) => e.departmentId?.toString()).filter(Boolean))];
  const deptMap = await bulkFetchDepartments(deptIds);

  // Build audit rows using the shared builder (in-memory computation, no N+1)
  const auditRows = [];
  for (const employee of employees) {
    const row = buildAuditRow(employee, periodKey, lopRecordsByUser, transfersByUser, settledPeriods, bulkData);
    // Resolve department name
    row.departmentName = deptMap.get(row.department)?.name ?? null;
    auditRows.push(row);
  }

  const totals = {
    employees: auditRows.length,
    lopDays: roundMoney(auditRows.reduce((sum, r) => sum + r.lopDays, 0)),
    lopDeduction: roundMoney(auditRows.reduce((sum, r) => sum + r.lopDeduction, 0)),
    totalDeductions: roundMoney(auditRows.reduce((sum, r) => sum + r.totalDeductions, 0)),
    totalNetSalary: roundMoney(
      auditRows
        .filter((r) => r.netSalary != null)
        .reduce((sum, r) => sum + r.netSalary, 0),
    ),
  };

  return { periodKey, asOfDate, employees: auditRows, totals };
}

/** Ordered XLSX headers — aligned with TeamAuditSection / SalaryHistorySection table labels. */
export const MONTHLY_SALARY_AUDIT_EXPORT_HEADERS = [
  'Employee Code',
  'Employee Name',
  'Department',
  'Year',
  'Month',
  'As of date',
  'Monthly salary',
  'Working Days',
  'Present Days',
  'Paid Leave Days',
  'Paid days (out of 30)',
  'Loss of pay (days)',
  'Loss of pay till date',
  'Per day salary',
  'Other Deductions (INR)',
  'Total Deductions (INR)',
  'Month-to-date payable',
  'Net',
  'Transfer',
  'Status',
];

/** Human-readable settlement status — mirrors client auditStatusBadge labels. */
export function formatAuditStatusLabel(status) {
  if (status === 'settled') return 'Settled';
  if (status === 'inconsistent') return 'Needs attention';
  return 'Pending estimate';
}

/**
 * Maps one audit API row to an XLSX export row.
 * Month-to-date payable uses payableEstimate (Paid days / MTD column);
 * Net uses netSalary only (Net column) — no cross-fallback between the two.
 */
export function mapAuditRowToExportRow(row, defaultAsOfDate = '') {
  const { year, monthName } = parseSalaryPeriodKey(row.periodKey);
  return {
    'Employee Code': row.employeeCode ?? '',
    'Employee Name': row.employeeName,
    Department: row.departmentName ?? '',
    Year: year,
    Month: monthName,
    'As of date': row.asOfDate ?? defaultAsOfDate ?? '',
    'Monthly salary': row.hasSalaryConfigured ? row.grossSalary : null,
    'Working Days': row.workingDays,
    'Present Days': row.presentDays,
    'Paid Leave Days': row.paidLeaveDays,
    'Paid days (out of 30)': row.paidDaysOutOf30,
    'Loss of pay (days)': row.lopDays,
    'Loss of pay till date': row.hasSalaryConfigured ? row.lopDeduction : null,
    'Per day salary': row.hasSalaryConfigured ? row.perDaySalary : null,
    'Other Deductions (INR)': row.hasSalaryConfigured ? row.otherDeductions : null,
    'Total Deductions (INR)': row.hasSalaryConfigured ? row.totalDeductions : null,
    'Month-to-date payable': row.hasSalaryConfigured ? row.payableEstimate : null,
    Net: row.hasSalaryConfigured ? row.netSalary : null,
    Transfer: row.transferStatus ?? '',
    Status: formatAuditStatusLabel(row.status),
  };
}

/**
 * Exports monthly salary audit to XLSX workbook.
 * Uses the SAME getMonthlySalaryAudit → buildAuditRow chain as the API.
 * Includes departmentName column.
 *
 * @param {object} actor - requesting user
 * @param {Array} permissions - actor's permissions
 * @param {string} periodKey - "YYYY-MM"
 * @returns {{ buffer: Buffer, filename: string }}
 */
export async function exportMonthlySalaryAudit(actor, permissions, periodKey, options = {}) {
  const audit = await getMonthlySalaryAudit(actor, permissions, periodKey, options);

  const rows = audit.employees.map((row) => mapAuditRowToExportRow(row, audit.asOfDate ?? ''));

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Salary Audit');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `salary-audit-${periodKey}.xlsx`;

  return { buffer, filename };
}
