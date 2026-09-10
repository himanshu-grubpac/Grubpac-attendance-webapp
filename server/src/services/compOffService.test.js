import assert from 'node:assert/strict';
import test from 'node:test';
import { CompOffRequest } from '../models/CompOffRequest.js';
import {
  buildEligibleDayKeysForYear,
  computeCompOffCredit,
  computeDayAssessmentsCredit,
  countEligibleDaysInRangeKeys,
  listRequestDayKeys,
  normalizeDayAssessments,
  roundHalf,
} from './compOffService.js';

test('roundHalf keeps 0.5 granularity and never goes negative', () => {
  assert.equal(roundHalf(2), 2);
  assert.equal(roundHalf(1.5), 1.5);
  assert.equal(roundHalf(1.25), 1.5);
  assert.equal(roundHalf(1.2), 1);
  assert.equal(roundHalf(0.1), 0);
  assert.equal(roundHalf(-1), 0);
});

test('credit math: completed ×1, half ×0.5, none ×0', () => {
  assert.equal(computeCompOffCredit(2, 'completed'), 2);
  assert.equal(computeCompOffCredit(2, 'half'), 1);
  assert.equal(computeCompOffCredit(2, 'none'), 0);
  assert.equal(computeCompOffCredit(1, 'completed'), 1);
  assert.equal(computeCompOffCredit(1, 'half'), 0.5);
  assert.equal(computeCompOffCredit(3, 'half'), 1.5);
  assert.equal(computeCompOffCredit(2, 'unknown'), 0);
});

test('eligible days include configured weekend days and active holidays only', () => {
  // 2026-09-05 is a Saturday; 2026-09-06 is a Sunday; 2026-09-07 Monday.
  const holidayDateKeys = new Set(['2026-09-07']);
  const days = buildEligibleDayKeysForYear(2026, [0, 6], holidayDateKeys);
  assert.ok(days.includes('2026-09-05'), 'Saturday is eligible');
  assert.ok(days.includes('2026-09-06'), 'Sunday is eligible');
  assert.ok(days.includes('2026-09-07'), 'active holiday is eligible');
  assert.ok(!days.includes('2026-09-08'), 'plain Tuesday is not eligible');
});

test('eligible days respect custom weekendDays (e.g. only Sunday off)', () => {
  const days = buildEligibleDayKeysForYear(2026, [0], new Set());
  assert.ok(!days.includes('2026-09-05'), 'Saturday is a working day here');
  assert.ok(days.includes('2026-09-06'), 'Sunday is eligible');
});

test('active weekday holidays are eligible; keys absent from the set are not', () => {
  // 2026-09-07 is a Monday (active holiday) — eligible when present in the set.
  const withHoliday = buildEligibleDayKeysForYear(2026, [0, 6], new Set(['2026-09-07']));
  assert.ok(withHoliday.includes('2026-09-07'));
  // Inactive holidays never enter the set server-side, so the plain weekend
  // list is unchanged.
  const withoutHoliday = buildEligibleDayKeysForYear(2026, [0, 6], new Set());
  assert.ok(!withoutHoliday.includes('2026-09-07'));
  assert.ok(!withoutHoliday.includes('2026-09-08'), 'plain Tuesday is not eligible');
});

test('range validation accepts fully-eligible ranges and counts days', () => {
  const weekendDays = [0, 6];
  const holidaySets = new Map([[2026, new Set(['2026-09-07'])]]);
  const count = countEligibleDaysInRangeKeys(
    '2026-09-05',
    '2026-09-07',
    weekendDays,
    holidaySets,
  );
  assert.equal(count, 3);
});

test('range spanning an ineligible day throws with the rule message', () => {
  const weekendDays = [0, 6];
  const holidaySets = new Map();
  assert.throws(
    () => countEligibleDaysInRangeKeys('2026-09-05', '2026-09-08', weekendDays, holidaySets),
    (err) => err.message === 'Comp off can only be requested for weekends and holidays.',
  );
});

test('single ineligible day throws the same way', () => {
  assert.throws(
    () => countEligibleDaysInRangeKeys('2026-09-08', '2026-09-08', [0, 6], new Map()),
    (err) => err.message === 'Comp off can only be requested for weekends and holidays.',
  );
});

test('cross-year range looks up holidays per year', () => {
  const weekendDays = [0, 6];
  // Wed 2026-12-30 + Thu 2026-12-31 (year-boundary holidays) + Fri 2027-01-01.
  const holidaySets = new Map([
    [2026, new Set(['2026-12-30', '2026-12-31'])],
    [2027, new Set(['2027-01-01'])],
  ]);
  const count = countEligibleDaysInRangeKeys(
    '2026-12-30',
    '2027-01-01',
    weekendDays,
    holidaySets,
  );
  assert.equal(count, 3);
});

test('listRequestDayKeys enumerates the inclusive IST range', () => {
  const request = {
    startDate: new Date('2026-09-12T00:00:00Z'),
    endDate: new Date('2026-09-13T00:00:00Z'),
  };
  assert.deepEqual(listRequestDayKeys(request), ['2026-09-12', '2026-09-13']);
  assert.deepEqual(listRequestDayKeys({ startDate: new Date('2026-09-12T00:00:00Z'), endDate: new Date('2026-09-12T00:00:00Z') }), ['2026-09-12']);
  assert.deepEqual(listRequestDayKeys({}), []);
});

test('normalizeDayAssessments fans a single rate out to every day', () => {
  const request = { startDate: new Date('2026-09-12T00:00:00Z'), endDate: new Date('2026-09-13T00:00:00Z') };
  assert.deepEqual(normalizeDayAssessments(request, 'half'), [
    { dayKey: '2026-09-12', assessment: 'half' },
    { dayKey: '2026-09-13', assessment: 'half' },
  ]);
  assert.throws(() => normalizeDayAssessments(request, 'bogus'), /Invalid comp off assessment/);
  assert.throws(() => normalizeDayAssessments(request, null), /Invalid comp off assessment/);
});

test('normalizeDayAssessments requires exact per-day coverage', () => {
  const request = { startDate: new Date('2026-09-12T00:00:00Z'), endDate: new Date('2026-09-13T00:00:00Z') };
  const full = [
    { date: '2026-09-12', assessment: 'completed' },
    { date: '2026-09-13', assessment: 'half' },
  ];
  assert.deepEqual(normalizeDayAssessments(request, null, full), [
    { dayKey: '2026-09-12', assessment: 'completed' },
    { dayKey: '2026-09-13', assessment: 'half' },
  ]);
  assert.throws(
    () => normalizeDayAssessments(request, null, [{ date: '2026-09-12', assessment: 'completed' }]),
    /missing for worked day\(s\): 2026-09-13/,
  );
  assert.throws(
    () => normalizeDayAssessments(request, null, [...full, { date: '2026-09-14', assessment: 'none' }]),
    /outside this request's worked days/,
  );
  assert.throws(
    () => normalizeDayAssessments(request, null, [
      { date: '2026-09-12', assessment: 'completed' },
      { date: '2026-09-12', assessment: 'none' },
      { date: '2026-09-13', assessment: 'none' },
    ]),
    /Duplicate assessment/,
  );
  assert.throws(
    () => normalizeDayAssessments(request, null, [
      { date: '2026-09-12', assessment: 'bogus' },
      { date: '2026-09-13', assessment: 'none' },
    ]),
    /Invalid comp off assessment/,
  );
});

test('computeDayAssessmentsCredit sums per-day rates at 0.5 granularity', () => {
  assert.equal(computeDayAssessmentsCredit([
    { dayKey: '2026-09-12', assessment: 'completed' },
    { dayKey: '2026-09-13', assessment: 'half' },
  ]), 1.5);
  assert.equal(computeDayAssessmentsCredit([
    { dayKey: '2026-09-12', assessment: 'none' },
  ]), 0);
  assert.equal(computeDayAssessmentsCredit([]), 0);
  assert.equal(computeDayAssessmentsCredit(null), 0);
});

test('status-transition invariants hold on the real schema enum', () => {
  // Read the enum from the Mongoose schema itself so this test drifts loudly
  // if the model changes — non-terminal statuses drive overlap + gate logic.
  const statusEnum = CompOffRequest.schema.path('status').enumValues;
  const active = new Set(['pending', 'approved', 'worked']);
  assert.deepEqual([...statusEnum].sort(), [...active, 'rejected', 'assessed', 'lapsed', 'cancelled'].sort());
  for (const status of statusEnum) {
    if (active.has(status)) continue;
    assert.ok(['rejected', 'assessed', 'lapsed', 'cancelled'].includes(status), `${status} must be terminal`);
  }
});
