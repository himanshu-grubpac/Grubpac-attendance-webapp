import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCombinedCarryForward,
  computeStandaloneCarryForward,
  isCarryForwardEligiblePolicy,
} from './leaveBalanceService.js';

test('isCarryForwardEligiblePolicy requires paid leave with CF cap or combined group', () => {
  assert.equal(
    isCarryForwardEligiblePolicy({
      paid: true,
      isActive: true,
      carryForwardMax: 23,
      combinedCarryGroup: null,
    }),
    true,
  );
  assert.equal(
    isCarryForwardEligiblePolicy({
      paid: true,
      isActive: true,
      carryForwardMax: 0,
      combinedCarryGroup: 'CL_EL',
    }),
    true,
  );
  assert.equal(
    isCarryForwardEligiblePolicy({
      paid: false,
      isActive: true,
      carryForwardMax: 23,
    }),
    false,
  );
  assert.equal(
    isCarryForwardEligiblePolicy({
      paid: true,
      isActive: true,
      carryForwardMax: 0,
      combinedCarryGroup: null,
    }),
    false,
  );
});

test('computeStandaloneCarryForward caps carried days at policy max', () => {
  assert.deepEqual(computeStandaloneCarryForward(5, 23), {
    remaining: 5,
    carried: 5,
    forfeited: 0,
  });
  assert.deepEqual(computeStandaloneCarryForward(30, 23), {
    remaining: 30,
    carried: 23,
    forfeited: 7,
  });
  assert.deepEqual(computeStandaloneCarryForward(0, 23), {
    remaining: 0,
    carried: 0,
    forfeited: 0,
  });
});

test('computeCombinedCarryForward shares CL+EL cap across types in order', () => {
  const allocations = computeCombinedCarryForward(
    [
      { leaveTypeId: 'cl', leaveTypeCode: 'CL', remaining: 5 },
      { leaveTypeId: 'el', leaveTypeCode: 'EL', remaining: 18 },
    ],
    20,
  );

  assert.equal(allocations.length, 2);
  assert.deepEqual(allocations[0], {
    leaveTypeId: 'cl',
    leaveTypeCode: 'CL',
    remaining: 5,
    carried: 5,
    forfeited: 0,
    combinedGroup: 'CL_EL',
    alreadyApplied: false,
  });
  assert.deepEqual(allocations[1], {
    leaveTypeId: 'el',
    leaveTypeCode: 'EL',
    remaining: 18,
    carried: 15,
    forfeited: 3,
    combinedGroup: 'CL_EL',
    alreadyApplied: false,
  });
});

test('computeCombinedCarryForward returns empty list when no remaining balance', () => {
  const allocations = computeCombinedCarryForward(
    [{ leaveTypeId: 'cl', leaveTypeCode: 'CL', remaining: 0 }],
    20,
  );
  assert.deepEqual(allocations, []);
});
