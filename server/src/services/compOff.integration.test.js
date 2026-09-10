// This repo's `npm test` runs with NODE_ENV unset, which would route email/SMS
// assertions to the real providers. Pin test mode so the outbox seams engage
// (each test file runs in its own process — no cross-file impact).
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { CompOffRequest } from '../models/CompOffRequest.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Notification } from '../models/Notification.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import {
  assessCompOffWork,
  consumeCompOffDecisionToken,
  createCompOffRequest,
  decideCompOffRequest,
  issueCompOffDecisionToken,
  listCompOffRequests,
  peekCompOffDecisionToken,
  runCompOffSweep,
  undoCompOffAssessment,
  undoCompOffDecision,
  undoCompOffSubmit,
  undoCompOffWithdraw,
} from './compOffService.js';
import { compOffDecisionLoginHandler } from '../controllers/compOffController.js';
import { createLeaveRequest } from './leaveService.js';
import { clearTestEmailOutbox, testEmailOutbox } from './emailService.js';
import { clearTestSmsOutbox, testSmsOutbox } from './smsService.js';
import { seedLeaveTypesAndPolicies } from './leaveBalanceService.js';
import { getISTDateInputValue, parseDateInputAsISTDay, startOfDayIST } from '../utils/istDate.js';

const ADMIN_PERMS = [
  PERMISSIONS.LEAVE_READ_ALL,
  PERMISSIONS.LEAVE_APPROVE,
  PERMISSIONS.LEAVE_READ,
  PERMISSIONS.LEAVE_APPLY,
];
const MANAGER_PERMS = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_READ];
const EMPLOYEE_PERMS = [PERMISSIONS.LEAVE_APPLY, PERMISSIONS.LEAVE_READ];
/** Far-future clock for sweeps: submit window (10s) + decision window (15s) + delay. */
const FUTURE = new Date(Date.now() + 60_000);

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence = 0;
  clearTestEmailOutbox();
  clearTestSmsOutbox();
  await Promise.all([
    AttendanceRecord.deleteMany({}),
    CompOffRequest.deleteMany({}),
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    Notification.deleteMany({}),
    OfficeSettings.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
  await seedLeaveTypesAndPolicies();
});

after(async () => {
  const { closeEmailTransport } = await import('./emailService.js');
  closeEmailTransport();
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser(name, { reportingManagerId = null, isManager = false } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: '',
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `T${String(sequence).padStart(8, '0')}`,
    passwordHash: 'test-password-hash',
    role: isManager || reportingManagerId ? 'admin' : 'employee',
    reportingManagerId,
    isActive: true,
  });
}

/** Next weekend day (Sat=6 or Sun=0) strictly after `afterKey`, up to 40 days out. */
function nextWeekendKey(afterKey) {
  let day = parseDateInputAsISTDay(afterKey);
  for (let i = 0; i < 40; i += 1) {
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const dow = day.getUTCDay();
    if (dow === 6 || dow === 0) return getISTDateInputValue(day);
  }
  throw new Error('no weekend found');
}

async function createCompOffFixture({ manager = null, employeeName = 'Employee' } = {}) {
  const managerUser = manager ?? (await createUser('Manager', { isManager: true }));
  const employee = await createUser(employeeName, { reportingManagerId: managerUser._id });
  const satKey = nextWeekendKey(getISTDateInputValue());
  const sunKey = nextWeekendKey(satKey);
  return { manager: managerUser, employee, satKey, sunKey };
}

async function submitCompOff(employee, satKey, sunKey = null, reason = 'Working the weekend for the release.') {
  return createCompOffRequest(employee._id, {
    startDate: satKey,
    endDate: sunKey ?? satKey,
    reason,
  });
}

function countNotifications(type = null) {
  const filter = type ? { type } : {};
  return Notification.countDocuments(filter);
}

test('withdraw stages silently: request stays pending until the window expires', async () => {
  const { employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  assert.equal(created.status, 'pending');
  assert.ok(created.decisionUndoExpiresAt, 'undo expiry exposed');

  // Nothing was notified/reserved while the undo window is open.
  assert.equal(await countNotifications(), 0);
  assert.equal(testEmailOutbox.length, 0);
  assert.equal(testSmsOutbox.length, 0);

  const withdrawn = await undoCompOffSubmit(created.id, employee);
  assert.equal(withdrawn.status, 'pending', 'staged withdrawal keeps status pending');
  assert.equal(withdrawn.pendingAction, 'cancelled');
  assert.ok(withdrawn.decisionUndoExpiresAt, 'withdrawal carries its own undo expiry');
  assert.equal(await countNotifications(), 0, 'staging the withdrawal is silent');
  assert.equal(testEmailOutbox.length, 0);
  assert.equal(testSmsOutbox.length, 0);

  // Finalize the staged withdrawal: silent cancellation, no balance touch.
  await runCompOffSweep(FUTURE);
  const final = await CompOffRequest.findById(created.id).lean();
  assert.equal(final.status, 'cancelled');
  assert.equal(await countNotifications(), 0, 'finalized withdrawal stays silent');
  assert.equal(testEmailOutbox.length, 0);
  assert.equal(testSmsOutbox.length, 0);

  // CO balance untouched by submit/withdraw.
  const coType = await LeaveType.findOne({ code: 'CO' });
  const balances = await LeaveBalance.find({ userId: employee._id, leaveTypeId: coType._id });
  assert.equal(balances.length, 0, 'no CO balance row should exist');
});

test('repeated submit/withdraw notifies the manager exactly once for the surviving request', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const first = await submitCompOff(employee, satKey, null, 'First attempt');
  await undoCompOffSubmit(first.id, employee);
  // The staged withdrawal must finalize before the same dates are reusable.
  await runCompOffSweep(FUTURE);
  assert.equal((await CompOffRequest.findById(first.id).lean()).status, 'cancelled');

  const second = await submitCompOff(employee, satKey, null, 'Second attempt');
  await runCompOffSweep(FUTURE);

  const live = await CompOffRequest.findById(second.id).lean();
  assert.equal(live.status, 'pending', 'submit finalization keeps status pending');
  assert.equal(live.submitNotificationsSent, true);

  assert.equal(await countNotifications('comp_off_pending'), 1, 'manager in-app exactly once');
  const managerEmail = testEmailOutbox.filter((m) => m.tag === 'comp-off-manager');
  assert.equal(managerEmail.length, 1, 'manager email exactly once');
  assert.ok(managerEmail[0].text.includes('Second attempt'));
  assert.equal(await countNotifications('comp_off_pending'), 1);
  // No applicant submit notices.
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-status').length, 0);
});

test('approve → undo → reject → only the final rejection is emailed with the final remark', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);

  const stagedApprove = await decideCompOffRequest(
    created.id,
    manager,
    MANAGER_PERMS,
    'approve',
    {},
  );
  assert.equal(stagedApprove.pendingAction, 'approved');
  assert.equal(stagedApprove.status, 'pending', 'status frozen during undo window');

  const undone = await undoCompOffDecision(created.id, manager, MANAGER_PERMS);
  assert.equal(undone.pendingAction, null);
  assert.equal(await countNotifications('comp_off_undone'), 1, 'applicant sees the undo in-app');
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-status').length, 0);

  const stagedReject = await decideCompOffRequest(
    created.id,
    manager,
    MANAGER_PERMS,
    'reject',
    { comment: 'Not enough coverage that day.' },
  );
  assert.equal(stagedReject.pendingAction, 'rejected');
  await runCompOffSweep(FUTURE);

  const finalRequest = await CompOffRequest.findById(created.id).lean();
  assert.equal(finalRequest.status, 'rejected');
  assert.equal(await countNotifications('comp_off_decision'), 1);
  const emails = testEmailOutbox.filter((m) => m.tag === 'comp-off-status');
  assert.equal(emails.length, 1, 'exactly one decision email for the final outcome');
  assert.ok(emails[0].text.includes('rejected'));
  assert.ok(emails[0].text.includes('Not enough coverage that day.'));
  assert.ok(!emails[0].text.includes('approved'));
});

test('double approve resolves to one staged decision; loser gets 409', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const admin2 = await createUser('Admin Two', { isManager: true });
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);

  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await assert.rejects(
    decideCompOffRequest(created.id, admin2, ADMIN_PERMS, 'approve', {}),
    (err) => err.statusCode === 409,
  );
  const live = await CompOffRequest.findById(created.id).lean();
  assert.equal(live.pendingAction, 'approved');
});

test('undo past expiry returns 410; finalize commits the staged outcome exactly once', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);

  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  // Force the undo window closed: decision window is ~15s.
  await CompOffRequest.updateOne(
    { _id: created.id },
    { $set: { undoExpiresAt: new Date(Date.now() - 1000) } },
  );
  await assert.rejects(
    undoCompOffDecision(created.id, manager, MANAGER_PERMS),
    (err) => err.statusCode === 410,
  );

  await runCompOffSweep(FUTURE);
  await runCompOffSweep(FUTURE); // idempotent second pass
  const live = await CompOffRequest.findById(created.id).lean();
  assert.equal(live.status, 'approved');
  assert.equal(live.notificationsSent, true);
  assert.equal(await countNotifications('comp_off_decision'), 1, 'one employee notification');
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-status').length, 1);
});

test('stale pendingRevision items are skipped by the finalizer without state or mail changes', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});

  // Simulate a newer revision superseding the staged one (e.g. an undo landed
  // and a fresh action was staged) with stale timing still due.
  await CompOffRequest.updateOne(
    { _id: created.id },
    { $set: { revision: 5, notifyAfter: new Date(Date.now() - 1000) } },
  );

  const result = await runCompOffSweep(FUTURE);
  assert.ok(result.skippedStale.includes(String(created.id)), 'stale item recorded as skipped');
  const live = await CompOffRequest.findById(created.id).lean();
  assert.equal(live.pendingAction, 'approved', 'staged state untouched');
  assert.equal(
    await countNotifications(),
    1,
    'only the pre-existing manager submit notification exists',
  );
  assert.equal(await countNotifications('comp_off_decision'), 0, 'no decision notification');
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-status').length, 0);
});

test('scope enforcement: non-manager approve 403, other-manager 403, admin read_all ok', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const otherManager = await createUser('Other Manager', { isManager: true });
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);

  await assert.rejects(
    decideCompOffRequest(created.id, employee, EMPLOYEE_PERMS, 'approve', {}),
    (err) => err.statusCode === 403,
  );
  await assert.rejects(
    decideCompOffRequest(created.id, otherManager, MANAGER_PERMS, 'approve', {}),
    (err) => err.statusCode === 403,
  );
  const staged = await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  assert.equal(staged.pendingAction, 'approved');

  // Admin with read_all may act on any request.
  const second = await submitCompOff(employee, nextWeekendKey(satKey));
  await runCompOffSweep(FUTURE);
  const adminActed = await decideCompOffRequest(second.id, otherManager, ADMIN_PERMS, 'approve', {});
  assert.equal(adminActed.pendingAction, 'approved');
});

test('approvals list is scoped to the manager reports; mine returns own requests', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const otherManager = await createUser('Other Manager', { isManager: true });
  const otherEmployee = await createUser('Other Employee', { reportingManagerId: otherManager._id });
  const created = await submitCompOff(employee, satKey);
  await submitCompOff(otherEmployee, nextWeekendKey(satKey));

  const mine = await listCompOffRequests(employee, EMPLOYEE_PERMS, {
    scope: 'mine',
    status: 'all',
    page: 1,
    limit: 20,
  });
  assert.equal(mine.pagination.total, 1);
  assert.equal(mine.requests[0].id, created.id);

  const approvals = await listCompOffRequests(manager, MANAGER_PERMS, {
    scope: 'approvals',
    status: 'all',
    page: 1,
    limit: 20,
  });
  assert.equal(approvals.pagination.total, 1, 'manager sees only own reports');
  const adminView = await listCompOffRequests(otherManager, ADMIN_PERMS, {
    scope: 'approvals',
    status: 'all',
    page: 1,
    limit: 20,
  });
  assert.equal(adminView.pagination.total, 2, 'admin read_all sees all');
});

test('overlapping open request 409 and overlapping leave 400 block creation', async () => {
  const { employee, satKey, sunKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey, sunKey);
  await assert.rejects(
    submitCompOff(employee, sunKey, sunKey, 'Overlap attempt'),
    (err) => err.statusCode === 409,
  );
  await undoCompOffSubmit(created.id, employee);
  await runCompOffSweep(FUTURE);
  assert.equal((await CompOffRequest.findById(created.id).lean()).status, 'cancelled');

  // Leave overlap: an SL leave request (non-WFH) covering the day blocks.
  const slType = await LeaveType.findOne({ code: 'SL' });
  await LeaveRequest.create({
    userId: employee._id,
    leaveTypeId: slType._id,
    startDate: parseDateInputAsISTDay(satKey),
    endDate: parseDateInputAsISTDay(satKey),
    days: 1,
    reason: 'Sick',
    status: 'approved',
  });
  await assert.rejects(
    submitCompOff(employee, satKey, satKey, 'Leave-overlap attempt'),
    (err) => err.statusCode === 400,
  );
});

test('happy path: manager notified after submit, employee after approve, credit posts on assess finalize', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  assert.equal(await countNotifications(), 0, 'provisional submit is silent');
  assert.equal(testEmailOutbox.length, 0);

  // Submit undo window expires → manager notified.
  await runCompOffSweep(FUTURE);
  assert.equal(await countNotifications('comp_off_pending'), 1);
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-manager').length, 1);
  assert.equal(testSmsOutbox.length, 1, 'manager submit SMS sent post-finalize');
  assert.ok(testSmsOutbox[0].message.includes('for comp off'), testSmsOutbox[0].message);

  // Manager approves → employee notified only after finalize.
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  assert.equal(await countNotifications('comp_off_decision'), 0, 'no notify while undoable');
  await runCompOffSweep(FUTURE);
  const approvedDoc = await CompOffRequest.findById(created.id).lean();
  assert.equal(approvedDoc.status, 'approved');
  assert.equal(await countNotifications('comp_off_decision'), 1);
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-status').length, 1);

  // Employee works the holiday and checks out → status worked (the attendance
  // checkout hook drives this; here we emulate the post-hook state including
  // the linked checkout record — see the gate suite for the real-hook path).
  await CompOffRequest.updateOne(
    { _id: created.id },
    { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } },
  );

  // Manager assesses "Work completed".
  const staged = await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', { comment: 'Great work.' });
  assert.equal(staged.pendingAction, 'assessed');
  assert.equal(await countNotifications('comp_off_assessed'), 0, 'no credit before finalize');

  await runCompOffSweep(FUTURE);
  const assessedDoc = await CompOffRequest.findById(created.id).lean();
  assert.equal(assessedDoc.status, 'assessed');
  assert.equal(assessedDoc.creditedDays, 1);

  const coType = await LeaveType.findOne({ code: 'CO' });
  const balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id });
  assert.ok(balance, 'CO balance ensured at assess finalize');
  assert.equal(balance.compOffEarned, 1, 'credit posted once, atomically');
  assert.equal(await countNotifications('comp_off_assessed'), 1);
  const creditEmail = testEmailOutbox.filter((m) => m.tag === 'comp-off-assessed');
  assert.equal(creditEmail.length, 1);
  assert.ok(creditEmail[0].text.includes('+1 day'));
  const creditSms = testSmsOutbox.filter((item) => item.message.includes('added to your CO balance'));
  assert.equal(creditSms.length, 1, 'applicant credit SMS sent post-finalize');
  assert.ok(creditSms[0].message.includes('+1 day'));
});

test('half assessment credits days × 0.5; none credits 0 — both still notify', async () => {
  const { manager, employee, satKey, sunKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey, sunKey); // 2 days
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });

  await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'half', {});
  await runCompOffSweep(FUTURE);
  const coType = await LeaveType.findOne({ code: 'CO' });
  let balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id });
  assert.equal(balance.compOffEarned, 1, '2 × 0.5');

  const secondSat = nextWeekendKey(sunKey);
  const created2 = await submitCompOff(employee, secondSat);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created2.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created2.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });

  await assessCompOffWork(created2.id, manager, MANAGER_PERMS, 'none', {});
  await runCompOffSweep(FUTURE);
  const assessed2 = await CompOffRequest.findById(created2.id).lean();
  assert.equal(assessed2.status, 'assessed', 'none still finalizes to assessed');
  assert.equal(assessed2.creditedDays, 0);
  balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id });
  assert.equal(balance.compOffEarned, 1, 'none adds nothing');
  assert.equal(await countNotifications('comp_off_assessed'), 2);
});

test('assess undo inside the window restores assessable state with no credit', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });

  await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', {});
  const undone = await undoCompOffAssessment(created.id, manager, MANAGER_PERMS);
  assert.equal(undone.pendingAction, null);
  assert.equal(undone.status, 'worked');
  assert.equal(await countNotifications('comp_off_undone'), 1);
  await runCompOffSweep(FUTURE);
  const coType = await LeaveType.findOne({ code: 'CO' });
  const balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id });
  assert.equal(balance, null, 'no balance touched when assessment undone');
});

test('assessing a non-worked request returns 409', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await assert.rejects(
    assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', {}),
    (err) => err.statusCode === 409 && /checked out/.test(err.message),
  );
});

test('lapse: approved request without check-in lapses silently after holiday + 1 day', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  assert.equal((await CompOffRequest.findById(created.id).lean()).status, 'approved');

  // No check-in ever happened. Advance well past the holiday + following day.
  await runCompOffSweep(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
  const live = await CompOffRequest.findById(created.id).lean();
  assert.equal(live.status, 'lapsed');
  assert.equal(await countNotifications(), 2, 'only submit + decision notifications exist');
  assert.equal(await countNotifications('comp_off_assessed'), 0);
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-status').length, 1);
  const coBalance = await LeaveBalance.findOne({ userId: employee._id });
  assert.equal(coBalance, null, 'no credit ever granted');
});

test('available balance includes compOffEarned and CO leave consumes it', async () => {
  const { manager, employee, satKey, sunKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey, sunKey); // 2 days
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });
  await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', {});
  await runCompOffSweep(FUTURE);

  const coType = await LeaveType.findOne({ code: 'CO' });
  let balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id });
  assert.equal(balance.compOffEarned, 2);
  const availableWithCredit = balance.toSafeJSON().available;
  assert.equal(availableWithCredit, 2, 'available = compOffEarned');

  // Apply CO leave for a future working day — the earned credit funds it.
  const workingDayKey = await findNextWorkingDayKey();
  const leaveReq = await createLeaveRequest(employee._id, {
    leaveTypeId: coType._id.toString(),
    startDate: workingDayKey,
    endDate: workingDayKey,
    reason: 'Taking a comp off',
  });
  assert.equal(leaveReq.leaveTypeCode, 'CO');
  assert.equal(leaveReq.days, 1);
  balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id });
  assert.equal(balance.pending, 1, 'CO leave reserves pending days');
  assert.equal(balance.toSafeJSON().available, 1, 'available reflects the reservation');
});

async function findNextWorkingDayKey() {
  let day = parseDateInputAsISTDay(getISTDateInputValue());
  for (let i = 0; i < 30; i += 1) {
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) return getISTDateInputValue(day);
  }
  throw new Error('no working day found');
}

test('lapse boundary is exact to the millisecond (startOfDayIST math)', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  assert.equal((await CompOffRequest.findById(created.id).lean()).status, 'approved');

  const endDate = parseDateInputAsISTDay(satKey);
  const dayAfterPlusOne = new Date(startOfDayIST(endDate).getTime() + 2 * 24 * 60 * 60 * 1000);
  // One millisecond before the lapse instant: still approved, no notifications.
  const before = await runCompOffSweep(new Date(dayAfterPlusOne.getTime() - 1));
  assert.equal((await CompOffRequest.findById(created.id).lean()).status, 'approved');
  assert.equal(before.lapse.lapsed, 0);
  // Exactly at the lapse instant (endDate < startOfDay(now) - 1 day): lapsed, silently.
  const mailsBefore = testEmailOutbox.length;
  const at = await runCompOffSweep(dayAfterPlusOne);
  assert.equal(at.lapse.lapsed, 1);
  const live = await CompOffRequest.findById(created.id).lean();
  assert.equal(live.status, 'lapsed');
  assert.equal(testEmailOutbox.length, mailsBefore, 'lapse sends no email');
  assert.equal(await countNotifications('comp_off_assessed'), 0);
});

test('past-date comp-off requests are rejected with a clear message', async () => {
  const { employee, satKey } = await createCompOffFixture();
  const pastDay = (() => {
    let day = parseDateInputAsISTDay(satKey);
    for (let i = 0; i < 14; i += 1) {
      day = new Date(day.getTime() - 24 * 60 * 60 * 1000);
      const dow = day.getUTCDay();
      if (dow === 6 || dow === 0) return getISTDateInputValue(day);
    }
    throw new Error('no past weekend');
  })();
  await assert.rejects(
    submitCompOff(employee, pastDay, null, 'Backdated weekend work'),
    (err) => err.statusCode === 400 && /past dates/i.test(err.message),
  );
});

test('self-approval is forbidden even with approve permission', async () => {
  const { employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await assert.rejects(
    decideCompOffRequest(created.id, employee, [...EMPLOYEE_PERMS, PERMISSIONS.LEAVE_APPROVE], 'approve', {}),
    (err) => err.statusCode === 403,
  );
  assert.equal((await CompOffRequest.findById(created.id).lean()).pendingAction, null);
});

test('inactive CO type fails assess finalize cleanly and recovers after reactivation', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });
  await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', {});
  await LeaveType.updateOne({ code: 'CO' }, { $set: { isActive: false } });

  const failed = await runCompOffSweep(FUTURE);
  assert.ok(failed.failed.length >= 1, 'item lands in the sweep failed list');
  assert.equal((await CompOffRequest.findById(created.id).lean()).status, 'worked', 'nothing half-applied');
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-assessed').length, 0, 'no credit email on failure');

  await LeaveType.updateOne({ code: 'CO' }, { $set: { isActive: true } });
  const recovered = await runCompOffSweep(FUTURE);
  assert.equal(recovered.processed, 1);
  const final = await CompOffRequest.findById(created.id).lean();
  assert.equal(final.status, 'assessed');
  assert.equal(final.creditedDays, 1);
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-assessed').length, 1, 'exactly one credit email after recovery');
});

test('assess-undo past expiry is rejected; finalize still credits exactly once', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });
  await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', {});
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { undoExpiresAt: new Date(Date.now() - 1000) } });

  await assert.rejects(
    undoCompOffAssessment(created.id, manager, MANAGER_PERMS),
    (err) => err.statusCode === 410,
  );
  const staged = await CompOffRequest.findById(created.id).lean();
  await runCompOffSweep(new Date(new Date(staged.notifyAfter).getTime() + 1000));
  const final = await CompOffRequest.findById(created.id).lean();
  assert.equal(final.status, 'assessed');
  assert.equal(final.creditedDays, 1);
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-assessed').length, 1);
});

test('double assess stages once; the loser gets 409', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });

  const results = await Promise.allSettled([
    assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', {}),
    assessCompOffWork(created.id, manager, MANAGER_PERMS, 'half', {}),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.statusCode, 409);
});

test('cross-year request credits the worked-year CO balance', async () => {
  const { manager, employee } = await createCompOffFixture();
  const todayKey = getISTDateInputValue();
  const thisYear = Number(todayKey.slice(0, 4));
  // Next Dec 31 that is still in the future, paired with the Jan 1 after it.
  let decYear = thisYear;
  if (`${decYear}-12-31` <= todayKey) decYear += 1;
  const dec31Key = `${decYear}-12-31`;
  const jan1Key = `${decYear + 1}-01-01`;
  const { Holiday } = await import('../models/Holiday.js');
  await Holiday.create({ date: parseDateInputAsISTDay(dec31Key), name: 'Year-end holiday', isActive: true });
  await Holiday.create({ date: parseDateInputAsISTDay(jan1Key), name: 'New Year holiday', isActive: true });
  await seedLeaveTypesAndPolicies({ years: [decYear] });

  const created = await createCompOffRequest(employee._id, {
    startDate: dec31Key,
    endDate: jan1Key,
    reason: 'Year-end release cover',
  });
  assert.equal(created.days, 2);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne({ _id: created.id }, { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } });
  await assessCompOffWork(created.id, manager, MANAGER_PERMS, 'completed', {});
  await runCompOffSweep(FUTURE);

  const coType = await LeaveType.findOne({ code: 'CO' });
  const balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id, year: decYear }).lean();
  assert.ok(balance, 'CO balance exists for the worked year');
  assert.equal(balance.compOffEarned, 2, 'both days credited to the worked year');
});

test('eligible days endpoint math rejects ineligible ranges even when weekends overlap', async () => {
  const { employee, satKey } = await createCompOffFixture();
  // Sat + following Monday range is rejected (Monday is a working day).
  const mondayKey = (() => {
    let day = parseDateInputAsISTDay(satKey);
    for (let i = 0; i < 5; i += 1) {
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
      const dow = day.getUTCDay();
      if (dow === 1) return getISTDateInputValue(day);
    }
    throw new Error('no monday');
  })();
  await assert.rejects(
    submitCompOff(employee, satKey, mondayKey, 'Sat-Mon range'),
    (err) => err.statusCode === 400 && /weekends and holidays/.test(err.message),
  );
});

function mockLoginRes() {
  const res = { statusCode: 200, cookies: {}, body: null, redirectUrl: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (body) => { res.body = body; return res; };
  res.redirect = (code, url) => { res.statusCode = code; res.redirectUrl = url; return res; };
  res.cookie = (name, value) => { res.cookies[name] = value; return res; };
  res.clearCookie = () => res;
  return res;
}

function extractTakeActionToken(html) {
  const match = String(html).match(/\/api\/leave\/comp-off\/decision-login\?request=([a-f0-9]+)&action=decide&token=([a-f0-9]+)/);
  assert.ok(match, 'Take Action auto-login URL present in email');
  return { requestId: match[1], token: match[2] };
}

test('manager email carries a Take Action auto-login link with a single-use token', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);

  const mails = testEmailOutbox.filter((m) => m.tag === 'comp-off-manager');
  assert.equal(mails.length, 1);
  assert.ok(mails[0].html.includes('Take Action'), 'Take Action button rendered');
  const { requestId, token } = extractTakeActionToken(mails[0].html);
  assert.equal(requestId, created.id);

  // Token lifecycle: peek works without consuming, consume is single-use.
  const peeked = await peekCompOffDecisionToken(created.id, 'decide', token);
  assert.ok(peeked, 'peek finds the live token');
  assert.equal(String(peeked.managerId), String(manager._id));
  const consumedBy = await consumeCompOffDecisionToken(created.id, 'decide', token);
  assert.equal(String(consumedBy), String(manager._id));
  assert.equal(await consumeCompOffDecisionToken(created.id, 'decide', token), null, 'replay rejected');
  assert.equal(await peekCompOffDecisionToken(created.id, 'decide', token), null, 'used token invisible');

  // Manager SMS carries the same Take Action link.
  const sms = testSmsOutbox.find((s) => s.message.includes('Take action:'));
  assert.ok(sms, 'manager SMS includes the Take Action link');
  assert.ok(sms.message.includes(token));
});

test('decision-login auto-logs-in, redirects to the comp-off queue, stays reusable until decided', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  const raw = await issueCompOffDecisionToken(created.id, manager._id, 'decide');

  const first = mockLoginRes();
  await compOffDecisionLoginHandler(
    { query: { request: String(created.id), action: 'decide', token: raw } },
    first,
  );
  assert.equal(first.statusCode, 302);
  assert.ok(
    first.redirectUrl.includes(`/admin/leave/comp-off?decision=request&requestId=${created.id}`),
    first.redirectUrl,
  );
  assert.ok(first.cookies.attendance_token, 'auth cookie issued');
  assert.ok(first.cookies.attendance_csrf, 'csrf cookie issued');

  // Login peeks only: the same link works again (mirrors the leave flow).
  const second = mockLoginRes();
  await compOffDecisionLoginHandler(
    { query: { request: String(created.id), action: 'decide', token: raw } },
    second,
  );
  assert.equal(second.statusCode, 302);

  // Deciding clears tokens: the link dies with a 410 afterwards.
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  const dead = mockLoginRes();
  await compOffDecisionLoginHandler(
    { query: { request: String(created.id), action: 'decide', token: raw } },
    dead,
  );
  assert.equal(dead.statusCode, 410);
});

test('expired Take Action tokens are rejected by peek and login', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  const raw = await issueCompOffDecisionToken(created.id, manager._id, 'decide');
  assert.ok(await peekCompOffDecisionToken(created.id, 'decide', raw));

  // Force expiry: the link dies with a 410 like the leave flow.
  await CompOffRequest.updateOne(
    { _id: created.id, 'decisionTokens.tokenHash': { $exists: true } },
    { $set: { 'decisionTokens.$[].expiresAt': new Date(Date.now() - 1000) } },
  );
  assert.equal(await peekCompOffDecisionToken(created.id, 'decide', raw), null, 'expired token invisible');

  const dead = mockLoginRes();
  await compOffDecisionLoginHandler(
    { query: { request: String(created.id), action: 'decide', token: raw } },
    dead,
  );
  assert.equal(dead.statusCode, 410);
});

test('withdraw → undo-withdraw restores a live request with a fresh notify window', async () => {
  const { employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);

  const staged = await undoCompOffSubmit(created.id, employee);
  assert.equal(staged.status, 'pending');
  assert.equal(staged.pendingAction, 'cancelled');

  const restored = await undoCompOffWithdraw(created.id, employee);
  assert.equal(restored.status, 'pending');
  assert.equal(restored.pendingAction, null);
  assert.ok(restored.decisionUndoExpiresAt, 'undo-withdraw restarts the notify window');
  assert.equal(await countNotifications(), 0, 'undoing a withdrawal is silent');

  // The restored request still notifies the manager after its fresh window.
  const live = await CompOffRequest.findById(created.id).lean();
  await runCompOffSweep(new Date(new Date(live.notifyAfter).getTime() + 1000));
  assert.equal(await countNotifications('comp_off_pending'), 1);
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-manager').length, 1);
});

test('resubmit is blocked while a withdrawal is staged, allowed after it finalizes', async () => {
  const { employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await undoCompOffSubmit(created.id, employee);

  await assert.rejects(
    submitCompOff(employee, satKey, null, 'Duplicate while withdrawing'),
    (err) => err.statusCode === 409,
  );

  await runCompOffSweep(FUTURE);
  assert.equal((await CompOffRequest.findById(created.id).lean()).status, 'cancelled');
  assert.equal(testEmailOutbox.length, 0, 'withdrawal finalize is silent');

  const second = await submitCompOff(employee, satKey, null, 'After withdrawal finalized');
  assert.equal(second.status, 'pending');
});

test('double withdraw and manager decide during staged withdraw both lose with 409', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await undoCompOffSubmit(created.id, employee);

  await assert.rejects(
    undoCompOffSubmit(created.id, employee),
    (err) => err.statusCode === 409,
  );
  await assert.rejects(
    decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {}),
    (err) => err.statusCode === 409,
  );
  // The staged withdrawal itself is untouched by the losers.
  const live = await CompOffRequest.findById(created.id).lean();
  assert.equal(live.pendingAction, 'cancelled');
});

test('withdraw after the manager was notified stays rejected', async () => {
  const { employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await runCompOffSweep(FUTURE);
  assert.equal(await countNotifications('comp_off_pending'), 1);

  await assert.rejects(
    undoCompOffSubmit(created.id, employee),
    (err) => err.statusCode === 409,
  );
});

test('undo-withdraw past expiry is rejected; non-owner gets 403', async () => {
  const { manager, employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await undoCompOffSubmit(created.id, employee);

  const other = await createUser('Stranger');
  await assert.rejects(
    undoCompOffWithdraw(created.id, other),
    (err) => err.statusCode === 403,
  );

  await CompOffRequest.updateOne({ _id: created.id }, { $set: { undoExpiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(
    undoCompOffWithdraw(created.id, employee),
    (err) => err.statusCode === 410,
  );

  // Finalize still cancels silently afterwards.
  const staged = await CompOffRequest.findById(created.id).lean();
  await runCompOffSweep(new Date(new Date(staged.notifyAfter).getTime() + 1000));
  assert.equal((await CompOffRequest.findById(created.id).lean()).status, 'cancelled');
  assert.equal(testEmailOutbox.length, 0);
});

test('withdraw before finalize kills Take Action links issued at submit finalize', async () => {
  // Tokens are only issued at submit finalize, after which withdraw is
  // rejected — so this drives the reverse order: withdraw first (no tokens
  // can exist yet), then prove no link can ever be minted for it.
  const { employee, satKey } = await createCompOffFixture();
  const created = await submitCompOff(employee, satKey);
  await undoCompOffSubmit(created.id, employee);

  const dead = mockLoginRes();
  await compOffDecisionLoginHandler(
    { query: { request: String(created.id), action: 'decide', token: '0'.repeat(64) } },
    dead,
  );
  assert.equal(dead.statusCode, 410);
});

async function driveToWorked(manager, employee, satKey, sunKey) {
  const created = await submitCompOff(employee, satKey, sunKey);
  await runCompOffSweep(FUTURE);
  await decideCompOffRequest(created.id, manager, MANAGER_PERMS, 'approve', {});
  await runCompOffSweep(FUTURE);
  await CompOffRequest.updateOne(
    { _id: created.id },
    { $set: { status: 'worked', checkoutRecordId: new mongoose.Types.ObjectId() } },
  );
  return created;
}

test('per-day assessment credits each day at its own rate with a stored breakdown', async () => {
  const { manager, employee, satKey, sunKey } = await createCompOffFixture();
  const created = await driveToWorked(manager, employee, satKey, sunKey);

  const staged = await assessCompOffWork(created.id, manager, MANAGER_PERMS, null, {
    comment: 'Saturday full, Sunday half.',
    assessments: [
      { date: satKey, assessment: 'completed' },
      { date: sunKey, assessment: 'half' },
    ],
  });
  assert.equal(staged.pendingAction, 'assessed');
  assert.deepEqual(staged.pendingDayAssessments, [
    { dayKey: satKey, assessment: 'completed' },
    { dayKey: sunKey, assessment: 'half' },
  ]);
  assert.equal(await countNotifications('comp_off_assessed'), 0, 'no credit before finalize');

  await runCompOffSweep(FUTURE);
  const final = await CompOffRequest.findById(created.id).lean();
  assert.equal(final.status, 'assessed');
  assert.equal(final.creditedDays, 1.5);
  assert.deepEqual(
    final.assessmentBreakdown.map((entry) => [entry.dayKey, entry.assessment, entry.credit]),
    [[satKey, 'completed', 1], [sunKey, 'half', 0.5]],
  );
  assert.deepEqual(final.pendingDayAssessments, [], 'staged array cleared on finalize');

  const coType = await LeaveType.findOne({ code: 'CO' });
  const balance = await LeaveBalance.findOne({ userId: employee._id, leaveTypeId: coType._id });
  assert.equal(balance.compOffEarned, 1.5);

  const creditEmail = testEmailOutbox.filter((m) => m.tag === 'comp-off-assessed');
  assert.equal(creditEmail.length, 1);
  assert.ok(creditEmail[0].text.includes('+1.5 day(s)'));
  assert.ok(creditEmail[0].text.includes(satKey), 'email lists the per-day breakdown');
  assert.ok(creditEmail[0].text.includes(sunKey));
  assert.ok(creditEmail[0].html.includes(satKey));
});

test('per-day assessment rejects missing, out-of-range, duplicate, and invalid entries', async () => {
  const { manager, employee, satKey, sunKey } = await createCompOffFixture();
  const created = await driveToWorked(manager, employee, satKey, sunKey);

  await assert.rejects(
    assessCompOffWork(created.id, manager, MANAGER_PERMS, null, {
      comment: 'Missing Sunday.',
      assessments: [{ date: satKey, assessment: 'completed' }],
    }),
    /missing for worked day/,
  );
  await assert.rejects(
    assessCompOffWork(created.id, manager, MANAGER_PERMS, null, {
      comment: 'Out of range.',
      assessments: [
        { date: satKey, assessment: 'completed' },
        { date: '2026-09-14', assessment: 'none' },
      ],
    }),
    /outside this request's worked days/,
  );
  await assert.rejects(
    assessCompOffWork(created.id, manager, MANAGER_PERMS, null, {
      comment: 'Duplicate.',
      assessments: [
        { date: satKey, assessment: 'completed' },
        { date: satKey, assessment: 'half' },
        { date: sunKey, assessment: 'none' },
      ],
    }),
    /Duplicate assessment/,
  );
  await assert.rejects(
    assessCompOffWork(created.id, manager, MANAGER_PERMS, 'bogus', { comment: 'Bad rate.' }),
    /Invalid comp off assessment/,
  );
  // Nothing staged by the failed attempts (the 2 mails below are the
  // legitimate submit + decision notifications from the fixture setup).
  const live = await CompOffRequest.findById(created.id).lean();
  assert.equal(live.pendingAction, null);
  assert.equal(testEmailOutbox.length, 2);
});

test('undoing a per-day assessment clears the staged array with no credit', async () => {
  const { manager, employee, satKey, sunKey } = await createCompOffFixture();
  const created = await driveToWorked(manager, employee, satKey, sunKey);

  await assessCompOffWork(created.id, manager, MANAGER_PERMS, null, {
    comment: 'Taking it back.',
    assessments: [
      { date: satKey, assessment: 'completed' },
      { date: sunKey, assessment: 'completed' },
    ],
  });
  const undone = await undoCompOffAssessment(created.id, manager, MANAGER_PERMS);
  assert.equal(undone.status, 'worked');
  assert.equal(undone.pendingAction, null);
  assert.deepEqual(undone.pendingDayAssessments, []);

  await runCompOffSweep(FUTURE);
  const final = await CompOffRequest.findById(created.id).lean();
  assert.equal(final.status, 'worked', 'undone assessment never finalizes');
  assert.equal(testEmailOutbox.filter((m) => m.tag === 'comp-off-assessed').length, 0);
});
