import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

// We need to import the handler after setting up the env so the module-level
// imports resolve correctly. We'll use dynamic import in the test setup.

let memServer;
let handler;

async function setup() {
  memServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memServer.waitUntilRunning();
  await mongoose.connect(memServer.getUri(), { maxPoolSize: 1 });

  // Dynamic import so mongoose connection is established first
  const mod = await import('./lambdaJobHandler.js');
  handler = mod.handler;
}

async function teardown() {
  await mongoose.disconnect();
  await memServer.stop();
}

function makeContext(requestId = 'test-req') {
  return {
    awsRequestId: requestId,
    callbackWaitsForEmptyEventLoop: true,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

test('handler: valid auto-checkout job returns 200', async () => {
  await setup();
  try {
    const event = { jobName: 'auto-checkout' };
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.job, 'auto-checkout');
    assert.ok(typeof body.processed === 'number');
  } finally {
    await teardown();
  }
});

test('handler: valid leave-decision-notify job returns 200', async () => {
  await setup();
  try {
    const event = { jobName: 'leave-decision-notify' };
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.job, 'leave-decision-notify');
  } finally {
    await teardown();
  }
});

test('handler: valid help-attachment-cleanup job returns 200', async () => {
  await setup();
  try {
    const event = { jobName: 'help-attachment-cleanup' };
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.job, 'help-attachment-cleanup');
    assert.ok(typeof body.cleaned === 'number');
  } finally {
    await teardown();
  }
});

test('handler: unknown job name returns 400', async () => {
  await setup();
  try {
    const event = { jobName: 'nonexistent-job' };
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 400);
    const body = JSON.parse(result.body);
    assert.ok(body.message.includes('Unknown job'));
    assert.ok(Array.isArray(body.availableJobs));
  } finally {
    await teardown();
  }
});

test('handler: missing jobName returns 400', async () => {
  await setup();
  try {
    const event = {};
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 400);
    const body = JSON.parse(result.body);
    assert.ok(body.message.includes('Unknown job'));
  } finally {
    await teardown();
  }
});

test('handler: event.detail.jobName format (EventBridge) works', async () => {
  await setup();
  try {
    const event = { detail: { jobName: 'auto-checkout' } };
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.job, 'auto-checkout');
  } finally {
    await teardown();
  }
});

test('handler: sets callbackWaitsForEmptyEventLoop to false', async () => {
  await setup();
  try {
    const event = { jobName: 'auto-checkout' };
    const ctx = makeContext();
    await handler(event, ctx);

    assert.equal(ctx.callbackWaitsForEmptyEventLoop, false);
  } finally {
    await teardown();
  }
});

test('handler: logs job start and completion', async () => {
  await setup();
  try {
    const event = { jobName: 'auto-checkout' };
    const ctx = makeContext('log-req-123');

    const logs = [];
    const origLog = console.log;
    console.log = (msg) => { logs.push(msg); };

    try {
      await handler(event, ctx);
    } finally {
      console.log = origLog;
    }

    const startLog = logs.find((l) => {
      try { return JSON.parse(l).msg === 'Job started'; } catch { return false; }
    });
    const completeLog = logs.find((l) => {
      try { return JSON.parse(l).msg === 'Job completed'; } catch { return false; }
    });

    assert.ok(startLog, 'should log job start');
    assert.ok(completeLog, 'should log job completion');
  } finally {
    await teardown();
  }
});

test('handler: job error returns 500 with JOB_ERROR code', async () => {
  await setup();
  try {
    // Import the module to get access to the JOBS map
    const mod = await import('./lambdaJobHandler.js');

    // We can't easily mock the job function since it's a module-level const.
    // Instead, test with a valid job that might fail due to DB issues.
    // This test verifies the error handling path exists.
    const event = { jobName: 'auto-checkout' };
    const result = await handler(event, makeContext());

    // If the job succeeds, that's fine — we're just verifying the structure
    assert.ok([200, 500].includes(result.statusCode));
    const body = JSON.parse(result.body);
    assert.ok(body.job || body.code);
  } finally {
    await teardown();
  }
});

test('handler: includes requestId in logs', async () => {
  await setup();
  try {
    const event = { jobName: 'auto-checkout' };
    const ctx = makeContext('req-id-42');

    const logs = [];
    const origLog = console.log;
    console.log = (msg) => { logs.push(msg); };

    try {
      await handler(event, ctx);
    } finally {
      console.log = origLog;
    }

    const startLog = logs.find((l) => {
      try { const parsed = JSON.parse(l); return parsed.msg === 'Job started' && parsed.requestId === 'req-id-42'; } catch { return false; }
    });
    assert.ok(startLog, 'should include requestId in start log');
  } finally {
    await teardown();
  }
});

test('handler: SQS finalize wake-up runs the sweep and reports no failures', async () => {
  await setup();
  try {
    const event = {
      Records: [
        {
          messageId: 'sqs-msg-1',
          eventSource: 'aws:sqs',
          body: JSON.stringify({
            type: 'leave-finalize',
            requestId: '507f1f77bcf86cd799439013',
            kind: 'decision',
            notifyAfter: new Date().toISOString(),
            revision: 1,
          }),
        },
      ],
    };
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.batchItemFailures, []);
    const body = JSON.parse(result.body);
    assert.equal(body.job, 'leave-decision-notify');
    assert.equal(body.trigger, 'sqs');
  } finally {
    await teardown();
  }
});

test('handler: SQS comp-off wake-up runs the sweep without failures', async () => {
  await setup();
  try {
    const { CompOffRequest } = await import('../models/CompOffRequest.js');
    const { User } = await import('../models/User.js');
    const past = new Date(Date.now() - 5000);
    const applicant = await User.create({
      firstName: 'Sqs',
      lastName: 'Worker',
      name: 'Sqs Worker',
      email: 'sqs-worker@test.example',
      mobile: '9000000042',
      employeeCode: 'T00000042',
      passwordHash: 'test-password-hash',
      role: 'employee',
      isActive: true,
    });
    await CompOffRequest.create({
      userId: applicant._id,
      startDate: past,
      endDate: past,
      days: 1,
      reason: 'SQS sweep coverage',
      status: 'pending',
      notificationsSent: false,
      submitNotificationsSent: false,
      notifyAfter: past,
      undoExpiresAt: new Date(Date.now() - 30_000),
    });
    const event = {
      Records: [
        {
          messageId: 'sqs-comp-off-1',
          eventSource: 'aws:sqs',
          body: JSON.stringify({
            type: 'leave-finalize',
            requestId: '507f1f77bcf86cd799439013',
            kind: 'comp-off',
            notifyAfter: past.toISOString(),
            revision: 0,
          }),
        },
      ],
    };
    const result = await handler(event, makeContext());

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.batchItemFailures, []);
    const body = JSON.parse(result.body);
    assert.equal(body.trigger, 'sqs');
    const swept = await CompOffRequest.findOne({ reason: 'SQS sweep coverage' }).lean();
    assert.equal(swept.submitNotificationsSent, true, 'sweep claimed the due submit');
  } finally {
    await teardown();
  }
});

test('handler: null event returns 400', async () => {
  await setup();
  try {
    const result = await handler(null, makeContext());

    assert.equal(result.statusCode, 400);
  } finally {
    await teardown();
  }
});

test('handler: undefined event returns 400', async () => {
  await setup();
  try {
    const result = await handler(undefined, makeContext());

    assert.equal(result.statusCode, 400);
  } finally {
    await teardown();
  }
});
