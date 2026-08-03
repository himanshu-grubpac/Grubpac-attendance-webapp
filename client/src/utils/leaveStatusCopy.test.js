import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApplyLeaveNotice,
  buildPendingLeaveCheckInFollowUp,
  buildPendingLeaveCheckInWarning,
  formatLeaveTypeLabel,
  resolveLeavePolicyPaid,
  selectLeavePolicyForType,
} from '../../../client/src/utils/leaveStatusCopy.js';

test('formatLeaveTypeLabel combines code and name', () => {
  assert.equal(formatLeaveTypeLabel({ leaveTypeCode: 'WFH', leaveTypeName: 'Work From Home' }), 'WFH — Work From Home');
});

test('buildApplyLeaveNotice for SL auto-approves without pending or LOP warnings', () => {
  const notice = buildApplyLeaveNotice({
    leaveTypeCode: 'SL',
    leaveTypeName: 'Sick Leave',
    policyPaid: true,
  });
  assert.equal(notice.title, 'Before you submit');
  assert.equal(notice.lines.length, 2);
  assert.match(notice.lines[0], /approved automatically/);
  assert.match(notice.lines[1], /paid leave/);
  assert.doesNotMatch(notice.lines.join(' '), /manager approves|pending|loss of pay \(LOP\)/);
});

test('buildApplyLeaveNotice includes paid line for paid policies', () => {
  const notice = buildApplyLeaveNotice({
    leaveTypeCode: 'CL',
    leaveTypeName: 'Casual Leave',
    policyPaid: true,
  });
  assert.equal(notice.title, 'Before you submit');
  assert.equal(notice.lines.length, 3);
  assert.match(notice.lines[1], /paid leave once your manager approves it/);
  assert.doesNotMatch(notice.lines.join(' '), /pay estimate/);
});

test('buildApplyLeaveNotice for WFH paid policy does not mention pay estimate or unpaid', () => {
  const notice = buildApplyLeaveNotice({
    leaveTypeCode: 'WFH',
    leaveTypeName: 'Work From Home',
    policyPaid: true,
  });
  assert.match(notice.lines[1], /WFH — Work From Home is paid leave once your manager approves it/);
  assert.doesNotMatch(notice.lines.join(' '), /pay estimate|unpaid leave/);
});

test('buildApplyLeaveNotice describes unpaid policy types without pay-estimate wording', () => {
  const notice = buildApplyLeaveNotice({
    leaveTypeCode: 'UL',
    leaveTypeName: 'Unpaid Leave',
    policyPaid: false,
  });
  assert.match(notice.lines[1], /is unpaid leave once your manager approves it/);
  assert.doesNotMatch(notice.lines.join(' '), /pay estimate/);
});

test('resolveLeavePolicyPaid treats WFH as paid even when policy.paid is false', () => {
  assert.equal(
    resolveLeavePolicyPaid({ leaveTypeCode: 'WFH', policy: { paid: false } }),
    true,
  );
});

test('resolveLeavePolicyPaid follows policy.paid for other leave types', () => {
  assert.equal(resolveLeavePolicyPaid({ leaveTypeCode: 'CL', policy: { paid: false } }), false);
  assert.equal(resolveLeavePolicyPaid({ leaveTypeCode: 'SL', policy: { paid: true } }), true);
  assert.equal(resolveLeavePolicyPaid({ leaveTypeCode: 'SL', policy: null }), true);
});

test('selectLeavePolicyForType prefers the requested year', () => {
  const policies = [
    { leaveTypeId: 'type-a', year: 2025, paid: false },
    { leaveTypeId: 'type-a', year: 2026, paid: true },
  ];
  const selected = selectLeavePolicyForType(policies, 'type-a', 2026);
  assert.equal(selected.year, 2026);
  assert.equal(selected.paid, true);
});

test('buildPendingLeaveCheckInWarning returns null without pending leave', () => {
  assert.equal(buildPendingLeaveCheckInWarning(null), null);
});

test('buildPendingLeaveCheckInWarning mentions unpaid when pending', () => {
  const warning = buildPendingLeaveCheckInWarning({
    leaveTypeCode: 'WFH',
    leaveTypeName: 'Work From Home',
  });
  assert.match(warning.title, /Pending leave/);
  assert.match(warning.body, /not approved yet/);
  assert.match(warning.body, /loss of pay \(LOP\)/);
  assert.doesNotMatch(warning.body, /pay estimate/);
});

test('buildPendingLeaveCheckInFollowUp references pending request', () => {
  const line = buildPendingLeaveCheckInFollowUp({ leaveTypeCode: 'SL', leaveTypeName: 'Sick Leave' });
  assert.match(line, /still pending/);
});
