import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCombinedCarryForward,
  computeEntitledForPolicy,
  computeStandaloneCarryForward,
  getAvailableBalance,
  getPaidLeaveQuota,
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

test('getAvailableBalance can go negative when used exceeds stock', () => {
  assert.equal(
    getAvailableBalance({ entitled: 1, carried: 0, used: 2, pending: 0, encashed: 0 }),
    -1,
  );
  assert.equal(
    getAvailableBalance({ entitled: 5, carried: 1, used: 2, pending: 1, encashed: 0 }),
    3,
  );
});

test('getPaidLeaveQuota ignores used and pending', () => {
  assert.equal(
    getPaidLeaveQuota({ entitled: 5, carried: 2, used: 10, pending: 3, encashed: 1 }),
    6,
  );
  assert.equal(
    getPaidLeaveQuota({ entitled: 0, carried: 0, used: 0, pending: 0, encashed: 0 }),
    0,
  );
});

test('getAvailableBalance includes compOffEarned and tolerates legacy docs', () => {
  assert.equal(
    getAvailableBalance({ entitled: 0, carried: 0, compOffEarned: 2, used: 0, pending: 0, encashed: 0 }),
    2,
  );
  assert.equal(
    getAvailableBalance({ entitled: 5, carried: 1, compOffEarned: 1.5, used: 2, pending: 1, encashed: 0 }),
    4.5,
  );
  // Pre-migration documents without the field behave exactly as before.
  assert.equal(
    getAvailableBalance({ entitled: 5, carried: 1, used: 2, pending: 1, encashed: 0 }),
    3,
  );
});

test('getPaidLeaveQuota includes compOffEarned', () => {
  assert.equal(
    getPaidLeaveQuota({ entitled: 0, carried: 0, compOffEarned: 2, used: 0, pending: 0, encashed: 0 }),
    2,
  );
  assert.equal(
    getPaidLeaveQuota({ entitled: 0, carried: 0, compOffEarned: 0, used: 0, pending: 0, encashed: 0 }),
    0,
  );
});

// --- computeEntitledForPolicy tests ---

function makePolicy(overrides = {}) {
  return {
    annualQuota: 30,
    accrualPerMonth: 0,
    carryForwardMax: 0,
    maxAccumulation: 0,
    paid: true,
    encashmentMaxPerYear: 0,
    combinedCarryGroup: null,
    ...overrides,
  };
}

test('computeEntitledForPolicy returns full quota for non-accrual type with no DOJ', () => {
  const policy = makePolicy({ annualQuota: 30 });
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'));
  assert.equal(result, 30);
});

test('computeEntitledForPolicy pro-rates non-accrual type for mid-year DOJ', () => {
  const policy = makePolicy({ annualQuota: 30 });
  const joiningDate = new Date('2026-07-01');
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  // joinMonth=7, remaining=6, ceil(30*6/12)=ceil(15)=15
  assert.equal(result, 15);
});

test('computeEntitledForPolicy pro-rates non-accrual type for Jan DOJ (full year)', () => {
  const policy = makePolicy({ annualQuota: 30 });
  const joiningDate = new Date('2026-01-01');
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  // joinMonth=1, remaining=12, ceil(30*12/12)=30
  assert.equal(result, 30);
});

test('computeEntitledForPolicy returns 0 for future DOJ year', () => {
  const policy = makePolicy({ annualQuota: 30 });
  const joiningDate = new Date('2027-03-01');
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  assert.equal(result, 0);
});

test('computeEntitledForPolicy returns full quota when DOJ is before policy year', () => {
  const policy = makePolicy({ annualQuota: 30 });
  const joiningDate = new Date('2025-06-15');
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  assert.equal(result, 30);
});

test('computeEntitledForPolicy accrual: full months from Jan for pre-year DOJ', () => {
  const policy = makePolicy({ annualQuota: 30, accrualPerMonth: 2.5 });
  const joiningDate = new Date('2025-06-15');
  // As of Sep 2026, monthsElapsed=9, 9*2.5=22.5
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  assert.equal(result, 22.5);
});

test('computeEntitledForPolicy accrual: months relative to DOJ for mid-year joiner', () => {
  const policy = makePolicy({ annualQuota: 30, accrualPerMonth: 2.5 });
  const joiningDate = new Date('2026-07-01');
  // As of Sep 2026, DOJ=Jul (month 7), asOf=Sep (month 9), accrualMonths=9-7+1=3, 3*2.5=7.5
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  assert.equal(result, 7.5);
});

test('computeEntitledForPolicy accrual: caps at annualQuota', () => {
  const policy = makePolicy({ annualQuota: 30, accrualPerMonth: 2.5 });
  const joiningDate = new Date('2026-01-01');
  // As of Sep 2026, months=9, 9*2.5=22.5 (below cap)
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  assert.equal(result, 22.5);
});

test('computeEntitledForPolicy accrual: caps at annualQuota for full year', () => {
  const policy = makePolicy({ annualQuota: 30, accrualPerMonth: 2.5 });
  const joiningDate = new Date('2025-01-01');
  // As of Dec 2026, months=12, 12*2.5=30, capped at 30
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-12-31'), joiningDate);
  assert.equal(result, 30);
});

test('computeEntitledForPolicy accrual: 0 months for future DOJ', () => {
  const policy = makePolicy({ annualQuota: 30, accrualPerMonth: 2.5 });
  const joiningDate = new Date('2027-03-01');
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  assert.equal(result, 0);
});

test('computeEntitledForPolicy accrual: single month DOJ (joined this month)', () => {
  const policy = makePolicy({ annualQuota: 30, accrualPerMonth: 2.5 });
  const joiningDate = new Date('2026-09-01');
  // As of Sep 2026, accrualMonths=9-9+1=1, 1*2.5=2.5
  const result = computeEntitledForPolicy(policy, 2026, new Date('2026-09-15'), joiningDate);
  assert.equal(result, 2.5);
});
