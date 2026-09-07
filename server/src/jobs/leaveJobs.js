import { refreshAccruedEntitlements, ensureBalancesForUser } from '../services/leaveBalanceService.js';
import { runLeaveDecisionNotifyJob as leaveServiceRunLeaveDecisionNotifyJob, recoverPendingSubmitNotifications } from '../services/leaveService.js';
import { cleanupStalePendingAttachments } from '../services/helpAttachmentService.js';
import { User } from '../models/User.js';
import { getISTYear } from '../utils/istDate.js';
import { logError } from '../utils/logger.js';
import { acquireJobLock, releaseJobLock } from '../utils/jobLock.js';

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
export async function runLeaveDecisionNotifyJob(now = new Date()) {
  const lock = await acquireJobLock('leave-decision-notify', { ttlMs: 120_000 });
  if (!lock.acquired) {
    return { skipped: true, reason: lock.reason };
  }
  try {
    return await leaveServiceRunLeaveDecisionNotifyJob(now);
  } finally {
    await releaseJobLock('leave-decision-notify', lock.lockId);
  }
}

/**
 * Delete orphaned pending help attachments (uploaded to S3 but never
 * confirmed) and their S3 objects. Runs on a daily schedule on Lambda because
 * the API Lambda never executes startServer()'s interval cleanup.
 * Idempotent — safe to call multiple times.
 */
export async function runHelpAttachmentCleanupJob() {
  const deleted = await cleanupStalePendingAttachments();
  return { job: 'help-attachment-cleanup', ...deleted, completedAt: new Date().toISOString() };
}

/**
 * Recover stale pending submit notifications (Lambda cold-start safe).
 * Idempotent — safe to call multiple times.
 */
export async function recoverPendingSubmitNotificationsSafe() {
  try {
    return await recoverPendingSubmitNotifications();
  } catch (err) {
    logError('leave_submit_notification_recovery_failed', { error: err?.message });
    return { recovered: 0 };
  }
}

export function startLeaveDecisionNotifyScheduler(intervalMs = 30 * 1000) {
  if (process.env.NODE_ENV === 'test') return null;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return null;

  recoverPendingSubmitNotifications().catch((err) => {
    logError('leave_submit_notification_recovery_failed', { error: err?.message });
  });

  const run = () => {
    runLeaveDecisionNotifyJob().catch((err) => {
      logError('leave_deferred_decision_notify_job_failed', { error: err?.message });
    });
  };
  run();
  return setInterval(run, intervalMs);
}