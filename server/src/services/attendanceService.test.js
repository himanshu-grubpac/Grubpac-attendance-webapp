import assert from 'node:assert/strict';
import test from 'node:test';
import { monthCalendarStatusForCheckInTag } from './attendanceService.js';

test('month calendar maps HD check-ins to half_day status', () => {
  assert.equal(monthCalendarStatusForCheckInTag('HD'), 'half_day');
});

test('month calendar maps present and legacy check-ins to present status', () => {
  assert.equal(monthCalendarStatusForCheckInTag('P'), 'present');
  assert.equal(monthCalendarStatusForCheckInTag(null), 'present');
  assert.equal(monthCalendarStatusForCheckInTag(undefined), 'present');
});
