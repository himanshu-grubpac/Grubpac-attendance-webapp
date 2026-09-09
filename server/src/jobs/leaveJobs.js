import { refreshAccruedEntitlements, ensureBalancesForUser } from '../services/leaveBalanceService.js';
import { runLeaveDecisionNotifyJob as leaveServiceRunLeaveDecisionNotifyJob, recoverPendingSubmitNotifications } from '../services/leaveService.js';
import { cleanupStalePendingAttachments } from '../services/helpAttachmentService.js';
import { settleMonthPayroll } from '../services/lopSettlementService.js';
import { MonthSettlement } from '../models/MonthSettlement.js';
import { User } from '../models/User.js';
import { getISTDateInputValue, getISTYear } from '../utils/istDate.js';
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

/**
 * Finalizer cadence. 5s keeps the deliberate ~2.5s post-expiry notification
 * delay tight on long-run servers (each tick runs one indexed sweep +
 * JobLock-guarded job). Lambda keeps its 1-minute EventBridge schedule
 * (template.yaml) — delivery there lags accordingly by design.
 */
export function startLeaveDecisionNotifyScheduler(intervalMs = 5 * 1000) {
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

/**
 * Auto month-end settlement: settles the previous month if not already settled.
 * Runs daily. Idempotent — safe to call multiple times.
 * Uses a system actor ID (null) since this is an automated job.
 */
export async function runMonthEndSettlementJob(now = new Date()) {
  const lock = await acquireJobLock('month-end-settlement', { ttlMs: 300_000 });
  if (!lock.acquired) {
    return { skipped: true, reason: lock.reason };
  }
  try {
    // Compute previous month in YYYY-MM format
    const todayKey = getISTDateInputValue(now);
    const [yearStr, monthStr] = todayKey.split('-');
    let prevYear = Number(yearStr);
    let prevMonth = Number(monthStr) - 1;
    if (prevMonth < 1) {
      prevMonth = 12;
      prevYear -= 1;
    }
    const prevMonthKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

    // Check if already settled
    const existing = await MonthSettlement.findOne({ periodKey: prevMonthKey });
    if (existing) {
      return {
        settled: false,
        alreadySettled: true,
        periodKey: prevMonthKey,
        job: 'month-end-settlement',
        completedAt: new Date().toISOString(),
      };
    }

    // Settle previous month (system actor = null)
    const result = await settleMonthPayroll(prevMonthKey, null);

    return {
      ...result,
      job: 'month-end-settlement',
      completedAt: new Date().toISOString(),
    };
  } finally {
    await releaseJobLock('month-end-settlement', lock.lockId);
  }
}

/**
 * Daily scheduler for month-end settlement. Checks once per day if the
 * previous month needs settling. Runs at 00:05 IST (5 minutes after midnight).
 */
export function startMonthEndSettlementScheduler() {
  if (process.env.NODE_ENV === 'test') return null;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return null;

  const run = () => {
    runMonthEndSettlementJob().catch((err) => {
      logError('month_end_settlement_job_failed', { error: err?.message });
    });
  };

  // Run once on startup (delayed 10s to avoid boot contention)
  const initial = setTimeout(() => { run(); }, 10_000);
  if (initial.unref) initial.unref();

  // Run every 24 hours
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}