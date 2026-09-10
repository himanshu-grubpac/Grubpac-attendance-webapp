import mongoose from 'mongoose';
import { LopRecord } from '../models/LopRecord.js';
import { MonthSettlement } from '../models/MonthSettlement.js';
import { LeaveBalance, LEAVE_BALANCE_POPULATE } from '../models/LeaveBalance.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { User } from '../models/User.js';
import { getISTYear } from '../utils/istDate.js';
import {
  computeMonthlySalarySummary,
  generatePendingSalaryTransfers,
  loadPaidLeaveTypeIds,
  unionWfhLeaveTypeId,
} from './salaryService.js';
import {
  ensureBalancesForUser,
  getPaidLeaveQuota,
  refreshAccruedEntitlements,
} from './leaveBalanceService.js';
import {
  getISTDateInputValue,
  countWorkingDaysIST,
  listWorkingDaysIST,
  parseMonthInputAsISTRange,
  startOfDayIST,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';
import { getHolidayDateSet } from './leaveService.js';
import { auditLog } from '../utils/auditLog.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
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
 * Creates LOP records when a leave request is finalized (approved).
 * Called after approvePendingDays() inside the same transaction.
 *
 * Determines the unpaid portion by checking the balance after approval:
 *   available = entitled + carried - used - pending - encashed
 * If available < 0, the negative portion is LOP.
 *
 * Idempotent: skips if a LopRecord already exists for this leaveRequestId.
 *
 * @param {ObjectId} userId
 * @param {ObjectId} leaveTypeId
 * @param {ObjectId} leaveRequestId
 * @param {Date} startDate - leave start date
 * @param {number} days - total leave days
 * @param {object} session - MongoDB session (optional)
 * @returns {object|null} created LopRecord or null if no LOP
 */
export async function createLopOnApproval(userId, leaveTypeId, leaveRequestId, startDate, days, session = null) {
  const year = getISTYear(startDate);
  const periodKey = getISTDateInputValue(startDate).slice(0, 7);

  // Check if LOP record already exists (idempotent)
  const existingQuery = LopRecord.findOne({ leaveRequestId });
  if (session) existingQuery.session(session);
  const existing = await existingQuery;
  if (existing) {
    return existing;
  }

  // Load balance after approval
  const balanceQuery = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) balanceQuery.session(session);
  const balance = await balanceQuery;
  if (!balance) {
    return null;
  }

  // Calculate available balance
  const available = (balance.entitled ?? 0) + (balance.carried ?? 0) -
    (balance.used ?? 0) - (balance.pending ?? 0) - (balance.encashed ?? 0);

  // If balance is not negative, no LOP
  if (available >= 0) {
    return null;
  }

  // LOP days = min(days, |available|) — the portion beyond paid quota
  const lopDays = Math.min(days, Math.abs(available));

  if (lopDays <= 0) {
    return null;
  }

  const lopData = {
    userId,
    leaveTypeId,
    leaveRequestId,
    leaveDate: startDate,
    periodKey,
    days: lopDays,
    deductionAmount: 0, // Will be calculated at settlement time
    status: 'pending',
    year,
  };

  let record;
  if (session) {
    const created = await LopRecord.create([lopData], { session });
    record = created[0];
  } else {
    record = await LopRecord.create(lopData);
  }

  auditLog('lop_record_created', {
    userId: userId.toString(),
    leaveRequestId: leaveRequestId.toString(),
    leaveTypeId: leaveTypeId.toString(),
    periodKey,
    lopDays,
  });

  return record;
}

/**
 * Identifies which approved leave requests caused LOP for a given month.
 *
 * Reuses the same chronological quota-consumption logic as buildPaidLeaveDayMap:
 * per leave type per calendar year, the first `paidQuota` approved leave days
 * count as paid. Days beyond that are LOP.
 *
 * CRITICAL: Quota is consumed for ALL working days in each request (not just
 * days in the target month). This ensures previous months' leaves correctly
 * reduce the annual paid quota before the current month's leaves are evaluated.
 *
 * @param {Array} yearLeaveRequests - All approved requests for the year up to month end
 * @param {Date} monthStart - IST month start
 * @param {Date} monthEnd - IST month end
 * @param {Set} holidayDates - Company holiday dates
 * @param {Set} paidTypeIds - Paid leave type IDs
 * @param {Map} paidQuotaByTypeId - Per-type paid quota (entitled + carried - encashed)
 * @returns {Array<{ leaveRequestId: string, leaveTypeId: string, lopDays: number }>}
 */
export function computeLopCauses(
  yearLeaveRequests,
  monthStart,
  monthEnd,
  holidayDates,
  paidTypeIds,
  paidQuotaByTypeId,
) {
  const lopCauses = [];
  const monthStartKey = getISTDateInputValue(monthStart);
  const monthEndKey = getISTDateInputValue(monthEnd);

  if (!(paidQuotaByTypeId instanceof Map) || paidQuotaByTypeId.size === 0) {
    return lopCauses;
  }

  const remainingQuota = new Map(paidQuotaByTypeId);
  const ordered = [...yearLeaveRequests].sort(compareLeaveRequestsChronologically);
  const lopByRequest = new Map();

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
    let lopDays = 0;

    const workingDayList = listWorkingDaysIST(
      request.startDate,
      request.endDate,
      holidayDates,
    );

    for (const day of workingDayList) {
      const key = typeof day === 'string' ? day : getISTDateInputValue(day);

      // Consume quota for ALL working days (not just days in the month window).
      // This ensures July leaves consume quota before August leaves are evaluated.
      const paidSlice = Math.min(perDay, quotaLeft);
      quotaLeft -= paidSlice;

      // Only track LOP for days that fall within the target month.
      if (key >= monthStartKey && key <= monthEndKey) {
        lopDays += perDay - paidSlice;
      }
    }

    remainingQuota.set(typeId, quotaLeft);

    if (lopDays > 0.001) {
      const requestId = request._id?.toString?.() ?? request._id;
      lopByRequest.set(requestId, {
        leaveRequestId: requestId,
        leaveTypeId: typeId,
        lopDays: roundMoney(lopDays),
      });
    }
  }

  return [...lopByRequest.values()];
}

/**
 * Resets negative `carried` balance to 0 while preserving positive carry-forward.
 * Only affects the `carried` field — entitled, used, pending, encashed are untouched.
 */
export async function resetNegativeBalances(userId, year, session = null) {
  const query = LeaveBalance.find({ userId, year, carried: { $lt: 0 } });
  if (session) query.session(session);
  const negativeBalances = await query;

  for (const balance of negativeBalances) {
    balance.carried = 0;
    await balance.save(session ? { session } : undefined);
  }

  return negativeBalances.length;
}

/**
 * Marks pending LopRecord entries as settled for the given user and period.
 * Sets deductionAmount based on perDaySalary and status to 'settled'.
 * Creates records for any LOP causes that don't have existing records
 * (backwards compatibility / edge cases).
 * Returns the total number of settled records.
 */
export async function recordLopForMonth(userId, periodKey, lopCauses, year, perDaySalary, session = null) {
  let settled = 0;

  for (const cause of lopCauses) {
    const query = {
      userId,
      leaveTypeId: cause.leaveTypeId,
      periodKey,
      leaveRequestId: cause.leaveRequestId,
    };

    const update = {
      $set: {
        days: cause.lopDays,
        deductionAmount: roundMoney(cause.lopDays * (perDaySalary ?? 0)),
        status: 'settled',
        settledAt: new Date(),
      },
      $setOnInsert: {
        userId,
        leaveTypeId: cause.leaveTypeId,
        leaveRequestId: cause.leaveRequestId,
        leaveDate: new Date(`${periodKey}-01`),
        periodKey,
        year,
      },
    };

    const result = await LopRecord.updateOne(query, update, {
      upsert: true,
      ...(session ? { session } : {}),
    });

    settled += result.upsertedCount + result.modifiedCount;
  }

  return settled;
}

/**
 * Month-end settlement: finalizes LOP, records it, resets negative balances,
 * generates salary transfers, and marks the month as settled.
 *
 * ALL operations run inside a SINGLE transaction — if any employee or
 * salary transfer fails, the entire month's settlement rolls back.
 *
 * Idempotent — running for the same month multiple times returns early.
 *
 * @param {string} periodKey - "YYYY-MM"
 * @param {ObjectId|null} actorId - User who triggered settlement (null for scheduler)
 * @returns {object} settlement result
 */
export async function settleMonthPayroll(periodKey, actorId) {
  const range = parseMonthInputAsISTRange(periodKey);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  // Idempotent: check if already settled (outside transaction — fast path)
  const existing = await MonthSettlement.findOne({ periodKey });
  if (existing) {
    return {
      settled: false,
      alreadySettled: true,
      periodKey,
      settledAt: existing.settledAt,
      message: `Month ${periodKey} was already settled on ${existing.settledAt.toISOString()}.`,
    };
  }

  const { year, start, end } = range;
  const holidayDates = await getHolidayDateSet(year);
  const yearStart = startOfDayIST(parseDateInputAsISTDay(`${year}-01-01`));

  const paidTypeIds = await loadPaidLeaveTypeIds(year);

  const employees = await User.find({
    isActive: true,
    monthlySalary: { $ne: null, $gt: 0 },
  }).select('_id name employeeCode monthlySalary salaryEffectiveFrom');

  // Pre-fetch entitlements outside the transaction (idempotent, safe to retry)
  for (const employee of employees) {
    await refreshAccruedEntitlements(employee._id, year);
    await ensureBalancesForUser(employee._id, year);
  }

  // Single transaction for the entire month settlement
  const session = await mongoose.startSession();
  let settlementDoc;
  let transferResult;
  let totalLopDays = 0;
  let employeesWithLop = 0;
  let totalLopRecords = 0;

  try {
    await session.withTransaction(async () => {
      for (const employee of employees) {
        // Get balances for paid quota calculation (inside transaction)
        const balances = await LeaveBalance.find({ userId: employee._id, year })
          .session(session)
          .select('leaveTypeId entitled carried encashed');

        const paidQuotaByTypeId = new Map(
          balances.map((balance) => [
            balance.leaveTypeId.toString(),
            getPaidLeaveQuota(balance),
          ]),
        );

        // Get all approved requests for the year up to month end (inside transaction)
        const yearLeaveRequests = await LeaveRequest.find({
          userId: employee._id,
          status: 'approved',
          startDate: { $lte: end },
          endDate: { $gte: yearStart },
        })
          .session(session)
          .select('leaveTypeId startDate endDate days halfDay');

        // Identify which requests caused LOP (uses the same logic as salary calculation)
        const lopCauses = computeLopCauses(
          yearLeaveRequests,
          start,
          end,
          holidayDates,
          paidTypeIds,
          paidQuotaByTypeId,
        );

        // Calculate perDaySalary for deduction amounts
        const workingDaysInMonth = countWorkingDaysIST(start, end, holidayDates);
        const monthlySalary = employee.monthlySalary ?? 0;
        const perDaySalary = workingDaysInMonth > 0 ? roundMoney(monthlySalary / workingDaysInMonth) : 0;

        if (lopCauses.length > 0) {
          const employeeLopDays = lopCauses.reduce((sum, c) => sum + c.lopDays, 0);
          totalLopDays += employeeLopDays;
          employeesWithLop += 1;

          // Mark LOP records as settled (inside transaction)
          const recordsSettled = await recordLopForMonth(
            employee._id,
            periodKey,
            lopCauses,
            year,
            perDaySalary,
            session,
          );
          totalLopRecords += recordsSettled;
        }

        // Reset negative carried balances to 0 (inside transaction)
        await resetNegativeBalances(employee._id, year, session);
      }

      // Generate pending salary transfers (inside transaction — idempotent)
      transferResult = await generatePendingSalaryTransfers(periodKey, actorId, session);

      // Mark month as settled (inside transaction)
      const [doc] = await MonthSettlement.create([{
        periodKey,
        settledAt: new Date(),
        settledBy: actorId,
        employeesProcessed: employees.length,
      }], { session });
      settlementDoc = doc;
    });
  } finally {
    session.endSession();
  }

  auditLog('month_settled', {
    periodKey,
    settledBy: actorId?.toString?.() ?? 'system',
    employeesProcessed: employees.length,
    employeesWithLop,
    totalLopDays: roundMoney(totalLopDays),
    totalLopRecords,
    transfersCreated: transferResult?.created ?? 0,
  });

  return {
    settled: true,
    periodKey,
    settledAt: settlementDoc.settledAt,
    employeesProcessed: employees.length,
    employeesWithLop,
    totalLopDays: roundMoney(totalLopDays),
    totalLopRecords,
    transfersCreated: transferResult?.created ?? 0,
    transfersSkipped: transferResult?.skipped ?? 0,
  };
}
