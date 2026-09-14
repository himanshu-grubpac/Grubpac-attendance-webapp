import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLopCauses } from './lopSettlementService.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';

// Helper to create a mock leave request
function makeRequest(overrides) {
  const { _id, leaveTypeId, startDate, endDate, days, halfDay, ...rest } = overrides;
  return {
    _id: _id || 'req-1',
    leaveTypeId: leaveTypeId || 'type-1',
    startDate: parseDateInputAsISTDay(startDate),
    endDate: parseDateInputAsISTDay(endDate || startDate),
    days: days || 1,
    halfDay: halfDay || null,
    ...rest,
  };
}

test('computeLopCauses returns empty when no paid quota', () => {
  const requests = [makeRequest({ startDate: '2026-08-04', days: 1 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map(),
  );

  assert.deepEqual(result, []);
});

test('computeLopCauses returns empty when sufficient balance (no LOP)', () => {
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 1 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 5]]), // 5 days paid quota
  );

  assert.equal(result.length, 0);
});

test('computeLopCauses identifies LOP when zero balance', () => {
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 1 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 0]]), // 0 days paid quota
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'r1');
  assert.equal(result[0].leaveTypeId, 'type-1');
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses identifies partial LOP with partial balance', () => {
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 1 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 0.5]]), // 0.5 days paid quota
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].lopDays, 0.5);
});

test('computeLopCauses handles half-day LOP', () => {
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 0.5 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 0]]), // 0 days paid quota
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].lopDays, 0.5);
});

test('computeLopCauses consumes quota chronologically', () => {
  // Two requests: first one uses up the quota, second one is LOP
  const requests = [
    makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 1 }),
    makeRequest({ _id: 'r2', startDate: '2026-08-05', days: 1 }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 1]]), // 1 day paid quota
  );

  // r1 uses the 1 day quota (no LOP), r2 is fully LOP
  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'r2');
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses splits LOP across multiple requests', () => {
  // Three requests with 1.5 days quota: r1 uses 1, r2 uses 0.5 + 0.5 LOP, r3 is fully LOP
  const requests = [
    makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 1 }),
    makeRequest({ _id: 'r2', startDate: '2026-08-05', days: 1 }),
    makeRequest({ _id: 'r3', startDate: '2026-08-06', days: 1 }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 1.5]]), // 1.5 days paid quota
  );

  // r1 uses 1 day (no LOP), r2 uses 0.5 paid + 0.5 LOP, r3 is fully LOP
  assert.equal(result.length, 2);
  assert.equal(result[0].leaveRequestId, 'r2');
  assert.equal(result[0].lopDays, 0.5);
  assert.equal(result[1].leaveRequestId, 'r3');
  assert.equal(result[1].lopDays, 1);
});

test('computeLopCauses handles multi-month leave (only counts month portion)', () => {
  // Leave spans Aug 28 - Sep 1 (crosses month boundary)
  // In August: Aug 28, 31 (Aug 29-30 are weekend)
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-08-28', endDate: '2026-09-01', days: 3 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 0]]), // 0 days paid quota
  );

  // Only August working days count: Aug 28 (Thu), Aug 31 (Mon) = 2 working days
  assert.equal(result.length, 1);
  assert.ok(result[0].lopDays > 0);
  assert.ok(result[0].lopDays <= 3); // Not more than the total leave days
});

test('computeLopCauses skips non-paid leave types', () => {
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 1, leaveTypeId: 'unpaid-type' })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']), // only type-1 is paid
    new Map([['type-1', 0]]),
  );

  assert.equal(result.length, 0);
});

test('computeLopCauses handles multiple leave types independently', () => {
  const requests = [
    makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 1, leaveTypeId: 'cl-type' }),
    makeRequest({ _id: 'r2', startDate: '2026-08-05', days: 1, leaveTypeId: 'el-type' }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['cl-type', 'el-type']),
    new Map([
      ['cl-type', 0], // CL: no quota → LOP
      ['el-type', 5], // EL: 5 days quota → no LOP
    ]),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'r1');
  assert.equal(result[0].leaveTypeId, 'cl-type');
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses skips requests with no working days', () => {
  // Leave on a weekend only (Aug 1, 2026 is Saturday)
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-08-01', days: 1 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(['2026-08-01']), // holiday on Aug 1
    new Set(['type-1']),
    new Map([['type-1', 0]]),
  );

  assert.equal(result.length, 0);
});

test('computeLopCauses handles leave outside month window', () => {
  // Leave in July, not in August
  const requests = [makeRequest({ _id: 'r1', startDate: '2026-07-15', days: 1 })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 0]]),
  );

  assert.equal(result.length, 0);
});

test('computeLopCauses handles multiple leave types with different quotas', () => {
  const requests = [
    makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 2, leaveTypeId: 'cl-type' }),
    makeRequest({ _id: 'r2', startDate: '2026-08-05', days: 2, leaveTypeId: 'el-type' }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['cl-type', 'el-type']),
    new Map([
      ['cl-type', 1], // CL: 1 day quota
      ['el-type', 3], // EL: 3 days quota
    ]),
  );

  // CL: 2 days leave, 1 quota → 1 LOP
  // EL: 2 days leave, 3 quota → 0 LOP
  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'r1');
  assert.equal(result[0].leaveTypeId, 'cl-type');
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses identifies correct LOP when balance 0 + 1 day approved leave', () => {
  // Balance 0, take 1 day SL → 1 day LOP
  const requests = [makeRequest({ _id: 'sl-1', startDate: '2026-08-04', days: 1, leaveTypeId: 'sl-type' })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 0]]), // 0 paid quota
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses identifies correct LOP when balance 0.5 + 1 day leave', () => {
  // Balance 0.5, take 1 day → 0.5 paid + 0.5 LOP
  const requests = [makeRequest({ _id: 'sl-1', startDate: '2026-08-04', days: 1, leaveTypeId: 'sl-type' })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 0.5]]), // 0.5 paid quota
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].lopDays, 0.5);
});

test('computeLopCauses identifies correct LOP when balance 2 + 1 day leave', () => {
  // Balance 2, take 1 day → 0 LOP
  const requests = [makeRequest({ _id: 'sl-1', startDate: '2026-08-04', days: 1, leaveTypeId: 'sl-type' })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 2]]), // 2 paid quota
  );

  assert.equal(result.length, 0);
});

test('computeLopCauses handles already-consumed quota correctly', () => {
  // Previous leaves used up all quota (quota=0), take 1 day → 1 day LOP
  const requests = [makeRequest({ _id: 'sl-1', startDate: '2026-08-04', days: 1, leaveTypeId: 'sl-type' })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 0]]), // Quota fully consumed
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses links LOP to correct LeaveRequest', () => {
  // Multiple requests, only the second one causes LOP
  const requests = [
    makeRequest({ _id: 'req-a', startDate: '2026-08-04', days: 1 }),
    makeRequest({ _id: 'req-b', startDate: '2026-08-05', days: 1 }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['type-1']),
    new Map([['type-1', 1]]), // 1 day quota
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'req-b');
});

test('computeLopCauses handles SL auto-approved leave correctly', () => {
  // SL with 0 balance → 1 day LOP
  const requests = [makeRequest({ _id: 'sl-auto', startDate: '2026-08-04', days: 1, leaveTypeId: 'sl-type' })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 0]]),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'sl-auto');
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses handles half-day LOP correctly', () => {
  // Balance 0.5, take 0.5 day → 0.5 paid, 0 LOP
  const requests1 = [makeRequest({ _id: 'r1', startDate: '2026-08-04', days: 0.5, leaveTypeId: 'sl-type' })];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result1 = computeLopCauses(
    requests1,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 0.5]]),
  );

  assert.equal(result1.length, 0); // No LOP

  // Balance 0, take 0.5 day → 0.5 LOP
  const requests2 = [makeRequest({ _id: 'r2', startDate: '2026-08-04', days: 0.5, leaveTypeId: 'sl-type' })];

  const result2 = computeLopCauses(
    requests2,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 0]]),
  );

  assert.equal(result2.length, 1);
  assert.equal(result2[0].lopDays, 0.5);
});

test('computeLopCauses consumes quota from previous months (chronological)', () => {
  // Year quota: 5 days
  // July: 5 days leave (approved) — consumes all quota
  // August: 1 day leave (approved) — should be LOP because quota is exhausted
  const requests = [
    makeRequest({ _id: 'jul-1', startDate: '2026-07-01', endDate: '2026-07-07', days: 5, leaveTypeId: 'sl-type' }),
    makeRequest({ _id: 'aug-1', startDate: '2026-08-04', days: 1, leaveTypeId: 'sl-type' }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 5]]), // 5 day annual quota
  );

  // July consumed 5 days of quota, August has 0 remaining → 1 day LOP
  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'aug-1');
  assert.equal(result[0].lopDays, 1);
});

test('computeLopCauses partial previous consumption leaves partial quota', () => {
  // Year quota: 5 days
  // July: 3 days leave — consumes 3 days, 2 remaining
  // August: 1 day leave — should be paid (2 remaining)
  const requests = [
    makeRequest({ _id: 'jul-1', startDate: '2026-07-01', endDate: '2026-07-06', days: 3, leaveTypeId: 'sl-type' }),
    makeRequest({ _id: 'aug-1', startDate: '2026-08-04', days: 1, leaveTypeId: 'sl-type' }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 5]]),
  );

  // July consumed 3, 2 remaining, August uses 1 → 0 LOP
  assert.equal(result.length, 0);
});

test('computeLopCauses multi-month leave consumes quota across months', () => {
  // Leave spans Jul 28 - Aug 1 (crosses month boundary)
  // In July: Jul 28, 29, 30, 31 (4 working days)
  // In August: Aug 3 (1 working day)
  // Total: 5 working days, 5 days leave → 1 per day
  // Year quota: 3 days
  // July consumes 4 days of quota (but only 3 available), August gets 0
  const requests = [
    makeRequest({ _id: 'cross-1', startDate: '2026-07-28', endDate: '2026-08-03', days: 5, leaveTypeId: 'sl-type' }),
  ];
  const monthStart = parseDateInputAsISTDay('2026-08-01');
  const monthEnd = parseDateInputAsISTDay('2026-08-31');

  const result = computeLopCauses(
    requests,
    monthStart,
    monthEnd,
    new Set(),
    new Set(['sl-type']),
    new Map([['sl-type', 3]]), // 3 day annual quota
  );

  // July consumed 3 days of quota (all available), August has 0 remaining
  // August has 1 working day → 1 day LOP
  assert.equal(result.length, 1);
  assert.equal(result[0].leaveRequestId, 'cross-1');
  assert.equal(result[0].lopDays, 1);
});
