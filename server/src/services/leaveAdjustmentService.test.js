import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LEAVE_ADJUSTMENT_REASON,
  leaveAdjustmentBatchSchema,
  leaveAdjustmentGridQuerySchema,
} from '../../../shared/validation/leaveAdjustment.js';

test('leaveAdjustmentGridQuerySchema requires year and applies pagination defaults', () => {
  const result = leaveAdjustmentGridQuerySchema.safeParse({ year: 2026 });
  assert.equal(result.success, true);
  assert.equal(result.data.page, 1);
  assert.equal(result.data.limit, 20);
  assert.equal(result.data.year, 2026);
});

test('leaveAdjustmentGridQuerySchema accepts search and department filters', () => {
  const result = leaveAdjustmentGridQuerySchema.safeParse({
    year: 2026,
    page: 2,
    limit: 50,
    search: 'rahul',
    departmentId: '507f1f77bcf86cd799439011',
  });
  assert.equal(result.success, true);
  assert.equal(result.data.search, 'rahul');
  assert.equal(result.data.limit, 50);
});

test('leaveAdjustmentBatchSchema requires at least one adjustment', () => {
  const valid = leaveAdjustmentBatchSchema.safeParse({
    adjustments: [
      {
        userId: '507f1f77bcf86cd799439011',
        leaveTypeId: '507f1f77bcf86cd799439012',
        year: 2026,
        carried: 2,
      },
    ],
  });
  assert.equal(valid.success, true);

  const empty = leaveAdjustmentBatchSchema.safeParse({ adjustments: [] });
  assert.equal(empty.success, false);
});

test('leaveAdjustmentBatchSchema rejects carried above policy max', () => {
  const result = leaveAdjustmentBatchSchema.safeParse({
    adjustments: [
      {
        userId: '507f1f77bcf86cd799439011',
        leaveTypeId: '507f1f77bcf86cd799439012',
        year: 2026,
        carried: 400,
      },
    ],
  });
  assert.equal(result.success, false);
});

test('leaveAdjustmentBatchSchema accepts negative carried as a LOP deduction', () => {
  const result = leaveAdjustmentBatchSchema.safeParse({
    adjustments: [
      {
        userId: '507f1f77bcf86cd799439011',
        leaveTypeId: '507f1f77bcf86cd799439012',
        year: 2026,
        carried: -5,
      },
    ],
  });
  assert.equal(result.success, true);
  assert.equal(result.data.adjustments[0].carried, -5);
});

test('leaveAdjustmentBatchSchema still bounds carried to +-365', () => {
  for (const carried of [-366, 366]) {
    const result = leaveAdjustmentBatchSchema.safeParse({
      adjustments: [
        {
          userId: '507f1f77bcf86cd799439011',
          leaveTypeId: '507f1f77bcf86cd799439012',
          year: 2026,
          carried,
        },
      ],
    });
    assert.equal(result.success, false, `carried=${carried} must be rejected`);
  }
});

test('DEFAULT_LEAVE_ADJUSTMENT_REASON is stable audit copy', () => {
  assert.match(DEFAULT_LEAVE_ADJUSTMENT_REASON, /Manual carried adjustment/i);
});
