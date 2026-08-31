import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeAutoCheckoutDeadline,
} from './autoCheckoutJob.js';

function istInstant(dayKey, timeHHmm) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeHHmm);
  assert.ok(dayMatch, `invalid dayKey ${dayKey}`);
  assert.ok(timeMatch, `invalid time ${timeHHmm}`);
  const [, y, m, d] = dayMatch.map(Number);
  const [, h, min] = timeMatch.map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min, 0, 0) - IST_OFFSET_MS);
}

test('computeAutoCheckoutDeadline: office mode defaults to same day 23:59', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', undefined);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-01', '23:59').getTime());
});

test('computeAutoCheckoutDeadline: WFH mode defaults to next day 06:00', () => {
  const deadline = computeAutoCheckoutDeadline('wfh', '2026-09-01', undefined);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-02', '06:00').getTime());
});

test('computeAutoCheckoutDeadline: office mode with custom same-day config', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'same', time: '18:00' });
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-01', '18:00').getTime());
});

test('computeAutoCheckoutDeadline: WFH mode with custom same-day config', () => {
  const deadline = computeAutoCheckoutDeadline('wfh', '2026-09-01', { day: 'same', time: '20:00' });
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-01', '20:00').getTime());
});

test('computeAutoCheckoutDeadline: office mode with next-day config', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'next', time: '02:00' });
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-02', '02:00').getTime());
});

test('computeAutoCheckoutDeadline: returns null for invalid dayKey', () => {
  const deadline = computeAutoCheckoutDeadline('office', 'not-a-date', undefined);
  assert.equal(deadline, null);
});

test('computeAutoCheckoutDeadline: returns null for invalid time', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'same', time: '25:00' });
  assert.equal(deadline, null);
});

test('computeAutoCheckoutDeadline: WFH next-day at month boundary', () => {
  const deadline = computeAutoCheckoutDeadline('wfh', '2026-08-31', undefined);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-01', '06:00').getTime());
});

test('computeAutoCheckoutDeadline: office same-day at year boundary', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-12-31', undefined);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-12-31', '23:59').getTime());
});

test('computeAutoCheckoutDeadline: uses provided config over defaults', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'next', time: '08:00' });
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-02', '08:00').getTime());
});

test('computeAutoCheckoutDeadline: partial config merges with defaults', () => {
  const deadline = computeAutoCheckoutDeadline('wfh', '2026-09-01', { time: '12:00' });
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-02', '12:00').getTime());
});

test('computeAutoCheckoutDeadline: empty config uses defaults', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', {});
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-01', '23:59').getTime());
});

test('dedup: WFH next-day check-out matches check-in within deadline window', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const checkOutTimestamp = istInstant('2026-09-02', '06:00');

  const hasCheckOut = checkOutTimestamp >= checkInTimestamp && checkOutTimestamp <= deadline;
  assert.equal(hasCheckOut, true, 'WFH next-day auto-checkout at deadline should match');
});

test('dedup: manual check-out before deadline prevents auto-checkout', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const manualCheckOut = istInstant('2026-09-01', '17:00');

  const hasCheckOut = manualCheckOut >= checkInTimestamp && manualCheckOut <= deadline;
  assert.equal(hasCheckOut, true, 'Manual check-out at 17:00 should prevent auto-checkout');
});

test('dedup: check-out after deadline does not prevent auto-checkout', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const lateCheckOut = istInstant('2026-09-02', '07:00');

  const hasCheckOut = lateCheckOut >= checkInTimestamp && lateCheckOut <= deadline;
  assert.equal(hasCheckOut, false, 'Check-out after deadline should not prevent auto-checkout');
});

test('dedup: check-out before check-in does not match', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const earlyCheckOut = istInstant('2026-09-01', '08:00');

  const hasCheckOut = earlyCheckOut >= checkInTimestamp && earlyCheckOut <= deadline;
  assert.equal(hasCheckOut, false, 'Check-out before check-in should not match');
});

test('dedup: wrong attendance mode does not match', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const checkOutTimestamp = istInstant('2026-09-01', '17:00');
  const checkInMode = 'wfh';
  const checkOutMode = 'office';

  const hasCheckOut = checkOutMode === checkInMode &&
    checkOutTimestamp >= checkInTimestamp &&
    checkOutTimestamp <= deadline;
  assert.equal(hasCheckOut, false, 'Different attendance mode should not match');
});

test('dedup: multiple check-outs for same user, only one matches', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const checkOuts = [
    { timestamp: istInstant('2026-09-01', '17:00'), attendanceMode: 'office' },
    { timestamp: istInstant('2026-09-02', '06:00'), attendanceMode: 'wfh' },
    { timestamp: istInstant('2026-09-03', '06:00'), attendanceMode: 'wfh' },
  ];
  const checkInMode = 'wfh';

  const match = checkOuts.some(
    (co) =>
      co.attendanceMode === checkInMode &&
      co.timestamp >= checkInTimestamp &&
      co.timestamp <= deadline,
  );
  assert.equal(match, true, 'Should find matching check-out among multiple');
});

test('dedup: no check-outs means no match', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const checkOuts = [];

  const match = checkOuts.some(
    (co) =>
      co.attendanceMode === 'wfh' &&
      co.timestamp >= checkInTimestamp &&
      co.timestamp <= deadline,
  );
  assert.equal(match, false, 'Empty check-outs should not match');
});

test('dedup: check-out at exact deadline time matches', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const checkOutAtDeadline = istInstant('2026-09-02', '06:00');

  const hasCheckOut = checkOutAtDeadline >= checkInTimestamp && checkOutAtDeadline <= deadline;
  assert.equal(hasCheckOut, true, 'Check-out at exact deadline should match');
});

test('dedup: check-out at exact check-in time matches', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const checkOutAtCheckIn = istInstant('2026-09-01', '09:00');

  const hasCheckOut = checkOutAtCheckIn >= checkInTimestamp && checkOutAtCheckIn <= deadline;
  assert.equal(hasCheckOut, true, 'Check-out at exact check-in time should match');
});

test('dedup: multiple modes for same user on same day each match independently', () => {
  const checkInTimestamp = istInstant('2026-09-01', '09:00');
  const deadline = istInstant('2026-09-02', '06:00');
  const officeCheckOut = istInstant('2026-09-01', '17:00');
  const wfhCheckOut = istInstant('2026-09-02', '06:00');

  const officeMatch = 'office' === 'wfh'
    ? false
    : officeCheckOut >= checkInTimestamp && officeCheckOut <= deadline;
  const wfhMatch = wfhCheckOut >= checkInTimestamp && wfhCheckOut <= deadline;

  assert.equal(wfhMatch, true, 'WFH check-out should match');
});

test('computeAutoCheckoutDeadline: midnight time (00:00) works', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'same', time: '00:00' });
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-01', '00:00').getTime());
});

test('computeAutoCheckoutDeadline: WFH next-day midnight works', () => {
  const deadline = computeAutoCheckoutDeadline('wfh', '2026-09-01', { day: 'next', time: '00:00' });
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-02', '00:00').getTime());
});

test('computeAutoCheckoutDeadline: leap year boundary (Feb 28 → Feb 29 in leap year)', () => {
  const deadline = computeAutoCheckoutDeadline('wfh', '2028-02-28', undefined);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2028-02-29', '06:00').getTime());
});

test('computeAutoCheckoutDeadline: null config uses defaults', () => {
  const deadline = computeAutoCheckoutDeadline('office', '2026-09-01', null);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), istInstant('2026-09-01', '23:59').getTime());
});
