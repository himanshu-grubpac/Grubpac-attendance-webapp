import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPaidLeaveDayMap,
  computeDailyCappedPayableDays,
} from './salaryService.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';

test('computeDailyCappedPayableDays caps present + half-day leave at 1.0 per day', () => {
  const workingDayList = ['2026-03-02'];
  const presentDaySet = new Set(['2026-03-02']);
  const paidLeaveByDay = new Map([['2026-03-02', 0.5]]);

  const payable = computeDailyCappedPayableDays(workingDayList, presentDaySet, paidLeaveByDay);

  assert.equal(payable, 1);
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
