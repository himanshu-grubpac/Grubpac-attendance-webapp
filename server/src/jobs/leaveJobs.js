import { refreshAccruedEntitlements, ensureBalancesForUser } from '../services/leaveBalanceService.js';
import { runLeaveDecisionNotifyJob as leaveServiceRunLeaveDecisionNotifyJob } from '../services/leaveService.js';
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

/**
 * Sweeps leave decisions whose undo window has elapsed and sends the deferred
 * email/SMS to the applicant. Decisions that are undone before the window
 * expires never reach this stage, so no mail/SMS is sent for them.
 */
let leaveDecisionNotifyRunning = false;

export async function runLeaveDecisionNotifyJob(now = new Date()) {
  if (leaveDecisionNotifyRunning) {
    return { skipped: true, reason: 'already_running' };
  }
  leaveDecisionNotifyRunning = true;
  try {
    return await leaveServiceRunLeaveDecisionNotifyJob(now);
  } finally {
    leaveDecisionNotifyRunning = false;
  }
}

export function startLeaveDecisionNotifyScheduler(intervalMs = 30 * 1000) {
  const run = () => {
    runLeaveDecisionNotifyJob().catch((err) => {
      console.error('[leave] deferred decision notify job failed', err?.message);
    });
  };
  run();
  return setInterval(run, intervalMs);
}