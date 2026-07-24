import { refreshAccruedEntitlements, ensureBalancesForUser } from '../services/leaveBalanceService.js';
import { User } from '../models/User.js';
import { getISTYear } from '../utils/istDate.js';

/**
 * Monthly leave accrual refresh for all active employees (current IST year).
 * Schedule via cron / EventBridge: npm run jobs:accrual
 */
export async function runMonthlyAccrualJob(asOfDate = new Date()) {
  const year = getISTYear(asOfDate);
  const users = await User.find({ isActive: true }).select('_id');

  for (const user of users) {
    await refreshAccruedEntitlements(user._id, year, asOfDate);
    await ensureBalancesForUser(user._id, year, asOfDate);
  }

  return {
    year,
    usersProcessed: users.length,
    job: 'accrual',
    completedAt: new Date().toISOString(),
  };
}

export { applyYearEndCarryForward as runYearEndCarryForwardJob } from '../services/leaveBalanceService.js';
