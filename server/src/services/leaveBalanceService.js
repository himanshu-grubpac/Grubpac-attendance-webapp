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

export function computeEntitledForPolicy(policy, year, asOfDate = new Date()) {
  if (policy.accrualPerMonth > 0 && year === getISTYear(asOfDate)) {
    const monthsElapsed = getISTMonth(asOfDate);
    return Math.min(policy.annualQuota, monthsElapsed * policy.accrualPerMonth);
  }
  return policy.annualQuota;
}

export async function seedLeaveTypesAndPolicies() {
  const typeMap = new Map();

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

  for (const seedPolicy of SEED_LEAVE_POLICIES) {
    const leaveType = typeMap.get(seedPolicy.typeCode);
    if (!leaveType) continue;

    const { typeCode, ...policyFields } = seedPolicy;
    let policy = await LeavePolicy.findOne({ leaveTypeId: leaveType._id });
    if (!policy) {
      policy = await LeavePolicy.create({ ...policyFields, leaveTypeId: leaveType._id });
      console.log(`Seeded leave policy for ${typeCode}`);
    } else {
      Object.assign(policy, policyFields);
      policy.isActive = true;
      await policy.save();
      console.log(`Updated leave policy for ${typeCode}`);
    }
  }

  return typeMap;
}

export async function getActivePolicies() {
  return LeavePolicy.find({ isActive: true }).populate(LEAVE_POLICY_POPULATE);
}

export async function getPolicyMap() {
  const policies = await getActivePolicies();
  const map = new Map();
  for (const policy of policies) {
    const typeId = policy.leaveTypeId?._id?.toString() ?? policy.leaveTypeId?.toString();
    if (typeId) map.set(typeId, policy);
  }
  return map;
}

export async function ensureBalancesForUser(userId, year = getISTYear(), asOfDate = new Date()) {
  if (!mongoose.isValidObjectId(userId)) {
    throwError('Invalid user.');
  }

  const policies = await getActivePolicies();
  const balances = [];

  for (const policy of policies) {
    const entitled = computeEntitledForPolicy(policy, year, asOfDate);
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
      });
    } else if (policy.accrualPerMonth > 0) {
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

export function getAvailableBalance(balance) {
  return Math.max(
    0,
    (balance.entitled ?? 0) +
      (balance.carried ?? 0) -
      (balance.used ?? 0) -
      (balance.pending ?? 0) -
      (balance.encashed ?? 0),
  );
}

export async function refreshAccruedEntitlements(userId, year = getISTYear(), asOfDate = new Date()) {
  const policies = await getActivePolicies();
  for (const policy of policies) {
    if (policy.accrualPerMonth <= 0) continue;
    const balance = await LeaveBalance.findOne({
      userId,
      leaveTypeId: policy.leaveTypeId._id ?? policy.leaveTypeId,
      year,
    });
    if (balance) {
      balance.entitled = computeEntitledForPolicy(policy, year, asOfDate);
      await balance.save();
    }
  }
}

export async function getBalancesForUser(userId, year = getISTYear()) {
  await refreshAccruedEntitlements(userId, year);
  const balances = await ensureBalancesForUser(userId, year);
  return balances.map((item) => item.toSafeJSON());
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
    if (typeId === pendingTypeId) {
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

export async function reservePendingDays(userId, leaveTypeId, days, year = getISTYear()) {
  const balance = await LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (!balance) {
    throwError('Leave balance not found for this year.');
  }

  const available = getAvailableBalance(balance);
  if (days > available) {
    throwError(`Insufficient leave balance. Available: ${available} day(s).`);
  }

  balance.pending += days;
  await balance.save();
  return balance;
}

export async function releasePendingDays(userId, leaveTypeId, days, year = getISTYear(), session = null) {
  const query = LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (session) query.session(session);
  const balance = await query;
  if (!balance) return null;

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

export function resolveLeaveYear(startDateInput) {
  const start = parseDateInputAsISTDay(startDateInput);
  return getISTYear(start);
}

export async function recordEncashment(userId, payload, actorId) {
  const { leaveTypeId, year, days, reason } = payload;
  await ensureBalancesForUser(userId, year);

  const policy = await LeavePolicy.findOne({ leaveTypeId, isActive: true });
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

  const available = getAvailableBalance(balance);
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
async function prepareCarryForwardBalances(userId, fromYear, toYear, policies, session = null) {
  const years = [fromYear, toYear];
  const balanceMap = await loadBalanceMapForUser(userId, years, session);
  const inserts = [];
  const accrualUpdates = [];

  for (const year of years) {
    for (const policy of policies) {
      const typeId = policyTypeId(policy);
      if (!typeId) continue;

      const key = balanceMapKey(year, typeId);
      const entitled = computeEntitledForPolicy(policy, year);

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
        });
        continue;
      }

      if (year === fromYear && policy.accrualPerMonth > 0) {
        const balance = balanceMap.get(key);
        if (balance.entitled !== entitled) {
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

async function buildUserCarryForwardPlan(
  userId,
  fromYear,
  policies,
  existingEntryMap,
  session = null,
) {
  const toYear = fromYear + 1;
  const balanceMap = await prepareCarryForwardBalances(
    userId,
    fromYear,
    toYear,
    policies,
    session,
  );

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
  const policies = (await getActivePolicies()).filter(isCarryForwardEligiblePolicy);

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
    const plan = await buildUserCarryForwardPlan(user._id, fromYear, policies, existingEntryMap);
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

async function applyUserCarryForwardPlan(
  userId,
  fromYear,
  policies,
  appliedBy,
  session,
  existingEntryMap = null,
) {
  const toYear = fromYear + 1;
  const entryMap = existingEntryMap ?? (await loadExistingEntryMap(userId, fromYear, session));
  const plan = await buildUserCarryForwardPlan(userId, fromYear, policies, entryMap, session);
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
  const policies = (await getActivePolicies()).filter(isCarryForwardEligiblePolicy);

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
          policies,
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
