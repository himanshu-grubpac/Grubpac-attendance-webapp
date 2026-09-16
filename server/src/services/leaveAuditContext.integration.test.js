/**
 * Audit device/network attribution for the leave lifecycle (integration).
 *
 * - Request-driven paths (submit, withdraw, decision staging) record the
 *   live actor context passed from the controller.
 * - Background paths (submit dispatch, auto-approve, decision sweep) reuse
 *   the submitter origin stored on the document — no HTTP request exists
 *   when they run.
 * - Legacy documents without stored context still finalize cleanly with
 *   device/IP absent (viewer shows "Not recorded").
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
import { AuditLog } from '../models/AuditLog.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import {
  createLeaveRequest,
  decideLeaveRequest,
  undoSubmittedLeaveRequest,
  runLeaveDecisionNotifyJob,
} from './leaveService.js';
import { flushAuditLogs } from '../utils/auditLog.js';
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
  await Promise.all([
    LeaveBalance.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveRequest.deleteMany({}),
    Notification.deleteMany({}),
    LeaveType.deleteMany({}),
    User.deleteMany({}),
    AuditLog.deleteMany({}),
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
  const manager = await createUser('CtxManager');
  const applicant = await createUser('CtxApplicant', { reportingManagerId: manager._id });
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

const managerPerms = [PERMISSIONS.LEAVE_APPROVE];

const SUBMITTER_CONTEXT = {
  ip: '10.9.9.9',
  deviceId: 'device-xyz',
  userAgent: 'test-agent/1.0',
};

const DECIDER_CONTEXT = {
  ip: '10.1.1.1',
  deviceId: 'device-boss',
  userAgent: 'ua-boss',
};

test('submit stores origin on the document and audits it', async () => {
  const { applicant, leaveType, dayKey } = await seedLeaveSetup();

  const created = await createLeaveRequest(
    applicant._id,
    submitPayload(leaveType, dayKey),
    SUBMITTER_CONTEXT,
  );
  await flushAuditLogs();

  const stored = await LeaveRequest.findById(created.id).lean();
  assert.equal(stored.submittedIp, '10.9.9.9');
  assert.equal(stored.submittedDeviceId, 'device-xyz');
  assert.equal(stored.submittedUserAgent, 'test-agent/1.0');

  const row = await AuditLog.findOne({ action: 'leave_request_created' }).lean();
  assert.ok(row);
  assert.equal(row.ip, '10.9.9.9');
  assert.equal(row.deviceId, 'device-xyz');
  assert.equal(row.userAgent, 'test-agent/1.0');
});

test('withdraw records the live actor context', async () => {
  const { applicant, leaveType, dayKey } = await seedLeaveSetup();
  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));

  await undoSubmittedLeaveRequest(created.id, applicant, {
    ip: '10.9.9.8',
    deviceId: 'device-undo',
    userAgent: 'ua-undo',
  });
  await flushAuditLogs();

  const row = await AuditLog.findOne({ action: 'leave_request_withdrawn' }).lean();
  assert.ok(row);
  assert.equal(row.ip, '10.9.9.8');
  assert.equal(row.deviceId, 'device-undo');
  assert.equal(row.userAgent, 'ua-undo');
});

test('orphaned-type staging records the decider context', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();
  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  // Delete the type: the staged rejection hits the orphaned-type path.
  await LeaveType.deleteOne({ _id: leaveType._id });

  await decideLeaveRequest(created.id, manager, managerPerms, 'rejected', { comment: 'no such type' }, DECIDER_CONTEXT);
  await flushAuditLogs();

  const row = await AuditLog.findOne({ action: 'leave_decision_orphaned_type' }).lean();
  assert.ok(row);
  assert.equal(row.ip, '10.1.1.1');
  assert.equal(row.deviceId, 'device-boss');
  assert.equal(row.userAgent, 'ua-boss');
});

test('sweep finalize reuses the stored submitter origin', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();
  const created = await createLeaveRequest(
    applicant._id,
    submitPayload(leaveType, dayKey),
    SUBMITTER_CONTEXT,
  );
  await decideLeaveRequest(created.id, manager, managerPerms, 'rejected', { comment: 'no cover' }, DECIDER_CONTEXT);
  await flushAuditLogs();

  // Staging itself audits with the decider's live context.
  const stagedRow = await AuditLog.findOne({ action: 'leave_request_rejected' }).lean();
  assert.ok(stagedRow);
  assert.equal(stagedRow.ip, '10.1.1.1');
  assert.equal(stagedRow.deviceId, 'device-boss');

  const stagedDoc = await LeaveRequest.findById(created.id).lean();
  await runLeaveDecisionNotifyJob(new Date(new Date(stagedDoc.notifyAfter).getTime() + 1000));
  await flushAuditLogs();

  const row = await AuditLog.findOne({ action: 'leave_request_finalized' }).lean();
  assert.ok(row);
  // Submitter origin — the sweep itself has no HTTP request.
  assert.equal(row.ip, '10.9.9.9');
  assert.equal(row.deviceId, 'device-xyz');
  assert.equal(row.userAgent, 'test-agent/1.0');
});

test('legacy documents without stored context finalize cleanly with absent device/ip', async () => {
  const { manager, applicant, leaveType, dayKey } = await seedLeaveSetup();
  // No audit context anywhere: mirrors pre-instrumentation rows.
  const created = await createLeaveRequest(applicant._id, submitPayload(leaveType, dayKey));
  await decideLeaveRequest(created.id, manager, managerPerms, 'rejected', { comment: 'no cover' });

  const stagedDoc = await LeaveRequest.findById(created.id).lean();
  await runLeaveDecisionNotifyJob(new Date(new Date(stagedDoc.notifyAfter).getTime() + 1000));
  await flushAuditLogs();

  const row = await AuditLog.findOne({ action: 'leave_request_finalized' }).lean();
  assert.ok(row);
  assert.equal(row.ip, undefined);
  assert.equal(row.deviceId, undefined);
});
