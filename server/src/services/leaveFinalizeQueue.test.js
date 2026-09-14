import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeFinalizeDelaySeconds,
  scheduleLeaveFinalize,
} from './leaveFinalizeQueue.js';

test('delay is ceil seconds until notifyAfter', () => {
  const now = new Date('2026-09-07T10:00:00.000Z');
  assert.equal(
    computeFinalizeDelaySeconds(new Date('2026-09-07T10:00:12.500Z'), now),
    13,
  );
});

test('past finalize time clamps to zero (deliver immediately)', () => {
  const now = new Date('2026-09-07T10:00:00.000Z');
  assert.equal(computeFinalizeDelaySeconds(new Date('2026-09-07T09:59:00.000Z'), now), 0);
});

test('delay clamps to the SQS 900s maximum', () => {
  const now = new Date('2026-09-07T10:00:00.000Z');
  assert.equal(computeFinalizeDelaySeconds(new Date('2026-09-07T12:00:00.000Z'), now), 900);
});

test('invalid dates clamp to zero instead of throwing', () => {
  assert.equal(computeFinalizeDelaySeconds(undefined), 0);
  assert.equal(computeFinalizeDelaySeconds('not-a-date'), 0);
});

test('scheduling without a queue URL is a fail-open no-op', async () => {
  // No LEAVE_FINALIZE_QUEUE_URL in test env → must not throw, must not send.
  const result = await scheduleLeaveFinalize({
    requestId: '507f1f77bcf86cd799439013',
    kind: 'decision',
    notifyAfter: new Date(Date.now() + 17500),
    revision: 1,
  });
  assert.equal(result.scheduled, false);
  assert.equal(result.reason, 'queue_not_configured');
});

test('scheduling without a target is a fail-open no-op', async () => {
  const result = await scheduleLeaveFinalize({ requestId: '', kind: 'submit', notifyAfter: null });
  assert.equal(result.scheduled, false);
});

test('comp-off kind follows the same fail-open path without a queue', async () => {
  const result = await scheduleLeaveFinalize({
    requestId: '507f1f77bcf86cd799439013',
    kind: 'comp-off',
    notifyAfter: new Date(Date.now() + 17500),
    revision: 2,
  });
  assert.equal(result.scheduled, false);
  assert.equal(result.reason, 'queue_not_configured');
});
