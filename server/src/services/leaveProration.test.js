process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeProratedEntitled,
  roundToHalfDay,
} from './leaveBalanceService.js';

const YEAR = 2026;
const SEPT = new Date('2026-09-15T00:00:00Z');

function independentMonthlyProrata(quota, fromKey, year) {
  const date = new Date(`${fromKey}T00:00:00Z`);
  const joinMonth = date.getUTCMonth() + 1;
  const eligibleMonths = 12 - joinMonth + 1;
  return Math.min(quota, Math.ceil((quota * eligibleMonths) / 12));
}

test('roundToHalfDay rounds to the nearest half day', () => {
  assert.equal(roundToHalfDay(2.436), 2.5);
  assert.equal(roundToHalfDay(2.24), 2);
  assert.equal(roundToHalfDay(7), 7);
  assert.equal(roundToHalfDay(0), 0);
});

test('no joining date means full quota', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: null }),
    7,
  );
});

test('joining on or before Jan 1 means full quota', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: '2026-01-01' }),
    7,
  );
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: '2024-03-10' }),
    7,
  );
});

test('mid-year joiner gets monthly proration (Aug 27 case)', () => {
  const actual = computeProratedEntitled({
    annualQuota: 7,
    year: YEAR,
    joiningDateKey: '2026-08-27',
  });
  assert.equal(actual, independentMonthlyProrata(7, '2026-08-27', YEAR));
  assert.ok(actual > 0 && actual < 7);
});

test('July 1 joiner gets half-year quota (30-day policy → 15)', () => {
  const actual = computeProratedEntitled({
    annualQuota: 30,
    year: YEAR,
    joiningDateKey: '2026-07-01',
  });
  assert.equal(actual, 15);
  assert.equal(actual, independentMonthlyProrata(30, '2026-07-01', YEAR));
});

test('joining on Dec 31 yields 1 month quota', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: '2026-12-31' }),
    independentMonthlyProrata(7, '2026-12-31', YEAR),
  );
});

test('joining after the balance year yields zero', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: '2027-01-15' }),
    0,
  );
});

test('leap year uses monthly proration (not day-based)', () => {
  const actual = computeProratedEntitled({
    annualQuota: 7,
    year: 2024,
    joiningDateKey: '2024-07-02',
  });
  assert.equal(actual, independentMonthlyProrata(7, '2024-07-02', 2024));
});

test('accrual rate does not gate the grant: full quota upfront in any month', () => {
  // A 365 quota at 30/mo vests fully even in September (previously capped at
  // 9 × 30 = 270, and 365 was unreachable all year since 12 × 30 = 360).
  assert.equal(
    computeProratedEntitled({
      annualQuota: 365,
      accrualPerMonth: 30,
      year: YEAR,
      joiningDateKey: '2026-01-01',
      asOfDate: SEPT,
    }),
    365,
  );

  // Mid-year joiner is capped by the prorated quota when it is lower.
  const prorated = independentMonthlyProrata(18, '2026-08-27', YEAR);
  assert.equal(
    computeProratedEntitled({
      annualQuota: 18,
      accrualPerMonth: 1.5,
      year: YEAR,
      joiningDateKey: '2026-08-27',
      asOfDate: SEPT,
    }),
    prorated,
  );
});

test('grant is identical in every month of the year', () => {
  const january = new Date('2026-01-15T00:00:00Z');
  const december = new Date('2026-12-15T00:00:00Z');
  for (const asOfDate of [january, SEPT, december]) {
    assert.equal(
      computeProratedEntitled({
        annualQuota: 365,
        accrualPerMonth: 30,
        year: YEAR,
        joiningDateKey: '2026-01-01',
        asOfDate,
      }),
      365,
    );
  }
});

test('accrual cap is skipped for past years', () => {
  assert.equal(
    computeProratedEntitled({
      annualQuota: 18,
      accrualPerMonth: 1.5,
      year: 2025,
      joiningDateKey: '2025-08-27',
      asOfDate: SEPT,
    }),
    independentMonthlyProrata(18, '2025-08-27', 2025),
  );
});

test('malformed joining keys fall back to full quota', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: 'not-a-date' }),
    7,
  );
});
