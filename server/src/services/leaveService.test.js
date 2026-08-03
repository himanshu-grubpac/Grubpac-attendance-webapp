import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_APPROVE_LEAVE_TYPE_CODES,
  isAutoApproveLeaveType,
} from './leaveService.js';

test('AUTO_APPROVE_LEAVE_TYPE_CODES includes SL', () => {
  assert.equal(AUTO_APPROVE_LEAVE_TYPE_CODES.has('SL'), true);
});

test('isAutoApproveLeaveType matches SL case-insensitively', () => {
  assert.equal(isAutoApproveLeaveType({ code: 'SL' }), true);
  assert.equal(isAutoApproveLeaveType({ code: 'sl' }), true);
  assert.equal(isAutoApproveLeaveType({ code: 'CL' }), false);
  assert.equal(isAutoApproveLeaveType(null), false);
});
