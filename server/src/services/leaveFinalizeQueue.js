import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../config/env.js';

/**
 * Per-action delayed finalization for Lambda deployments.
 *
 * Why this exists: EventBridge `rate()` cannot fire faster than once per
 * minute, so the 1-minute `LeaveNotifyScheduleRule` caps Lambda delivery
 * precision. SQS `DelaySeconds` (0–900s) lets the API schedule ONE wake-up
 * targeted at a specific request's finalize time (`notifyAfter`), giving
 * seconds-level precision on Lambda.
 *
 * Safety properties (unchanged from the poller design):
 * - SQS is standard (at-least-once): duplicate/redelivered messages are
 *   harmless — the sweep only finalizes the live revision (`pendingRevision`
 *   match) and notifications are claimed exactly once.
 * - The 1-minute EventBridge sweep stays as the safety net for anything SQS
 *   misses (send failure, DLQ overflow, queue misconfiguration).
 * - Fail-open: without `LEAVE_FINALIZE_QUEUE_URL` (local/EC2/tests) this is
 *   a no-op returning `{ scheduled: false }`; send errors are logged, never
 *   thrown, so staging a decision can never fail because the queue is down.
 */

const MAX_DELAY_SECONDS = 900; // SQS DelaySeconds limit

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  // Region + credentials come from the Lambda execution environment/role.
  cachedClient = new SQSClient({});
  return cachedClient;
}

/**
 * Seconds from `now` until `notifyAfter`, clamped to the SQS DelaySeconds
 * range. Pure — unit tested.
 */
export function computeFinalizeDelaySeconds(notifyAfter, now = new Date()) {
  const target = notifyAfter instanceof Date ? notifyAfter.getTime() : new Date(notifyAfter).getTime();
  const base = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(target) || !Number.isFinite(base)) return 0;
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil((target - base) / 1000)));
}

/**
 * Schedules one finalize wake-up for a provisional leave action.
 * MUST be awaited on Lambda (frozen event loop drops un-awaited sends).
 *
 * @param {{ requestId: string, kind: 'submit'|'decision'|'cancel', notifyAfter: Date, revision?: number }} args
 * @returns {Promise<{ scheduled: boolean, reason?: string, delaySeconds?: number }>}
 */
export async function scheduleLeaveFinalize({ requestId, kind, notifyAfter, revision = null }) {
  const queueUrl = env.leaveFinalizeQueueUrl;
  if (!queueUrl) {
    return { scheduled: false, reason: 'queue_not_configured' };
  }
  if (!requestId || !notifyAfter) {
    return { scheduled: false, reason: 'missing_target' };
  }

  const delaySeconds = computeFinalizeDelaySeconds(notifyAfter);
  const body = JSON.stringify({
    type: 'leave-finalize',
    requestId: String(requestId),
    kind: kind ?? 'decision',
    notifyAfter: new Date(notifyAfter).toISOString(),
    revision,
  });

  try {
    await getClient().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        DelaySeconds: delaySeconds,
      }),
    );
    return { scheduled: true, delaySeconds };
  } catch (err) {
    console.error(JSON.stringify({
      msg: 'leave finalize schedule failed (safety-net sweep still applies)',
      requestId: String(requestId),
      error: err?.name ?? 'Error',
      message: err?.message,
    }));
    return { scheduled: false, reason: 'send_failed' };
  }
}
