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
 * Admin-triggered year-end carry-forward: moves unused stock from fromYear into toYear=fromYear+1
 * using handbook caps (SL CF max 23; CL+EL combined CF max 20).
 */
export async function applyYearEndCarryForward(fromYear) {
  const toYear = fromYear + 1;
  const policies = await getActivePolicies();
  const policyMap = await getPolicyMap();
  const users = await User.find({ isActive: true }).select('_id');
  const results = [];

  for (const user of users) {
    await refreshAccruedEntitlements(user._id, fromYear);
    await ensureBalancesForUser(user._id, fromYear);
    await ensureBalancesForUser(user._id, toYear);

    const clElPolicies = policies.filter((p) => p.combinedCarryGroup === 'CL_EL');
    let combinedRemaining = 0;
    const clElBalances = [];

    for (const policy of policies) {
      const typeId = policy.leaveTypeId._id ?? policy.leaveTypeId;
      const balance = await LeaveBalance.findOne({ userId: user._id, leaveTypeId: typeId, year: fromYear });
      if (!balance) continue;

      const remaining = getAvailableBalance(balance);

      if (policy.combinedCarryGroup === 'CL_EL') {
        combinedRemaining += remaining;
        clElBalances.push({ balance, policy, remaining, typeId });
        continue;
      }

      const cfAmount = Math.min(remaining, policy.carryForwardMax ?? 0);
      if (cfAmount <= 0) continue;

      const toBalance = await LeaveBalance.findOne({
        userId: user._id,
        leaveTypeId: typeId,
        year: toYear,
      });
      if (toBalance) {
        toBalance.carried += cfAmount;
        await toBalance.save();
        results.push({
          userId: user._id.toString(),
          leaveTypeId: typeId.toString(),
          fromYear,
          toYear,
          carried: cfAmount,
        });
      }
    }

    if (clElPolicies.length > 0 && combinedRemaining > 0) {
      const combinedCap = clElPolicies[0].carryForwardMax ?? 20;
      let combinedCF = Math.min(combinedRemaining, combinedCap);

      for (const entry of clElBalances) {
        if (combinedCF <= 0) break;
        const share = Math.min(entry.remaining, combinedCF);
        if (share <= 0) continue;

        const toBalance = await LeaveBalance.findOne({
          userId: user._id,
          leaveTypeId: entry.typeId,
          year: toYear,
        });
        if (toBalance) {
          toBalance.carried += share;
          await toBalance.save();
          combinedCF -= share;
          results.push({
            userId: user._id.toString(),
            leaveTypeId: entry.typeId.toString(),
            fromYear,
            toYear,
            carried: share,
            combinedGroup: 'CL_EL',
          });
        }
      }
    }
  }

  return { fromYear, toYear, adjustments: results.length, details: results };
}
