import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPaidLeaveDayMap,
  computeDailyCappedPayableDays,
  computeNextPayrollDateIst,
  computeSalaryTransferStatsFromRows,
} from './salaryService.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';

test('computeDailyCappedPayableDays caps present + half-day leave at 1.0 per day', () => {
  const workingDayList = ['2026-03-02'];
  const presentDaySet = new Set(['2026-03-02']);
  const paidLeaveByDay = new Map([['2026-03-02', 0.5]]);

  const payable = computeDailyCappedPayableDays(workingDayList, presentDaySet, paidLeaveByDay);

  assert.equal(payable, 1);
});

test('computeDailyCappedPayableDays deducts half a day for a Half Day attendance tag', () => {
  const workingDayList = ['2026-03-02'];
  const attendanceCreditByDay = new Map([['2026-03-02', 0.5]]);

  const payable = computeDailyCappedPayableDays(workingDayList, attendanceCreditByDay, new Map());

  assert.equal(payable, 0.5);
});

test('computeDailyCappedPayableDays sums uncapped days across the month', () => {
  const workingDayList = ['2026-03-02', '2026-03-03', '2026-03-04'];
  const presentDaySet = new Set(['2026-03-02', '2026-03-04']);
  const paidLeaveByDay = new Map([
    ['2026-03-03', 1],
    ['2026-03-04', 0.5],
  ]);

  const payable = computeDailyCappedPayableDays(workingDayList, presentDaySet, paidLeaveByDay);

  assert.equal(payable, 3);
});

test('buildPaidLeaveDayMap allocates half-day leave to a single working day', () => {
  const monthStart = parseDateInputAsISTDay('2026-03-03');
  const monthEnd = parseDateInputAsISTDay('2026-03-03');
  const paidTypeIds = new Set(['type-1']);
  const requests = [
    {
      leaveTypeId: 'type-1',
      startDate: monthStart,
      endDate: monthEnd,
      days: 0.5,
    },
  ];

  const dayMap = buildPaidLeaveDayMap(requests, monthStart, monthEnd, new Set(), paidTypeIds);

  assert.equal(dayMap.get('2026-03-03'), 0.5);
});

test('computeNextPayrollDateIst returns null when payroll day is not configured', () => {
  assert.equal(computeNextPayrollDateIst(null), null);
  assert.equal(computeNextPayrollDateIst(undefined), null);
});

test('computeNextPayrollDateIst returns this month when payroll day is still ahead', () => {
  const reference = parseDateInputAsISTDay('2026-07-10');
  assert.equal(computeNextPayrollDateIst(25, reference), '2026-07-25');
});

test('computeNextPayrollDateIst rolls to next month after payroll day passes', () => {
  const reference = parseDateInputAsISTDay('2026-07-27');
  assert.equal(computeNextPayrollDateIst(25, reference), '2026-08-25');
});

test('computeNextPayrollDateIst clamps payroll day to month length', () => {
  const reference = parseDateInputAsISTDay('2026-01-05');
  assert.equal(computeNextPayrollDateIst(31, reference), null);
  assert.equal(computeNextPayrollDateIst(28, reference), '2026-01-28');
  const febReference = parseDateInputAsISTDay('2026-02-01');
  assert.equal(computeNextPayrollDateIst(28, febReference), '2026-02-28');
});

test('computeSalaryTransferStatsFromRows aggregates pending, paid, failed counts and amount', () => {
  const stats = computeSalaryTransferStatsFromRows([
    { status: 'pending', amount: 1000 },
    { status: 'pending', amount: 2500.5 },
    { status: 'paid', amount: 500 },
    { status: 'failed', amount: 750 },
  ]);

  assert.equal(stats.pendingCount, 2);
  assert.equal(stats.paidCount, 1);
  assert.equal(stats.failedCount, 1);
  assert.equal(stats.totalPendingAmount, 3500.5);
  assert.equal(stats.totalCount, 4);
});
