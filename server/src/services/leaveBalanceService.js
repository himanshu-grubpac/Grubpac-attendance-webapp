import mongoose from 'mongoose';
import { SEED_LEAVE_POLICIES, SEED_LEAVE_TYPES } from '../../../shared/permissions.js';
import {
  getISTDateInputValue,
  getISTMonth,
  getISTYear,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeavePolicy, LEAVE_POLICY_POPULATE } from '../models/LeavePolicy.js';
import { LeaveBalance, LEAVE_BALANCE_POPULATE } from '../models/LeaveBalance.js';
import { LeaveCarryForwardEntry } from '../models/LeaveCarryForwardEntry.js';
import { User } from '../models/User.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

export function computeEntitledForPolicy(policy, year, asOfDate = new Date(), joiningDate = null) {
  const currentYear = getISTYear(asOfDate);

  if (policy.accrualPerMonth > 0 && year === currentYear) {
    const asOfMonth = getISTMonth(asOfDate);
    let accrualMonths = asOfMonth;
    if (joiningDate) {
      const joinYear = getISTYear(joiningDate);
      if (joinYear === year) {
        accrualMonths = asOfMonth - getISTMonth(joiningDate) + 1;
      } else if (joinYear > year) {
        accrualMonths = 0;
      }
    }
    accrualMonths = Math.max(0, accrualMonths);
    return Math.min(policy.annualQuota, accrualMonths * policy.accrualPerMonth);
  }

  if (joiningDate) {
    const joinYear = getISTYear(joiningDate);
    if (joinYear === year) {
      const joinMonth = getISTMonth(joiningDate);
      const remainingMonths = 12 - joinMonth + 1;
      return Math.min(policy.annualQuota, Math.ceil((policy.annualQuota * remainingMonths) / 12));
    }
    if (joinYear > year) {
      return 0;
    }
  }

  return policy.annualQuota;
}

export function roundToHalfDay(value) {
  return Math.round((Number(value) ?? 0) * 2) / 2;
}

/**
 * Monthly-eligible joining-date proration, applied to EVERY leave type for
 * EVERY employee: (annualQuota / 12) × eligibleMonths, where eligibleMonths
 * counts the joining month through December inclusive.
 * - No joining date (or joined on/before Jan 1) → full quota.
 * - Joined after Dec 31 → 0.
 * - NOTE: accrualPerMonth / asOfDate are accepted for signature compatibility
 *   but no longer gate the math — entitlements vest upfront for the whole year
 *   (pro-rated by joining month). A monthly cap made quotas unreachable
 *   (e.g. 30/mo can never reach a 365 quota: 12 × 30 = 360).
 */
export function computeProratedEntitled({
  annualQuota,
  accrualPerMonth = 0,
  year,
  joiningDateKey = null,
  asOfDate = new Date(),
}) {
  void accrualPerMonth;
  void asOfDate;
  const quota = Number(annualQuota) ?? 0;
  let proratedQuota = quota;
  if (joiningDateKey && /^\d{4}-\d{2}-\d{2}$/.test(joiningDateKey)) {
    const yearStartKey = `${year}-01-01`;
    const yearEndKey = `${year}-12-31`;
    if (joiningDateKey > yearEndKey) {
      return 0;
    }
    if (joiningDateKey > yearStartKey) {
      const joinDate = parseDateInputAsISTDay(joiningDateKey);
      const joinMonth = getISTMonth(joinDate);
      const eligibleMonths = 12 - joinMonth + 1;
      proratedQuota = Math.min(quota, Math.ceil((quota * eligibleMonths) / 12));
    }
  }
  return proratedQuota;
}

/**
 * Effective leave start of a user as an IST YYYY-MM-DD key
 * (contract start → joining date → null when neither is set).
 */
export async function getUserLeaveStartKey(userId) {
  const user = await User.findById(userId).select('joiningDate salaryEffectiveFrom');
  const raw = user?.salaryEffectiveFrom ?? user?.joiningDate ?? null;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return getISTDateInputValue(date);
}

/** Matches AdminLeavePolicies year selector: current IST year ±2..+1. */
export function defaultLeavePolicySeedYears(asOfDate = new Date()) {
  const currentYear = getISTYear(asOfDate);
  return [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];
}

export async function seedLeaveTypesAndPolicies(options = {}) {
  const typeMap = new Map();
  const years = options.years ?? defaultLeavePolicySeedYears();

  for (const seedType of SEED_LEAVE_TYPES) {
    let leaveType = await LeaveType.findOne({ code: seedType.code });
    if (!leaveType) {
      leaveType = await LeaveType.create(seedType);
      console.log(`Seeded leave type: ${seedType.code}`);
    } else {
      leaveType.name = seedType.name;
      leaveType.isActive = true;
      await leaveType.save();
    }
    typeMap.set(seedType.code, leaveType);
  }

  for (const year of years) {
    for (const seedPolicy of SEED_LEAVE_POLICIES) {
      const leaveType = typeMap.get(seedPolicy.typeCode);
      if (!leaveType) continue;

      const { typeCode, ...policyFields } = seedPolicy;
      let policy = await LeavePolicy.findOne({ leaveTypeId: leaveType._id, year });
      if (!policy) {
        policy = await LeavePolicy.create({
          ...policyFields,
          leaveTypeId: leaveType._id,
          year,
        });
        console.log(`Seeded leave policy for ${typeCode} (${year})`);
      } else {
        // Create-only: never overwrite an admin-configured policy. Overwriting
        // quotas here used to silently clobber live policies (and orphan the
        // balances computed from them) every time seed/migrations ran.
        console.log(`Kept existing leave policy for ${typeCode} (${year})`);
      }
    }
  }

  return typeMap;
}

/**
 * Assigns current IST year to legacy policies missing year (idempotent).
 */
export async function migrateLeavePolicyYears() {
  const currentYear = getISTYear();
  const legacyPolicies = await LeavePolicy.find({
    $or: [{ year: { $exists: false } }, { year: null }],
  });

  for (const policy of legacyPolicies) {
    policy.year = currentYear;
    await policy.save();
    console.log(
      `Backfilled leave policy year=${currentYear} for leaveTypeId=${policy.leaveTypeId.toString()}`,
    );
  }

  return legacyPolicies.length;
}

export async function getActivePoliciesForYear(year = getISTYear()) {
  return LeavePolicy.find({ isActive: true, year }).populate(LEAVE_POLICY_POPULATE);
}

/**
 * Active policies for a calendar year. Falls back to current IST year when none exist.
 */
export async function resolvePoliciesForYear(year = getISTYear()) {
  let policies = await getActivePoliciesForYear(year);
  const currentYear = getISTYear();
  if (policies.length === 0 && year !== currentYear) {
    policies = await getActivePoliciesForYear(currentYear);
  }
  return policies;
}

/**
 * Policy for a leave type and year. Falls back to current IST year when missing.
 */
export async function resolvePolicyForLeaveType(leaveTypeId, year = getISTYear()) {
  let policy = await LeavePolicy.findOne({ leaveTypeId, isActive: true, year }).populate(
    LEAVE_POLICY_POPULATE,
  );
  const currentYear = getISTYear();
  if (!policy && year !== currentYear) {
    policy = await LeavePolicy.findOne({
      leaveTypeId,
      isActive: true,
      year: currentYear,
    }).populate(LEAVE_POLICY_POPULATE);
  }
  return policy;
}

/** @deprecated Use resolvePoliciesForYear(year) */
export async function getActivePolicies(year = getISTYear()) {
  return resolvePoliciesForYear(year);
}

export async function getPolicyMapForYear(year = getISTYear()) {
  const policies = await resolvePoliciesForYear(year);
  const map = new Map();
  for (const policy of policies) {
    const typeId = policy.leaveTypeId?._id?.toString() ?? policy.leaveTypeId?.toString();
    if (typeId) map.set(typeId, policy);
  }
  return map;
}

/** @deprecated Use getPolicyMapForYear(year) */
export async function getPolicyMap(year = getISTYear()) {
  return getPolicyMapForYear(year);
}

export async function ensureBalancesForUser(userId, year = getISTYear(), asOfDate = new Date()) {
  if (!mongoose.isValidObjectId(userId)) {
    throwError('Invalid user.');
  }

  const user = await User.findById(userId).select('joiningDate').lean();
  const joiningDate = user?.joiningDate || null;
  const policies = await resolvePoliciesForYear(year);
  const joiningDateKey = await getUserLeaveStartKey(userId);
  const balances = [];

  for (const policy of policies) {
    const entitled = computeProratedEntitled({
      annualQuota: policy.annualQuota,
      accrualPerMonth: policy.accrualPerMonth,
      year,
      joiningDateKey,
      asOfDate,
    });
    let balance = await LeaveBalance.findOne({
      userId,
      leaveTypeId: policy.leaveTypeId._id ?? policy.leaveTypeId,
      year,
    });

    if (!balance) {
      balance = await LeaveBalance.create({
        userId,
        leaveTypeId: policy.leaveTypeId._id ?? policy.leaveTypeId,
        year,
        entitled,
        used: 0,
        pending: 0,
        carried: 0,
        encashed: 0,
        compOffEarned: 0,
      });
    } else if (!balance.entitledLocked && balance.entitled !== entitled) {
      // Heal-on-read: any unlocked row converges to the computed value.
      // Deliberate manual tweaks are protected by entitledLocked (set only
      // when an admin hand-tunes entitled) — never by value-sniffing, which
      // froze stale rows whenever the stored value differed from the quota
      // for any other reason (older quota era, recreated policies, …).
      balance.entitled = entitled;
      await balance.save();
    }

    balances.push(balance);
  }

  return LeaveBalance.find({ userId, year }).populate(LEAVE_BALANCE_POPULATE);
}

export async function initBalancesForAllUsers(year = getISTYear()) {
  const users = await User.find({ isActive: true }).select('_id');
  for (const user of users) {
    await ensureBalancesForUser(user._id, year);
  }
}

/**
 * Recalculate entitled for all active users when a policy is updated.
 * Uses each user's DOJ for pro-rata computation.
 * Returns the count of updated balances.
 */
export async function recalculateAllBalancesForPolicy(policy) {
  const year = policy.year || getISTYear();
  const leaveTypeId = policy.leaveTypeId?._id ?? policy.leaveTypeId;

  const activeUsers = await User.find({ isActive: true }).select('_id joiningDate').lean();
  const userIds = activeUsers.map((u) => u._id);
  const userJoiningDateMap = new Map(activeUsers.map((u) => [u._id.toString(), u.joiningDate]));

  const existingBalances = await LeaveBalance.find({
    userId: { $in: userIds },
    leaveTypeId,
    year,
  }).lean();

  const existingByUser = new Map(
    existingBalances.map((b) => [b.userId.toString(), b]),
  );

  const updates = [];
  const inserts = [];

  for (const userId of userIds) {
    const entitled = computeEntitledForPolicy(
      policy,
      year,
      new Date(),
      userJoiningDateMap.get(userId.toString()),
    );
    const existing = existingByUser.get(userId.toString());
    if (existing) {
      if (existing.entitledLocked) {
        continue;
      }
      updates.push({
        updateOne: {
          filter: { _id: existing._id },
          update: { $set: { entitled } },
        },
      });
    } else {
      inserts.push({
        userId,
        leaveTypeId,
        year,
        entitled,
        used: 0,
        pending: 0,
        carried: 0,
        encashed: 0,
        compOffEarned: 0,
      });
    }
  }

  const bulkResults = updates.length > 0
    ? await LeaveBalance.bulkWrite(updates, { ordered: false })
    : { modifiedCount: 0 };

  if (inserts.length > 0) {
    await LeaveBalance.insertMany(inserts, { ordered: false });
  }

  return bulkResults.modifiedCount + inserts.length;
}

/**
 * Remaining leave stock. May be negative when overdrawn leave is allowed
 * (used/pending can exceed entitled + carried − encashed).
 */
export function getAvailableBalance(balance) {
  return (
    (balance.entitled ?? 0) +
    (balance.carried ?? 0) +
    (balance.compOffEarned ?? 0) -
    (balance.used ?? 0) -
    (balance.pending ?? 0) -
    (balance.encashed ?? 0)
  );
}

/** Paid leave days available for salary before overdraw (excludes used/pending). */
export function getPaidLeaveQuota(balance) {
  return Math.max(
    0,
    (balance.entitled ?? 0) + (balance.carried ?? 0) + (balance.compOffEarned ?? 0) - (balance.encashed ?? 0),
  );
}

/**
 * Convergence pass for unlocked rows: recomputes entitled from the current
 * policy so stale values heal on read. Kept as a separate pass (also run by
 * the monthly job) alongside ensureBalancesForUser. Writes nothing when the
 * stored value already matches; locked rows are never touched.
 */
export async function refreshAccruedEntitlements(userId, year = getISTYear(), asOfDate = new Date()) {
  const user = await User.findById(userId).select('joiningDate').lean();
  const joiningDate = user?.joiningDate || null;
  const policies = await resolvePoliciesForYear(year);
  const joiningDateKey = await getUserLeaveStartKey(userId);
  for (const policy of policies) {
    if (policy.accrualPerMonth <= 0) continue;
    const balance = await LeaveBalance.findOne({
      userId,
      leaveTypeId: policy.leaveTypeId._id ?? policy.leaveTypeId,
      year,
    });
    if (balance && !balance.entitledLocked) {
      const entitled = computeProratedEntitled({
        annualQuota: policy.annualQuota,
        accrualPerMonth: policy.accrualPerMonth,
        year,
        joiningDateKey,
        asOfDate,
      });
      if (balance.entitled !== entitled) {
        balance.entitled = entitled;
        await balance.save();
      }
    }
  }
}

export async function getBalancesForUser(userId, year = getISTYear()) {
  await refreshAccruedEntitlements(userId, year);
  const balances = await ensureBalancesForUser(userId, year);
  return balances.map((item) => item.toSafeJSON());
}

/**
 * Propagates a mid-year policy change to every balance row of that policy's
 * year: recomputes `entitled` (with joining-date proration) for all UNLOCKED
 * rows. Rows hand-locked via the manual adjustment API are counted as skipped
 * and left untouched. Idempotent — re-running converges to the same values.
 */
export async function recomputeEntitledForPolicy(policyId, { year = null, asOfDate = new Date() } = {}) {
  const policy = await LeavePolicy.findById(policyId);
  if (!policy) {
    throwError('Leave policy not found.', 404);
  }
  const targetYear = year ?? policy.year ?? getISTYear();
  const typeId = policy.leaveTypeId?._id ?? policy.leaveTypeId;

  const skippedLocked = await LeaveBalance.countDocuments({
    leaveTypeId: typeId,
    year: targetYear,
    entitledLocked: true,
  });
  const balances = await LeaveBalance.find({
    leaveTypeId: typeId,
    year: targetYear,
    entitledLocked: { $ne: true },
  }).select('_id userId entitled');

  const userIds = [...new Set(balances.map((balance) => balance.userId.toString()))];
  const users =
    userIds.length > 0
      ? await User.find({ _id: { $in: userIds } }).select('joiningDate salaryEffectiveFrom')
      : [];
  const startKeyByUser = new Map();
  for (const user of users) {
    const raw = user?.salaryEffectiveFrom ?? user?.joiningDate ?? null;
    const date = raw instanceof Date ? raw : raw ? new Date(raw) : null;
    startKeyByUser.set(
      user._id.toString(),
      date && !Number.isNaN(date.getTime()) ? getISTDateInputValue(date) : null,
    );
  }

  let recomputed = 0;
  for (const balance of balances) {
    const entitled = computeProratedEntitled({
      annualQuota: policy.annualQuota,
      accrualPerMonth: policy.accrualPerMonth,
      year: targetYear,
      joiningDateKey: startKeyByUser.get(balance.userId.toString()) ?? null,
      asOfDate,
    });
    if (balance.entitled !== entitled) {
      balance.entitled = entitled;
      await balance.save();
      recomputed += 1;
    }
  }

  return {
    policyId: policy._id.toString(),
    year: targetYear,
    total: balances.length,
    recomputed,
    skippedLocked,
  };
}

export async function adjustBalance(userId, payload, adjustedBy) {
  const { leaveTypeId, year, reason, ...fields } = payload;
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      await ensureBalancesForUser(userId, year);

      const balanceQuery = LeaveBalance.findOne({ userId, leaveTypeId, year }).session(session);
      const balance = await balanceQuery;
      if (!balance) {
        throwError('Leave balance not found.', 404);
      }

      for (const key of ['entitled', 'used', 'pending', 'carried', 'encashed']) {
        if (fields[key] !== undefined) {
          balance[key] = fields[key];
        }
      }
      // A hand-tuned entitled value opts out of proration and policy-change
      // recompute from here on.
      if (fields.entitled !== undefined) {
        balance.entitledLocked = true;
      }

      await balance.save({ session });

      result = {
        balance: (await LeaveBalance.findById(balance._id).session(session).populate(LEAVE_BALANCE_POPULATE)).toSafeJSON(),
        reason,
        adjustedBy: adjustedBy?.toString?.() ?? adjustedBy,
      };
    });
    return result;
  } finally {
    session.endSession();
  }
}

export async function validateCombinedAccumulation(
  userId,
  year,
  policyMap,
  extraPending = 0,
  pendingTypeId = null,
) {
  // The cap governs combined-group accumulation only. A request for a type
  // outside any combined group (e.g. WFH, SL, CO) neither consumes nor grows
  // that stock, so it must be neither gated by nor counted toward the cap —
  // otherwise unrelated requests (like a month of WFH) would falsely trip a
  // "Combined CL+EL" error.
  const pendingKey = pendingTypeId?._id?.toString?.() ?? pendingTypeId?.toString?.() ?? null;
  const pendingPolicy = pendingKey ? policyMap.get(pendingKey) : null;
  if (!pendingPolicy?.combinedCarryGroup) return;

  const balances = await LeaveBalance.find({ userId, year }).populate('leaveTypeId');
  let combinedStock = 0;

  for (const balance of balances) {
    const typeId = balance.leaveTypeId?._id?.toString() ?? balance.leaveTypeId?.toString();
    const policy = policyMap.get(typeId);
    if (!policy?.combinedCarryGroup) continue;

    let stock =
      (balance.entitled ?? 0) +
      (balance.carried ?? 0) -
      (balance.used ?? 0) -
      (balance.pending ?? 0);
    if (typeId === pendingKey) {
      stock -= extraPending;
    }
    combinedStock += Math.max(0, stock);
  }

  combinedStock += extraPending;

  const clElPolicy = [...policyMap.values()].find((p) => p.combinedCarryGroup === 'CL_EL');
  if (clElPolicy && combinedStock > clElPolicy.maxAccumulation) {
    throwError(
      `Combined CL+EL balance cannot exceed ${clElPolicy.maxAccumulation} days (current would be ${combinedStock}).`,
    );
  }
}

export async function reservePendingDays(userId, leaveTypeId, days, year = getISTYear(), session = null) {
  const query = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) query.session(session);
  const balance = await query;
  if (!balance) {
    throwError('Leave balance not found for this year.');
  }

  // Overdrawn leave is allowed: pending may exceed remaining stock (negative available).
  balance.pending += days;
  await balance.save(session ? { session } : undefined);
  return balance;
}

export async function releasePendingDays(userId, leaveTypeId, days, year = getISTYear(), session = null) {
  const query = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) query.session(session);
  const balance = await query;
  if (!balance) {
    console.warn('[leave] releasePendingDays: balance not found', userId?.toString?.(), leaveTypeId?.toString?.(), year);
    return null;
  }

  balance.pending = Math.max(0, balance.pending - days);
  await balance.save(session ? { session } : undefined);
  return balance;
}

export async function approvePendingDays(userId, leaveTypeId, days, year = getISTYear(), session = null) {
  const query = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) query.session(session);
  const balance = await query;
  if (!balance) {
    throwError('Leave balance not found for this year.');
  }

  balance.pending = Math.max(0, balance.pending - days);
  balance.used += days;
  await balance.save(session ? { session } : undefined);
  return balance;
}

export async function reverseApproval(userId, leaveTypeId, days, year = getISTYear(), session = null) {
  const query = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) query.session(session);
  const balance = await query;
  if (!balance) {
    throwError('Leave balance not found for this year.');
  }

  balance.used = Math.max(0, balance.used - days);
  balance.pending += days;
  await balance.save(session ? { session } : undefined);
  return balance;
}

/**
 * Fully releases consumed leave days back to the available balance — used when an
 * approved leave is cancelled by the employee. Unlike reverseApproval (undo flow,
 * which re-queues days as pending), cancellation frees the days entirely so the
 * employee's available balance actually increases.
 */
export async function releaseApprovedDays(userId, leaveTypeId, days, year = getISTYear(), session = null) {
  const query = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) query.session(session);
  const balance = await query;
  if (!balance) {
    throwError('Leave balance not found for this year.');
  }

  balance.used = Math.max(0, balance.used - days);
  balance.pending = Math.max(0, balance.pending - days);
  await balance.save(session ? { session } : undefined);
  return balance;
}

/**
 * Inverse of releaseApprovedDays — restores consumed leave days after an
 * approved-leave cancellation is undone. Standard approved leaves carry no
 * pending days, so only `used` is re-consumed.
 */
export async function reclaimApprovedDays(userId, leaveTypeId, days, year = getISTYear(), session = null) {
  const query = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) query.session(session);
  const balance = await query;
  if (!balance) {
    throwError('Leave balance not found for this year.');
  }

  balance.used += days;
  await balance.save(session ? { session } : undefined);
  return balance;
}

export function resolveLeaveYear(startDateInput) {
  const start = parseDateInputAsISTDay(startDateInput);
  return getISTYear(start);
}

export async function recordEncashment(userId, payload, actorId) {
  const { leaveTypeId, year, days, reason } = payload;
  await ensureBalancesForUser(userId, year);

  const policy = await resolvePolicyForLeaveType(leaveTypeId, year);
  if (!policy) {
    throwError('Leave policy not found.', 404);
  }

  if (policy.encashmentMaxPerYear <= 0) {
    throwError('Encashment is not allowed for this leave type.');
  }

  const balance = await LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (!balance) {
    throwError('Leave balance not found.', 404);
  }

  if (balance.encashed + days > policy.encashmentMaxPerYear) {
    throwError(
      `Encashment exceeds policy maximum of ${policy.encashmentMaxPerYear} day(s) per year.`,
    );
  }

  const available = Math.max(0, getAvailableBalance(balance));
  if (days > available) {
    throwError(`Insufficient balance for encashment. Available: ${available} day(s).`);
  }

  balance.encashed += days;
  await balance.save();

  return {
    balance: (await LeaveBalance.findById(balance._id).populate(LEAVE_BALANCE_POPULATE)).toSafeJSON(),
    reason,
    recordedBy: actorId?.toString?.() ?? actorId,
  };
}

/**
 * Paid leave types with carryForwardMax > 0 (or in a combined carry group) are eligible.
 */
export function isCarryForwardEligiblePolicy(policy) {
  if (!policy?.paid || !policy.isActive) return false;
  if (policy.carryForwardMax > 0) return true;
  return Boolean(policy.combinedCarryGroup);
}

function policyTypeId(policy) {
  return (policy.leaveTypeId?._id ?? policy.leaveTypeId)?.toString?.() ?? null;
}

function policyTypeCode(policy) {
  return policy.leaveTypeId?.code ?? null;
}

/**
 * Pure allocation for standalone (non-combined) leave types.
 */
export function computeStandaloneCarryForward(remaining, carryForwardMax) {
  const safeRemaining = Math.max(0, remaining ?? 0);
  const cap = Math.max(0, carryForwardMax ?? 0);
  const carried = Math.min(safeRemaining, cap);
  return {
    remaining: safeRemaining,
    carried,
    forfeited: safeRemaining - carried,
  };
}

/**
 * Pure allocation for CL+EL combined carry group (shared cap across types).
 */
export function computeCombinedCarryForward(items, combinedCap) {
  const cap = Math.max(0, combinedCap ?? 0);
  let combinedRemaining = 0;
  const eligible = [];

  for (const item of items) {
    const remaining = Math.max(0, item.remaining ?? 0);
    if (remaining <= 0) continue;
    combinedRemaining += remaining;
    eligible.push({ ...item, remaining });
  }

  let pool = Math.min(combinedRemaining, cap);
  const allocations = [];

  for (const item of eligible) {
    const carried = Math.min(item.remaining, pool);
    pool -= carried;
    allocations.push({
      leaveTypeId: item.leaveTypeId,
      leaveTypeCode: item.leaveTypeCode,
      remaining: item.remaining,
      carried,
      forfeited: item.remaining - carried,
      combinedGroup: item.combinedGroup ?? 'CL_EL',
      alreadyApplied: Boolean(item.alreadyApplied),
    });
  }

  return allocations;
}

function balanceMapKey(year, leaveTypeId) {
  return `${year}:${leaveTypeId.toString()}`;
}

async function loadBalanceMapForUser(userId, years, session = null) {
  const query = LeaveBalance.find({ userId, year: { $in: years } });
  if (session) query.session(session);
  const balances = await query;
  const map = new Map();
  for (const balance of balances) {
    map.set(balanceMapKey(balance.year, balance.leaveTypeId), balance);
  }
  return map;
}

/**
 * Ensures eligible leave balances exist for carry-forward years and refreshes accrual
 * on fromYear in batched queries (avoids per-policy N+1 round trips).
 */
async function prepareCarryForwardBalances(userId, fromYear, toYear, session = null) {
  const fromYearPolicies = await resolvePoliciesForYear(fromYear);
  const toYearPolicies = await resolvePoliciesForYear(toYear);
  const years = [
    { year: fromYear, policies: fromYearPolicies },
    { year: toYear, policies: toYearPolicies },
  ];
  const balanceMap = await loadBalanceMapForUser(userId, [fromYear, toYear], session);
  const inserts = [];
  const accrualUpdates = [];

  const joiningDateKey = await getUserLeaveStartKey(userId);
  for (const { year, policies } of years) {
    for (const policy of policies) {
      const typeId = policyTypeId(policy);
      if (!typeId) continue;

      const key = balanceMapKey(year, typeId);
      const entitled = computeProratedEntitled({
        annualQuota: policy.annualQuota,
        accrualPerMonth: policy.accrualPerMonth,
        year,
        joiningDateKey,
      });

      if (!balanceMap.has(key)) {
        inserts.push({
          userId,
          leaveTypeId: policy.leaveTypeId._id ?? policy.leaveTypeId,
          year,
          entitled,
          used: 0,
          pending: 0,
          carried: 0,
          encashed: 0,
          compOffEarned: 0,
        });
        continue;
      }

      if (year === fromYear && policy.accrualPerMonth > 0) {
        const balance = balanceMap.get(key);
        if (!balance.entitledLocked && balance.entitled !== entitled) {
          balance.entitled = entitled;
          accrualUpdates.push(balance);
        }
      }
    }
  }

  if (inserts.length > 0) {
    const created = session
      ? await LeaveBalance.insertMany(inserts, { session })
      : await LeaveBalance.insertMany(inserts);
    for (const balance of created) {
      balanceMap.set(balanceMapKey(balance.year, balance.leaveTypeId), balance);
    }
  }

  for (const balance of accrualUpdates) {
    await balance.save(session ? { session } : undefined);
  }

  return balanceMap;
}

function getFromYearBalance(balanceMap, fromYear, typeId) {
  return balanceMap.get(balanceMapKey(fromYear, typeId)) ?? null;
}

async function loadExistingEntryMap(userId, fromYear, session = null) {
  const query = LeaveCarryForwardEntry.find({ userId, fromYear });
  if (session) query.session(session);
  const entries = await query.lean();
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.leaveTypeId.toString(), entry);
  }
  return map;
}

async function buildUserCarryForwardPlan(userId, fromYear, existingEntryMap, session = null) {
  const toYear = fromYear + 1;
  const policies = (await resolvePoliciesForYear(fromYear)).filter(isCarryForwardEligiblePolicy);
  const balanceMap = await prepareCarryForwardBalances(userId, fromYear, toYear, session);

  const lines = [];
  const standalonePolicies = policies.filter(
    (policy) => isCarryForwardEligiblePolicy(policy) && !policy.combinedCarryGroup,
  );
  const combinedPolicies = policies.filter(
    (policy) => isCarryForwardEligiblePolicy(policy) && policy.combinedCarryGroup === 'CL_EL',
  );

  for (const policy of standalonePolicies) {
    const typeId = policyTypeId(policy);
    if (!typeId) continue;

    const existing = existingEntryMap.get(typeId);
    if (existing) {
      lines.push({
        leaveTypeId: typeId,
        leaveTypeCode: policyTypeCode(policy),
        remaining: existing.remaining,
        carried: existing.carried,
        forfeited: existing.forfeited,
        alreadyApplied: true,
      });
      continue;
    }

    const balance = getFromYearBalance(balanceMap, fromYear, typeId);
    if (!balance) continue;

    const allocation = computeStandaloneCarryForward(
      getAvailableBalance(balance),
      policy.carryForwardMax,
    );
    if (allocation.remaining <= 0) continue;

    lines.push({
      leaveTypeId: typeId,
      leaveTypeCode: policyTypeCode(policy),
      ...allocation,
      alreadyApplied: false,
    });
  }

  if (combinedPolicies.length > 0) {
    const combinedCap = combinedPolicies[0].carryForwardMax ?? 20;
    const combinedItems = [];

    for (const policy of combinedPolicies) {
      const typeId = policyTypeId(policy);
      if (!typeId) continue;

      const existing = existingEntryMap.get(typeId);
      if (existing) {
        lines.push({
          leaveTypeId: typeId,
          leaveTypeCode: policyTypeCode(policy),
          remaining: existing.remaining,
          carried: existing.carried,
          forfeited: existing.forfeited,
          combinedGroup: 'CL_EL',
          alreadyApplied: true,
        });
        continue;
      }

      const balance = getFromYearBalance(balanceMap, fromYear, typeId);
      if (!balance) continue;

      combinedItems.push({
        leaveTypeId: typeId,
        leaveTypeCode: policyTypeCode(policy),
        remaining: getAvailableBalance(balance),
        combinedGroup: 'CL_EL',
      });
    }

    if (combinedItems.length > 0) {
      const allocations = computeCombinedCarryForward(combinedItems, combinedCap);
      lines.push(...allocations.map((item) => ({ ...item, alreadyApplied: false })));
    }
  }

  return { userId: userId.toString(), fromYear, toYear, lines };
}

function summarizeCarryForwardPlan(plan, userDoc = null) {
  const pendingLines = plan.lines.filter((line) => !line.alreadyApplied && line.carried > 0);
  const appliedLines = plan.lines.filter((line) => line.alreadyApplied);

  return {
    userId: plan.userId,
    name: userDoc?.name ?? null,
    email: userDoc?.email ?? null,
    lines: plan.lines,
    totalRemaining: plan.lines.reduce((sum, line) => sum + (line.remaining ?? 0), 0),
    totalCarried: pendingLines.reduce((sum, line) => sum + (line.carried ?? 0), 0),
    totalForfeited: plan.lines
      .filter((line) => !line.alreadyApplied)
      .reduce((sum, line) => sum + (line.forfeited ?? 0), 0),
    pendingAdjustments: pendingLines.length,
    alreadyAppliedCount: appliedLines.length,
    hasAlreadyApplied: appliedLines.length > 0,
  };
}

export async function previewYearEndCarryForward(fromYear, options = {}) {
  const { userId, userIds } = options;
  const toYear = fromYear + 1;

  let users;
  if (userId) {
    const user = await User.findById(userId).select('_id name email isActive');
    if (!user?.isActive) {
      throwError('Employee not found or inactive.', 404);
    }
    users = [user];
  } else if (userIds?.length) {
    users = await User.find({ _id: { $in: userIds }, isActive: true }).select('_id name email');
  } else {
    users = await User.find({ isActive: true }).select('_id name email').sort({ name: 1 });
  }

  const employees = [];
  let summaryCarried = 0;
  let summaryForfeited = 0;
  let eligibleEmployees = 0;

  for (const user of users) {
    const existingEntryMap = await loadExistingEntryMap(user._id, fromYear);
    const plan = await buildUserCarryForwardPlan(user._id, fromYear, existingEntryMap);
    const summary = summarizeCarryForwardPlan(plan, user);

    if (summary.totalRemaining > 0 || summary.hasAlreadyApplied) {
      employees.push(summary);
    }
    if (summary.pendingAdjustments > 0) {
      eligibleEmployees += 1;
      summaryCarried += summary.totalCarried;
      summaryForfeited += summary.totalForfeited;
    }
  }

  return {
    fromYear,
    toYear,
    employees,
    summary: {
      employeeCount: employees.length,
      eligibleEmployees,
      totalCarried: summaryCarried,
      totalForfeited: summaryForfeited,
    },
  };
}

async function applyUserCarryForwardPlan(userId, fromYear, appliedBy, session, existingEntryMap = null) {
  const toYear = fromYear + 1;
  const entryMap = existingEntryMap ?? (await loadExistingEntryMap(userId, fromYear, session));
  const plan = await buildUserCarryForwardPlan(userId, fromYear, entryMap, session);
  const pendingLines = plan.lines.filter((line) => !line.alreadyApplied && line.carried > 0);

  if (pendingLines.length === 0) {
    return [];
  }

  const pendingTypeIds = pendingLines.map((line) => line.leaveTypeId);
  const toBalanceDocs = await LeaveBalance.find({
    userId,
    leaveTypeId: { $in: pendingTypeIds },
    year: toYear,
  }).session(session);
  const toBalanceByType = new Map(
    toBalanceDocs.map((balance) => [balance.leaveTypeId.toString(), balance]),
  );

  const entryDocs = [];
  const applied = [];

  for (const line of pendingLines) {
    const toBalance = toBalanceByType.get(line.leaveTypeId);
    if (!toBalance) {
      throwError(`Target balance missing for ${line.leaveTypeCode ?? 'leave type'} (${toYear}).`, 500);
    }

    toBalance.carried += line.carried;
    await toBalance.save({ session });

    entryDocs.push({
      userId,
      leaveTypeId: line.leaveTypeId,
      fromYear,
      toYear,
      remaining: line.remaining,
      carried: line.carried,
      forfeited: line.forfeited,
      appliedBy,
    });

    applied.push({
      userId: userId.toString(),
      leaveTypeId: line.leaveTypeId,
      leaveTypeCode: line.leaveTypeCode,
      fromYear,
      toYear,
      remaining: line.remaining,
      carried: line.carried,
      forfeited: line.forfeited,
      combinedGroup: line.combinedGroup ?? null,
    });
  }

  if (entryDocs.length > 0) {
    await LeaveCarryForwardEntry.insertMany(entryDocs, { session });
  }

  return applied;
}

/**
 * Admin-triggered year-end carry-forward: moves unused stock from fromYear into toYear=fromYear+1
 * using policy caps (SL CF max 23; CL+EL combined CF max 20). Idempotent per user/type/fromYear.
 */
export async function applyYearEndCarryForward(fromYear, options = {}) {
  const { userId, userIds, appliedBy } = options;
  const toYear = fromYear + 1;

  let targetUserIds;
  if (userId) {
    const user = await User.findById(userId).select('_id isActive');
    if (!user?.isActive) {
      throwError('Employee not found or inactive.', 404);
    }
    targetUserIds = [user._id];
  } else if (userIds?.length) {
    const users = await User.find({ _id: { $in: userIds }, isActive: true }).select('_id');
    targetUserIds = users.map((user) => user._id);
    if (targetUserIds.length === 0) {
      throwError('No active employees matched the request.', 404);
    }
  } else {
    const users = await User.find({ isActive: true }).select('_id');
    targetUserIds = users.map((user) => user._id);
  }

  const details = [];
  let totalCarried = 0;
  let totalForfeited = 0;
  let skippedAlreadyApplied = 0;

  for (const targetUserId of targetUserIds) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const existingEntryMap = await loadExistingEntryMap(targetUserId, fromYear, session);
        skippedAlreadyApplied += existingEntryMap.size;

        const applied = await applyUserCarryForwardPlan(
          targetUserId,
          fromYear,
          appliedBy,
          session,
          existingEntryMap,
        );
        details.push(...applied);
      });
    } catch (error) {
      if (error?.code === 11000) {
        throwError(
          `Carry-forward already applied for ${fromYear} → ${toYear} (duplicate entry).`,
          409,
        );
      }
      throw error;
    } finally {
      session.endSession();
    }
  }

  for (const item of details) {
    totalCarried += item.carried;
    totalForfeited += item.forfeited;
  }

  return {
    fromYear,
    toYear,
    adjustments: details.length,
    totalCarried,
    totalForfeited,
    skippedAlreadyApplied,
    details,
  };
}
