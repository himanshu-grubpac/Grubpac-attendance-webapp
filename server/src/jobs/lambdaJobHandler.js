import { ensureMongoConnection } from '../config/db.js';
import { DB_UNAVAILABLE_RESPONSE } from '../config/lambdaResponses.js';
import { runAutoCheckoutJob } from './autoCheckoutJob.js';
import {
  runLeaveDecisionNotifyJob,
  recoverPendingSubmitNotificationsSafe,
  runHelpAttachmentCleanupJob,
} from './leaveJobs.js';

const JOBS = {
  'auto-checkout': runAutoCheckoutJob,
  'leave-decision-notify': runLeaveDecisionNotifyJob,
  'help-attachment-cleanup': runHelpAttachmentCleanupJob,
};

export const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await ensureMongoConnection();
  } catch (error) {
    console.error(JSON.stringify({
      msg: 'Job Lambda MongoDB connect failed',
      error: error?.name ?? 'Error',
      message: error?.message,
    }));
    return DB_UNAVAILABLE_RESPONSE;
  }

  // SQS wake-ups from per-action delayed finalization (see
  // services/leaveFinalizeQueue.js). Each message targets one request's
  // finalize time; the sweep below is revision-guarded and idempotent, so
  // duplicate/redelivered messages are harmless no-ops. Batch size is 1.
  if (Array.isArray(event?.Records) && event.Records[0]?.eventSource === 'aws:sqs') {
    const messageIds = event.Records.map((record) => record?.messageId).filter(Boolean);
    console.log(JSON.stringify({
      msg: 'Job started',
      jobName: 'leave-decision-notify',
      trigger: 'sqs',
      batchSize: event.Records.length,
      requestId: context?.awsRequestId,
    }));
    try {
      await recoverPendingSubmitNotificationsSafe();
      const result = await runLeaveDecisionNotifyJob();
      return {
        statusCode: 200,
        body: JSON.stringify({ job: 'leave-decision-notify', trigger: 'sqs', ...result }),
        batchItemFailures: [],
      };
    } catch (error) {
      console.error(JSON.stringify({
        msg: 'Job leave-decision-notify failed',
        trigger: 'sqs',
        error: error?.name ?? 'Error',
        message: error?.message,
        requestId: context?.awsRequestId,
      }));
      // Report the batch as failed so SQS retries, then DLQs after
      // maxReceiveCount; the 1-minute EventBridge sweep still backs this up.
      return {
        statusCode: 200,
        body: JSON.stringify({ job: 'leave-decision-notify', trigger: 'sqs', retried: true }),
        batchItemFailures: messageIds.map((itemIdentifier) => ({ itemIdentifier })),
      };
    }
  }

  const jobName = event?.jobName || event?.detail?.jobName;
  const jobFn = JOBS[jobName];

  if (!jobFn) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: `Unknown job: ${jobName}`,
        availableJobs: Object.keys(JOBS),
      }),
    };
  }

  const startedAt = Date.now();
  console.log(JSON.stringify({
    msg: 'Job started',
    jobName,
    requestId: context?.awsRequestId,
  }));

  try {
    if (jobName === 'leave-decision-notify') {
      await recoverPendingSubmitNotificationsSafe();
    }
    const result = await jobFn();
    console.log(JSON.stringify({
      msg: 'Job completed',
      jobName,
      durationMs: Date.now() - startedAt,
      requestId: context?.awsRequestId,
      result,
    }));
    return {
      statusCode: 200,
      body: JSON.stringify({ job: jobName, ...result }),
    };
  } catch (error) {
    console.error(JSON.stringify({
      msg: `Job ${jobName} failed`,
      error: error?.name ?? 'Error',
      message: error?.message,
      stack: error?.stack,
      durationMs: Date.now() - startedAt,
      requestId: context?.awsRequestId,
    }));
    return {
      statusCode: 500,
      body: JSON.stringify({ message: `Job ${jobName} failed.`, code: 'JOB_ERROR' }),
    };
  }
};
