import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEAVE_APPLY_ADVANCE_ERROR,
  LEAVE_APPLY_DEADLINE_ERROR,
  WFH_CHECKIN_REQUIRES_APPROVAL_ERROR,
  buildISTTimestampFromDayAndTime,
  getTomorrowISTDateKey,
  isPastLeaveApplyCutoff,
  validateLeaveApplyDeadline,
  validateWfhApplyDeadline,
  validateWfhCheckInMode,
  wfhRangeIncludesISTDate,
} from '../../../shared/utils/wfhPolicy.js';

const IST_TODAY = '2026-08-05';
const IST_TOMORROW = '2026-08-06';
const IST_DAY_AFTER = '2026-08-07';

function istInstant(dayKey, timeHHmm) {
  const instant = buildISTTimestampFromDayAndTime(dayKey, timeHHmm);
  assert.ok(instant, `invalid fixture ${dayKey} ${timeHHmm}`);
  return instant;
}

test('validateLeaveApplyDeadline blocks same-day CL and WFH', () => {
  const appliedAt = istInstant(IST_TODAY, '10:00');
  assert.equal(
    validateLeaveApplyDeadline(IST_TODAY, IST_TODAY, 'CL', appliedAt),
    LEAVE_APPLY_ADVANCE_ERROR,
  );
  assert.equal(
    validateLeaveApplyDeadline(IST_TODAY, IST_TODAY, 'WFH', appliedAt),
    LEAVE_APPLY_ADVANCE_ERROR,
  );
});

test('validateLeaveApplyDeadline allows same-day SL', () => {
  const appliedAt = istInstant(IST_TODAY, '10:00');
  assert.equal(validateLeaveApplyDeadline(IST_TODAY, IST_TODAY, 'SL', appliedAt), null);
  assert.equal(validateLeaveApplyDeadline(IST_TODAY, IST_TODAY, 'sl', appliedAt), null);
});

test('validateLeaveApplyDeadline allows tomorrow WFH before 11:59 PM IST', () => {
  const appliedAt = istInstant(IST_TODAY, '23:58');
  assert.equal(validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'WFH', appliedAt), null);
});

test('validateLeaveApplyDeadline blocks single-day tomorrow WFH at 11:59 PM IST', () => {
  const appliedAt = istInstant(IST_TODAY, '23:59');
  assert.equal(
    validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'WFH', appliedAt),
    LEAVE_APPLY_DEADLINE_ERROR,
  );
});

test('validateLeaveApplyDeadline allows CL and EL in the afternoon for tomorrow', () => {
  const appliedAt = istInstant(IST_TODAY, '14:30');
  assert.equal(validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'CL', appliedAt), null);
  assert.equal(validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'EL', appliedAt), null);
});

test('validateLeaveApplyDeadline blocks CL and EL at 11:59 PM IST for tomorrow', () => {
  const appliedAt = istInstant(IST_TODAY, '23:59');
  assert.equal(
    validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'CL', appliedAt),
    LEAVE_APPLY_DEADLINE_ERROR,
  );
  assert.equal(
    validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'EL', appliedAt),
    LEAVE_APPLY_DEADLINE_ERROR,
  );
});

test('validateLeaveApplyDeadline allows custom admin leave types in the afternoon for tomorrow', () => {
  const appliedAt = istInstant(IST_TODAY, '14:30');
  assert.equal(validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'BL', appliedAt), null);
});

test('validateLeaveApplyDeadline allows SL after noon for tomorrow', () => {
  const appliedAt = istInstant(IST_TODAY, '14:30');
  assert.equal(validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'SL', appliedAt), null);
  assert.equal(validateLeaveApplyDeadline(IST_TOMORROW, IST_TOMORROW, 'sl', appliedAt), null);
});

test('validateLeaveApplyDeadline blocks multi-day leave that includes today for non-SL', () => {
  const appliedAt = istInstant(IST_TODAY, '14:30');
  assert.equal(
    validateLeaveApplyDeadline(IST_TODAY, IST_DAY_AFTER, 'CL', appliedAt),
    LEAVE_APPLY_ADVANCE_ERROR,
  );
});

test('validateLeaveApplyDeadline blocks multi-day leave that includes tomorrow after cutoff', () => {
  const appliedAt = istInstant(IST_TODAY, '23:59');
  assert.equal(
    validateLeaveApplyDeadline(IST_TOMORROW, IST_DAY_AFTER, 'CL', appliedAt),
    LEAVE_APPLY_DEADLINE_ERROR,
  );
});

test('validateLeaveApplyDeadline allows multi-day leave starting day-after-tomorrow after cutoff', () => {
  const appliedAt = istInstant(IST_TODAY, '23:59');
  assert.equal(validateLeaveApplyDeadline(IST_DAY_AFTER, IST_DAY_AFTER, 'CL', appliedAt), null);
});

test('validateWfhApplyDeadline remains compatible with WFH-only callers', () => {
  const appliedAt = istInstant(IST_TODAY, '23:59');
  assert.equal(
    validateWfhApplyDeadline(IST_TOMORROW, IST_TOMORROW, appliedAt),
    LEAVE_APPLY_DEADLINE_ERROR,
  );
});

test('isPastLeaveApplyCutoff is false before 11:59 PM and true at 11:59 PM IST', () => {
  assert.equal(isPastLeaveApplyCutoff(istInstant(IST_TODAY, '23:58')), false);
  assert.equal(isPastLeaveApplyCutoff(istInstant(IST_TODAY, '23:59')), true);
});

test('getTomorrowISTDateKey returns next calendar day in IST', () => {
  assert.equal(getTomorrowISTDateKey(istInstant(IST_TODAY, '09:00')), IST_TOMORROW);
});

test('wfhRangeIncludesISTDate detects tomorrow inside a range', () => {
  assert.equal(wfhRangeIncludesISTDate(IST_TODAY, IST_DAY_AFTER, IST_TOMORROW), true);
  assert.equal(wfhRangeIncludesISTDate(IST_DAY_AFTER, IST_DAY_AFTER, IST_TOMORROW), false);
});

test('validateWfhCheckInMode allows office mode without approval', () => {
  assert.equal(validateWfhCheckInMode('office', false), null);
});

test('validateWfhCheckInMode blocks WFH check-in without approved leave', () => {
  assert.equal(
    validateWfhCheckInMode('wfh', false),
    WFH_CHECKIN_REQUIRES_APPROVAL_ERROR,
  );
});

test('validateWfhCheckInMode allows WFH check-in with approved leave', () => {
  assert.equal(validateWfhCheckInMode('wfh', true), null);
});
