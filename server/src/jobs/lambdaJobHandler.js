import { ensureMongoConnection } from '../config/db.js';
import { DB_UNAVAILABLE_RESPONSE } from '../config/lambdaResponses.js';
import { runAutoCheckoutJob } from './autoCheckoutJob.js';
import {
  runLeaveDecisionNotifyJob,
  recoverPendingSubmitNotificationsSafe,
} from './leaveJobs.js';

const JOBS = {
  'auto-checkout': runAutoCheckoutJob,
  'leave-decision-notify': runLeaveDecisionNotifyJob,
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
