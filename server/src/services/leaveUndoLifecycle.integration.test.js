/**
 * Provisional → undoable → finalized leave lifecycle (integration, real Mongo).
 *
 * Covers the acceptance core:
 * - submit → undo sends ZERO emails/SMS/notifications, balance released
 * - repeated undo/submit finalizes ONLY the surviving revision
 * - approve → undo → decide-again finalizes ONLY the final decision+remarks
 * - double decisions collapse to one staged action (409 for the loser)
 * - undo after expiry is rejected (410) and the finalized state stands
 * - stale finalizer runs are no-ops (no overwrite, no email)
 * - pending-cancel notifies applicant AND manager
 * - approved-cancel follows the same undo lifecycle
 * - notifyAfter = undoExpiresAt + ~2.5s post-expiry delay
 *
 * Outbound email/SMS are captured via the NODE_ENV=test outboxes in
 * emailService/smsService (no provider calls from tests).
 */
// This repo's `node --test` runs with NODE_ENV unset (verified by probe),
// so force it: the email/SMS outbox seams and timer suppression key off it.
// Each test file runs in its own process — no cross-file impact.
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { testEmailOutbox, clearTestEmailOutbox } from './emailService.js';
import { testSmsOutbox, clearTestSmsOutbox } from './smsService.js';
import {
  createLeaveRequest,
  decideLeaveRequest,
  undoLeaveDecision,
  undoSubmittedLeaveRequest,
  cancelLeaveRequest,
  cancelApprovedLeaveByApprover,
  undoLeaveCancellation,
  editLeaveRequest,
  dispatchSubmitNotifications,
  runLeaveDecisionNotifyJob,
} from './leaveService.js';
import {
  getISTDateInputValue,
  getISTYear,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  clearTestEmailOutbox();
  clearTestSmsOutbox();
  await Promise.all([
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    Notification.deleteMany({}),
    LeaveType.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  const { closeEmailTransport } = await import('./emailService.js');
  closeEmailTransport();
  await mongoose.disconnect();
  await memoryServer.stop();
});

function nextWorkingDay(fromKey, days = 3) {
  let day = parseDateInputAsISTDay(fromKey);
  let remaining = days;
  while (remaining > 0) {
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return getISTDateInputValue(day);
}

async function createUser(name, { reportingManagerId = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: '',
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `T${String(sequence).padStart(8, '0')}`,
    passwordHash: 'test-password-hash',
    role: 'employee',
    reportingManagerId,
    isActive: true,
  });
}

async function seedLeaveSetup() {
  const manager = await createUser('LifecycleManager');
  const applicant = await createUser('LifecycleApplicant', { reportingManagerId: manager._id });
  const leaveType = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
  const dayKey = nextWorkingDay(getISTDateInputValue(), 5);
  const year = getISTYear(parseDateInputAsISTDay(dayKey));
  await LeavePolicy.create({
    leaveTypeId: leaveType._id,
    year,
    annualQuota: 12,
    accrualPerMonth: 0,
    paid: true,
    isActive: true,
  });
  return { manager, applicant, leaveType, dayKey, year };
}

function submitPayload(leaveType, dayKey, reason = 'Family function') {
  return {
    leaveTypeId: leaveType._id,
    startDate: dayKey,
    endDate: dayKey,
    halfDay: null,
    reason,
  };
}

async function seedSLSetup() {
  const manager = await createUser('SLManager');
  const applicant = await createUser('SLApplicant', { reportingManagerId: manager._id });
  const leaveType = await LeaveType.create({ code: 'SL', name: 'Sick Leave', isActive: true });
  const dayKey = nextWorkingDay(getISTDateInputValue(), 5);
  const year = getISTYear(parseDateInputAsISTDay(dayKey));
  await LeavePolicy.create({
    leaveTypeId: leaveType._id,
    year,
    annualQuota: 12,
    accrualPerMonth: 0,
    paid: true,
    isActive: true,
  });
  return { manager, applicant, leaveType, dayKey, year };
}

function submitHalfDayPayload(leaveType, dayKey, reason = 'Fever') {
  return {
    leaveTypeId: leaveType._id,
    startDate: dayKey,
    endDate: dayKey,
    halfDay: 'am',
    reason,
  };
}

async function balanceUsed(applicant, leaveType, year) {
  const balance = await LeaveBalance.findOne({
    userId: applicant._id,
    leaveTypeId: leaveType._id,
    year,
  }).lean();
  return balance?.used ?? null;
}

const managerPerms = [PERMISSIONS.LEAVE_APPROVE];

function emailsByTag(tag) {
  return testEmailOutbox.filter((mail) => mail.tag === tag);
}

async function balancePending(applicant, leaveType, year) {
  const balance = await LeaveBalance.findOne({
    userId: applicant._id,
    leaveTypeId: leaveType._id,
    year,
  }).lean();
  return balance?.pending ?? null;
}

// ── 1. Submit → undo is fully silent ─────────────────────────────────────────
test('submit then undo sends zero emails/SMS/notifications and releases balance', async () => {
  const { applicant, leaveType, dayKey, year } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  assert.equal(created.status, 'pending');
  assert.ok(created.decisionUndoExpiresAt, 'submit carries an undo expiry');
  assert.equal(await balancePending(applicant, leaveType, year), 1);

  const withdrawn = await undoSubmittedLeaveRequest(created.id, applicant);
  assert.equal(withdrawn.status, 'cancelled');

  assert.equal(testEmailOutbox.length, 0, 'no email on undo');
  assert.equal(testSmsOutbox.length, 0, 'no SMS on undo');
  assert.equal(await Notification.countDocuments({}), 0, 'no in-app notification on undo');
  assert.equal(await balancePending(applicant, leaveType, year), 0, 'reserved day released');
});

// ── 2. Repeated undo finalizes only the survivor ────────────────────────────
test('repeated submit/undo cycles notify only the final surviving revision', async () => {
  const { applicant, leaveType, dayKey } = await seedLeaveSetup();

  const first = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey, 'v1'));
  await undoSubmittedLeaveRequest(first.id, applicant);
  const secondDay = nextWorkingDay(dayKey, 1);
  const second = await createLeaveRequest(applicant._id, submitPayload(leaveType, secondDay, 'v2'));
  await undoSubmittedLeaveRequest(second.id, applicant);
  const thirdDay = nextWorkingDay(dayKey, 2);
  const third = await createLeaveRequest(applicant._id, submitPayload(leaveType, thirdDay, 'final'));

  // Finalize via the sweep (as the background job would after expiry+delay).
  const dueAt = new Date(new Date(third.decisionUndoExpiresAt).getTime() + 5000);
  const job = await runLeaveDecisionNotifyJob(dueAt);
  assert.equal(job.submitNotified, 1);

  assert.equal(emailsByTag('leave-manager').length, 1, 'exactly one manager email');
  assert.equal(emailsByTag('leave-submitted').length, 1, 'exactly one applicant submit email');
  assert.match(emailsByTag('leave-submitted')[0].subject, /Casual Leave/);
  assert.match(emailsByTag('leave-submitted')[0].text, /final/, 'email reflects the final version');
  assert.equal(testEmailOutbox.length, 2, 'no email leaked for undone versions');
});

// ── 3. Admin repeated decisions: only the final one is mailed ───────────────
test('approve, undo, reject finalizes only the final decision and remarks', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  clearTestEmailOutbox();
  clearTestSmsOutbox();

  await decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'remark A' });
  await undoLeaveDecision(created.id, manager, managerPerms);
  await decideLeaveRequest(created.id, manager, managerPerms, 'rejected', { comment: 'remark B final' });

  // Before expiry: the job must not finalize.
  const early = await runLeaveDecisionNotifyJob(new Date());
  assert.equal(early.processed, 0, 'nothing finalizes before the undo window expires');
  assert.equal(emailsByTag('leave-status').length, 0, 'no applicant email while undoable');

  const staged = await LeaveRequest.findById(created.id).lean();
  const dueAt = new Date(new Date(staged.notifyAfter).getTime() + 1000);
  const late = await runLeaveDecisionNotifyJob(dueAt);
  assert.equal(late.processed, 1);

  const final = await LeaveRequest.findById(created.id).lean();
  assert.equal(final.status, 'rejected');
  assert.equal(final.pendingDecision, null);
  assert.ok(final.finalizedAt, 'finalization timestamp recorded');

  const statusMails = emailsByTag('leave-status');
  assert.equal(statusMails.length, 1, 'exactly one decision email');
  assert.match(statusMails[0].subject, /rejected/);
  assert.match(statusMails[0].text, /remark B final/, 'email carries final remarks, not remark A');
});

// ── 4. Double decision collapses to one ─────────────────────────────────────
test('concurrent double approve stages once; the loser gets 409', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));

  const results = await Promise.allSettled([
    decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'first' }),
    decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'second' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.statusCode, 409);

  const saved = await LeaveRequest.findById(created.id).lean();
  assert.equal(saved.pendingDecision, 'approved');
  assert.equal(saved.pendingRevision, saved.revision);
});

// ── 5. Undo after expiry is rejected; finalized state stands ────────────────
test('undo past the window is rejected and the finalized outcome stands', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  await decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'ok' });

  // Force expiry without finalizing.
  await LeaveRequest.updateOne(
    { _id: created.id },
    { $set: { undoExpiresAt: new Date(Date.now() - 1000) } },
  );
  await assert.rejects(undoLeaveDecision(created.id, manager, managerPerms), (err) => {
    assert.equal(err.statusCode, 410);
    return true;
  });

  // Finalizer still commits the staged approval exactly once.
  const staged = await LeaveRequest.findById(created.id).lean();
  const job = await runLeaveDecisionNotifyJob(new Date(new Date(staged.notifyAfter).getTime() + 1000));
  assert.equal(job.processed, 1);
  const final = await LeaveRequest.findById(created.id).lean();
  assert.equal(final.status, 'approved');
  assert.equal(emailsByTag('leave-status').length, 1);

  // Undo after finalization is rejected too.
  await assert.rejects(undoLeaveDecision(created.id, manager, managerPerms), (err) => {
    assert.equal(err.statusCode, 410);
    return true;
  });
});

// ── 6. Stale finalizer is a no-op ───────────────────────────────────────────
test('a stale staged revision never finalizes or notifies', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  clearTestEmailOutbox();

  await decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'v1' });
  const staged = await LeaveRequest.findById(created.id).lean();

  // Corrupt the binding the way a superseding action would (revision moved
  // on but an old worker still holds the previous pendingRevision).
  await LeaveRequest.updateOne(
    { _id: created.id },
    { $set: { revision: staged.revision + 1 } },
  );

  const job = await runLeaveDecisionNotifyJob(new Date(new Date(staged.notifyAfter).getTime() + 5000));
  assert.deepEqual(job.skippedStale, [String(created.id)]);
  assert.equal(job.processed, 0);
  assert.equal(testEmailOutbox.length, 0, 'stale finalizer sends nothing');

  const saved = await LeaveRequest.findById(created.id).lean();
  assert.equal(saved.status, 'pending', 'stale run changes nothing');
  assert.equal(saved.pendingDecision, 'approved');
});

// ── 7. notifyAfter trails undo expiry by the notification delay ─────────────
test('finalize time trails undo expiry by the post-expiry delay', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  // Submit deferral itself carries expiry + delay.
  const submitGap = new Date(created.decisionUndoExpiresAt).getTime();
  const submitDoc = await LeaveRequest.findById(created.id).lean();
  assert.ok(new Date(submitDoc.notifyAfter).getTime() - submitGap >= 2000, 'submit notify trails expiry');

  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  await decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'ok' });
  const staged = await LeaveRequest.findById(created.id).lean();
  const gap = new Date(staged.notifyAfter).getTime() - new Date(staged.undoExpiresAt).getTime();
  assert.ok(gap >= 2000 && gap <= 10000, `decision notify trails expiry by ~2.5s (got ${gap}ms)`);
});

// ── 8. Pending cancel notifies applicant AND manager ────────────────────────
test('employee cancels a pending request: applicant and manager are notified', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  clearTestEmailOutbox();
  clearTestSmsOutbox();

  await cancelLeaveRequest(created.id, applicant);

  const applicantMail = emailsByTag('leave-cancelled');
  assert.equal(applicantMail.length, 1, 'applicant gets the cancellation email');
  const managerMail = emailsByTag('leave-cancelled-manager');
  assert.equal(managerMail.length, 1, 'manager gets the cancellation email');
  assert.equal(managerMail[0].to, manager.email);

  const managerNotice = await Notification.findOne({ userId: manager._id, type: 'leave.cancelled' }).lean();
  assert.ok(managerNotice, 'manager gets an in-app cancellation notice');
});

// ── 9. Approved cancel follows the undo lifecycle ───────────────────────────
test('approved cancel is silent under undo and notifies both sides after expiry', async () => {
  const { manager, applicant, leaveType, dayKey, year } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  await decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'ok' });
  const staged = await LeaveRequest.findById(created.id).lean();
  await runLeaveDecisionNotifyJob(new Date(new Date(staged.notifyAfter).getTime() + 1000));
  clearTestEmailOutbox();
  clearTestSmsOutbox();

  // Stage a cancellation, then undo it: zero cancel emails.
  await cancelLeaveRequest(created.id, applicant);
  await undoLeaveCancellation(created.id, applicant, []);
  assert.equal(emailsByTag('leave-cancelled').length, 0, 'no applicant cancel email on undo');
  assert.equal(emailsByTag('leave-cancelled-manager').length, 0, 'no manager cancel email on undo');
  assert.equal(emailsByTag('leave-cancelled-approver').length, 0, 'no approver cancel email on undo');
  const restored = await LeaveRequest.findById(created.id).lean();
  assert.equal(restored.status, 'approved', 'undo restores the approved state');

  // Cancel again and let it finalize.
  await cancelApprovedLeaveByApprover(created.id, manager, managerPerms, { decisionComment: 'role change' });
  const stagedCancel = await LeaveRequest.findById(created.id).lean();
  const job = await runLeaveDecisionNotifyJob(new Date(new Date(stagedCancel.notifyAfter).getTime() + 1000));
  assert.equal(job.processed, 1);

  const final = await LeaveRequest.findById(created.id).lean();
  assert.equal(final.status, 'cancelled');
  assert.equal(emailsByTag('leave-cancelled').length, 1, 'applicant notified once');
  assert.ok(
    emailsByTag('leave-cancelled-manager').length + emailsByTag('leave-cancelled-approver').length >= 1,
    'manager side notified once',
  );
  assert.equal(await balancePending(applicant, leaveType, year), 0);
});

// ── 10. Edit is blocked while a decision is staged ──────────────────────────
test('editing during a staged decision is rejected; works after undo', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  await decideLeaveRequest(created.id, manager, managerPerms, 'approved', { comment: 'ok' });

  await assert.rejects(
    editLeaveRequest(created.id, applicant, submitPayload(leaveType, nextWorkingDay(dayKey, 1), 'changed')),
    /pending/i,
  );

  await undoLeaveDecision(created.id, manager, managerPerms);
  const edited = await editLeaveRequest(
    created.id,
    applicant,
    submitPayload(leaveType, nextWorkingDay(dayKey, 1), 'changed'),
  );
  assert.equal(edited.status, 'pending');
  assert.ok(edited.decisionUndoExpiresAt, 'edit restarts the undo window');
});

// ── 11. Withdraw after delivery is rejected ─────────────────────────────────
test('withdraw after the submit notification went out is rejected', async () => {
  const { applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await dispatchSubmitNotifications(
    created.id,
    new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000),
  );
  assert.equal(emailsByTag('leave-manager').length, 1);

  await assert.rejects(undoSubmittedLeaveRequest(created.id, applicant), (err) => {
    assert.equal(err.statusCode, 409);
    return true;
  });
  // No duplicate delivery from the failed withdraw.
  assert.equal(emailsByTag('leave-manager').length, 1);
});

// ── 12. SL half-day follows the undo lifecycle (no instant approval) ────────
test('SL half-day submit stays pending and undo is silent', async () => {
  const { applicant, leaveType, dayKey, year } = await seedSLSetup();

  const created = await createLeaveRequest(applicant._id, submitHalfDayPayload(leaveType, dayKey));
  assert.equal(created.status, 'pending', 'SL is provisional, not instantly approved');
  assert.ok(created.decisionUndoExpiresAt, 'SL submit carries an undo expiry');
  assert.equal(await balancePending(applicant, leaveType, year), 0.5);

  const withdrawn = await undoSubmittedLeaveRequest(created.id, applicant);
  assert.equal(withdrawn.status, 'cancelled');

  assert.equal(testEmailOutbox.length, 0, 'no email on SL undo');
  assert.equal(testSmsOutbox.length, 0, 'no SMS on SL undo');
  assert.equal(await Notification.countDocuments({}), 0, 'no in-app notification on SL undo');
  assert.equal(await balancePending(applicant, leaveType, year), 0, 'reserved half-day released');
});

// ── 13. SL auto-approves at expiry with applicant + manager info mail ───────
test('SL finalizes to approved after the undo window with correct emails', async () => {
  const { manager, applicant, leaveType, dayKey, year } = await seedSLSetup();

  const created = await createLeaveRequest(applicant._id, submitHalfDayPayload(leaveType, dayKey));
  // Before expiry the sweep must not approve or notify.
  const early = await runLeaveDecisionNotifyJob(new Date());
  assert.equal(early.processed, 0);
  assert.equal(testEmailOutbox.length, 0);

  const dueAt = new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000);
  const job = await runLeaveDecisionNotifyJob(dueAt);
  assert.equal(job.submitNotified, 1);

  const final = await LeaveRequest.findById(created.id).lean();
  assert.equal(final.status, 'approved', 'SL auto-approved after expiry');
  assert.ok(final.finalizedAt, 'finalization timestamp recorded');
  assert.equal(await balanceUsed(applicant, leaveType, year), 0.5, 'pending converted to used');
  assert.equal(await balancePending(applicant, leaveType, year), 0);

  const statusMails = emailsByTag('leave-status');
  assert.equal(statusMails.length, 1, 'applicant gets exactly one approval email');
  assert.match(statusMails[0].subject, /approved/);
  const managerMails = emailsByTag('leave-manager');
  assert.equal(managerMails.length, 1, 'manager gets exactly one info email');
  assert.equal(managerMails[0].to, manager.email);
  assert.doesNotMatch(managerMails[0].text, /Take action here/, 'manager info mail has no Take Action link');
  // No submit-phase emails for auto-approved types.
  assert.equal(emailsByTag('leave-submitted').length, 0, 'no submit email for SL');
});

// ── 14. SL repeated undo notifies only the final approval ───────────────────
test('SL repeated submit/undo cycles approve and notify only the survivor', async () => {
  const { applicant, leaveType, dayKey, year } = await seedSLSetup();

  const first = await createLeaveRequest(applicant._id, submitHalfDayPayload(leaveType, dayKey, 'v1'));
  await undoSubmittedLeaveRequest(first.id, applicant);
  const secondDay = nextWorkingDay(dayKey, 1);
  const second = await createLeaveRequest(applicant._id, submitHalfDayPayload(leaveType, secondDay, 'v2'));
  await undoSubmittedLeaveRequest(second.id, applicant);
  const thirdDay = nextWorkingDay(dayKey, 2);
  const third = await createLeaveRequest(applicant._id, submitHalfDayPayload(leaveType, thirdDay, 'final'));

  const dueAt = new Date(new Date(third.decisionUndoExpiresAt).getTime() + 5000);
  await runLeaveDecisionNotifyJob(dueAt);

  assert.equal(emailsByTag('leave-status').length, 1, 'exactly one approval email');
  assert.equal(emailsByTag('leave-manager').length, 1, 'exactly one manager info email');
  assert.equal(testEmailOutbox.length, 2, 'nothing leaked for undone SL versions');
  const final = await LeaveRequest.findById(third.id).lean();
  assert.equal(final.status, 'approved');
  assert.equal(await balanceUsed(applicant, leaveType, year), 0.5);
});

// ── 15. SL edit-in-window restarts the window, then approves ────────────────
test('SL edit during the undo window restarts the window and approves after', async () => {
  const { applicant, leaveType, dayKey, year } = await seedSLSetup();

  const created = await createLeaveRequest(applicant._id, submitHalfDayPayload(leaveType, dayKey, 'v1'));
  const editedDay = nextWorkingDay(dayKey, 1);
  const edited = await editLeaveRequest(
    created.id,
    applicant,
    submitHalfDayPayload(leaveType, editedDay, 'v2'),
  );
  assert.equal(edited.status, 'pending');
  assert.ok(edited.decisionUndoExpiresAt, 'edit restarts the SL undo window');

  // Between the original expiry and the new finalize time, the sweep must
  // not approve: the superseded revision's timing no longer matches.
  const betweenAt = new Date(new Date(created.decisionUndoExpiresAt).getTime() + 1000);
  const editedDoc = await LeaveRequest.findById(created.id).lean();
  assert.ok(
    new Date(editedDoc.notifyAfter).getTime() > betweenAt.getTime(),
    'new finalize time is still in the future at the stale sweep',
  );
  await runLeaveDecisionNotifyJob(betweenAt);
  const mid = await LeaveRequest.findById(created.id).lean();
  assert.equal(mid.status, 'pending', 'superseded SL revision is not approved early');
  assert.equal(testEmailOutbox.length, 0, 'no email for the superseded revision');

  const dueAt = new Date(new Date(edited.decisionUndoExpiresAt).getTime() + 5000);
  await runLeaveDecisionNotifyJob(dueAt);
  const final = await LeaveRequest.findById(created.id).lean();
  assert.equal(final.status, 'approved');
  assert.equal(emailsByTag('leave-status').length, 1);
  assert.equal(await balanceUsed(applicant, leaveType, year), 0.5);
});

// ── 16. Approved SL follows the staged cancel lifecycle ─────────────────────
test('approved SL cancels through the undo lifecycle', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedSLSetup();

  const created = await createLeaveRequest(applicant._id, submitHalfDayPayload(leaveType, dayKey));
  await runLeaveDecisionNotifyJob(new Date(new Date(created.decisionUndoExpiresAt).getTime() + 5000));
  clearTestEmailOutbox();
  clearTestSmsOutbox();

  await cancelLeaveRequest(created.id, applicant);
  await undoLeaveCancellation(created.id, applicant, []);
  assert.equal(testEmailOutbox.length, 0, 'no cancel email on SL undo');
  const restored = await LeaveRequest.findById(created.id).lean();
  assert.equal(restored.status, 'approved', 'SL undo restores the approved state');

  await cancelApprovedLeaveByApprover(created.id, manager, managerPerms, { decisionComment: 'recovered' });
  const stagedCancel = await LeaveRequest.findById(created.id).lean();
  assert.equal(stagedCancel.pendingDecision, 'cancelled');
  const job = await runLeaveDecisionNotifyJob(new Date(new Date(stagedCancel.notifyAfter).getTime() + 1000));
  assert.equal(job.processed, 1);
  const final = await LeaveRequest.findById(created.id).lean();
  assert.equal(final.status, 'cancelled');
  assert.equal(emailsByTag('leave-cancelled').length, 1, 'applicant notified once');
});
