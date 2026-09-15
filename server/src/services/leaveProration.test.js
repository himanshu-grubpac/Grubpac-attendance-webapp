process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeProratedEntitled,
  roundToHalfDay,
} from './leaveBalanceService.js';
import { getISTMonth, getISTYear } from '../utils/istDate.js';

const YEAR = 2026;
const SEPT = new Date('2026-09-15T00:00:00Z');

function independentProrata(quota, fromKey, year) {
  const daysInYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
  const remaining =
    Math.floor(
      (Date.parse(`${year}-12-31T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  return Math.round(((quota * remaining) / daysInYear) * 2) / 2;
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

test('mid-year joiner gets daily-slice proration (Aug 27 case)', () => {
  const actual = computeProratedEntitled({
    annualQuota: 7,
    year: YEAR,
    joiningDateKey: '2026-08-27',
  });
  assert.equal(actual, independentProrata(7, '2026-08-27', YEAR));
  assert.ok(actual > 0 && actual < 7);
});

test('July 1 joiner gets half-year quota (30-day policy → 15)', () => {
  const actual = computeProratedEntitled({
    annualQuota: 30,
    year: YEAR,
    joiningDateKey: '2026-07-01',
  });
  assert.equal(actual, 15);
  assert.equal(actual, independentProrata(30, '2026-07-01', YEAR));
});

test('joining on Dec 31 yields almost nothing', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: '2026-12-31' }),
    independentProrata(7, '2026-12-31', YEAR),
  );
});

test('joining after the balance year yields zero', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: '2027-01-15' }),
    0,
  );
});

test('leap year uses a 366-day divisor', () => {
  const actual = computeProratedEntitled({
    annualQuota: 7,
    year: 2024,
    joiningDateKey: '2024-07-02',
  });
  assert.equal(actual, independentProrata(7, '2024-07-02', 2024));
});

test('accrual cap still applies on top of the prorated quota', () => {
  const asOfDate = SEPT;
  const monthsElapsed = getISTMonth(asOfDate);
  assert.equal(getISTYear(asOfDate), YEAR);

  // Full-year joiner keeps legacy behaviour: min(quota, months * rate).
  assert.equal(
    computeProratedEntitled({
      annualQuota: 18,
      accrualPerMonth: 1.5,
      year: YEAR,
      joiningDateKey: '2026-01-01',
      asOfDate,
    }),
    Math.min(18, monthsElapsed * 1.5),
  );

  // Mid-year joiner is capped by the prorated quota when it is lower.
  const prorated = independentProrata(18, '2026-08-27', YEAR);
  assert.equal(
    computeProratedEntitled({
      annualQuota: 18,
      accrualPerMonth: 1.5,
      year: YEAR,
      joiningDateKey: '2026-08-27',
      asOfDate,
    }),
    Math.min(prorated, monthsElapsed * 1.5),
  );
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
    independentProrata(18, '2025-08-27', 2025),
  );
});

test('malformed joining keys fall back to full quota', () => {
  assert.equal(
    computeProratedEntitled({ annualQuota: 7, year: YEAR, joiningDateKey: 'not-a-date' }),
    7,
  );
});
