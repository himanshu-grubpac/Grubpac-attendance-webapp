process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog.js';
import { User } from '../models/User.js';
import {
  auditActionMatchers,
  auditLog,
  auditRequest,
  buildPersistPayload,
  flushAuditLogs,
  getRequestAuditContext,
  resolveAuditDisplayEmail,
  resolveAuditDisplayRole,
  resolveAuditModule,
} from './auditLog.js';

test('non-login actions default to success status with n/a reason', () => {
  const payload = buildPersistPayload('department_updated', { adminId: 'abc' });
  assert.equal(payload.status, 'success');
  assert.equal(payload.reason, 'n/a');
  assert.equal(payload.userId, 'abc');
});

test('explicit status and reason always win', () => {
  const payload = buildPersistPayload('leave_admin_exception_denied', {
    adminId: 'abc',
    status: 'failed',
    reason: 'quota_exceeded',
  });
  assert.equal(payload.status, 'failed');
  assert.equal(payload.reason, 'quota_exceeded');
});

test('failed actions without a reason are flagged unspecified', () => {
  const payload = buildPersistPayload('login_failed', { identifier: 'x@y.z' });
  assert.equal(payload.status, 'failed');
  assert.equal(payload.reason, 'unspecified');
});

test('login_success keeps success status', () => {
  const payload = buildPersistPayload('login_success', { userId: 'abc' });
  assert.equal(payload.status, 'success');
  assert.equal(payload.reason, 'n/a');
});

test('domain status values stay in metadata and never break the status enum', () => {
  const payload = buildPersistPayload('help_ticket_status_updated', {
    userId: 'abc',
    ticketId: 't1',
    previousStatus: 'open',
    status: 'in_progress',
  });
  assert.equal(payload.status, 'success');
  assert.equal(payload.metadata.status, 'in_progress');
  assert.equal(payload.metadata.previousStatus, 'open');
});

test('resolveAuditModule maps every action family to its module', () => {
  const cases = [
    ['login_success', 'authentication'],
    ['logout', 'authentication'],
    ['password_reset_requested', 'authentication'],
    ['pin_changed', 'authentication'],
    ['employee_registered', 'employees'],
    ['password_reset_by_admin', 'employees'],
    ['pin_reset_by_admin', 'employees'],
    ['department_created', 'organization'],
    ['office_settings_updated', 'organization'],
    ['role_updated', 'roles'],
    ['leave_request_approved', 'leave'],
    ['leave_policy_updated', 'leave'],
    ['holiday_deleted', 'leave'],
    ['recurring_holiday_rules_updated', 'leave'],
    ['leave_admin_exception_denied', 'leave'],
    ['comp_off_assess_staged', 'comp-off'],
    ['comp_off_lapsed', 'comp-off'],
    ['attendance_marked', 'attendance'],
    ['week_attendance_confirmed', 'attendance'],
    ['attendance_auto_checkout', 'attendance'],
    ['help_ticket_status_updated', 'helpdesk'],
    ['help_ticket_comment_deleted', 'helpdesk'],
    ['salary_updated', 'salary'],
    ['lop_record_created', 'salary'],
    ['month_settled', 'salary'],
    ['demo_faq_deleted', 'faq'],
    ['audit_logs_exported', 'audit'],
    ['something_brand_new', 'other'],
    [null, 'other'],
  ];
  for (const [action, expected] of cases) {
    assert.equal(resolveAuditModule(action), expected, action);
  }
});

test('auditActionMatchers returns the prefix list for known modules', () => {
  assert.deepEqual(auditActionMatchers('leave'), ['leave_', 'holiday_', 'recurring_']);
  assert.deepEqual(auditActionMatchers('nope'), []);
});

test('device id resolves from body first, then X-Device-Id header', () => {
  const fromBody = getRequestAuditContext({
    body: { deviceId: 'body-device' },
    headers: { 'x-device-id': 'header-device', 'user-agent': 'ua' },
    ip: '1.2.3.4',
  });
  assert.equal(fromBody.deviceId, 'body-device');

  const fromHeader = getRequestAuditContext({
    body: {},
    headers: { 'x-device-id': 'header-device', 'user-agent': 'ua' },
    ip: '1.2.3.4',
  });
  assert.equal(fromHeader.deviceId, 'header-device');
  assert.equal(fromHeader.userAgent, 'ua');
  assert.equal(fromHeader.ip, '1.2.3.4');

  assert.deepEqual(getRequestAuditContext(null), {});
  assert.deepEqual(getRequestAuditContext(undefined), {});
});

test('credential-adjacent keys never persist', () => {
  const payload = buildPersistPayload('pin_changed', {
    userId: 'abc',
    pin: '1234',
    currentPin: '0000',
    newPassword: 'Secret@123',
    generatedPassword: 'Temp@123',
    token: 'jwt',
  });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('1234'));
  assert.ok(!serialized.includes('Secret@123'));
  assert.ok(!serialized.includes('Temp@123'));
});

let memoryServer;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([AuditLog.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

test('actor email and role backfill from user id', async () => {
  const user = await User.create({
    role: 'employee',
    firstName: 'Audit',
    lastName: 'Target',
    name: 'Audit Target',
    email: 'audit.target@example.com',
    mobile: '9876543210',
    passwordHash: 'hash',
    isActive: true,
  });

  auditLog('department_updated', { adminId: user._id.toString() });
  await flushAuditLogs();

  const stored = await AuditLog.findOne({ action: 'department_updated' }).lean();
  assert.ok(stored);
  assert.equal(stored.email, 'audit.target@example.com');
  assert.equal(stored.role, 'employee');
  assert.equal(stored.status, 'success');
  assert.equal(stored.reason, 'n/a');
});

test('audit display fallbacks never leave actor fields blank', () => {
  assert.equal(resolveAuditDisplayEmail({ email: 'a@b.c' }), 'a@b.c');
  assert.equal(
    resolveAuditDisplayEmail({ metadata: { identifier: 'ghost@x.y' } }),
    'ghost@x.y',
  );
  assert.equal(resolveAuditDisplayEmail({ action: 'month_settled' }), 'System');
  assert.equal(resolveAuditDisplayEmail({ userId: 'abc' }), 'Unknown user');
  assert.equal(resolveAuditDisplayRole({ role: 'admin' }), 'admin');
  assert.equal(resolveAuditDisplayRole({ action: 'month_settled' }), 'System');
  assert.equal(resolveAuditDisplayRole({ userId: 'abc' }), 'Not recorded');
});

test('auditRequest merges request context with explicit meta winning', async () => {
  const user = await User.create({
    role: 'employee',
    firstName: 'Req',
    lastName: 'Actor',
    name: 'Req Actor',
    email: 'req.actor@example.com',
    mobile: '9876543211',
    passwordHash: 'hash',
    isActive: true,
  });
  const req = {
    user,
    ip: '10.0.0.9',
    headers: { 'user-agent': 'test-agent' },
    body: {},
  };

  auditRequest(req, 'holiday_created', { extra: 'kept' });
  await flushAuditLogs();

  const stored = await AuditLog.findOne({ action: 'holiday_created' }).lean();
  assert.ok(stored);
  assert.equal(stored.email, 'req.actor@example.com');
  assert.equal(stored.role, 'employee');
  assert.equal(stored.ip, '10.0.0.9');
  assert.equal(stored.userAgent, 'test-agent');
  assert.equal(stored.metadata?.extra, 'kept');
});
