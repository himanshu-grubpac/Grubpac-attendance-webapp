import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmployedInCalendarYearQuery } from './teamScopeService.js';

test('buildEmployedInCalendarYearQuery: returns indexed employment overlap clauses', () => {
  const query = buildEmployedInCalendarYearQuery(2025);
  assert.ok(query);
  assert.equal(query.$and.length, 2);
  assert.deepEqual(Object.keys(query.$and[0].$or[0]), ['joiningDate']);
  assert.deepEqual(Object.keys(query.$and[1].$or[0]), ['endingDate']);
});
