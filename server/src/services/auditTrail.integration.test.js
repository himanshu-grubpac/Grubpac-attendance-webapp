process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog.js';
import { Holiday } from '../models/Holiday.js';
import { JobLock } from '../models/JobLock.js';
import { LeaveType } from '../models/LeaveType.js';
import { User } from '../models/User.js';
import { flushAuditLogs } from '../utils/auditLog.js';
import { updateHoliday, updateLeaveType } from '../controllers/leaveController.js';
import { exportAuditLogs, listAuditLogs } from '../controllers/adminController.js';
import { runAuditArchiveJob } from './auditArchiveService.js';

let memoryServer;
let sequence = 0;
let archiveDir;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
  archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-archive-test-'));
  process.env.AUDIT_ARCHIVE_DIR = archiveDir;
  // Local cold storage: never touch real S3 from tests.
  delete process.env.AUDIT_ARCHIVE_BUCKET;
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    AuditLog.deleteMany({}),
    Holiday.deleteMany({}),
    JobLock.deleteMany({}),
    LeaveType.deleteMany({}),
    User.deleteMany({}),
  ]);
  await flushAuditLogs();
});

after(async () => {
  delete process.env.AUDIT_ARCHIVE_DIR;
  await mongoose.disconnect();
  await memoryServer.stop();
});

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {}, ended: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.end = (body) => {
    res.ended = body;
    return res;
  };
  return res;
}

async function createAdmin() {
  sequence += 1;
  return User.create({
    firstName: 'Audit',
    lastName: 'Admin',
    name: 'Audit Admin',
    email: `audit.admin.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `A${String(sequence).padStart(8, '0')}`,
    passwordHash: 'test-password-hash',
    role: 'admin',
    isActive: true,
  });
}

function mockReq(user, { params = {}, body = {}, query = {} } = {}) {
  return {
    params,
    body,
    query,
    ip: '127.0.0.1',
    headers: {},
    user: { _id: user._id, email: user.email, role: user.role },
    userPermissions: [],
  };
}

test('updateLeaveType logs previous → next', async () => {
  const admin = await createAdmin();
  const type = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });

  const res = mockRes();
  await updateLeaveType(
    mockReq(admin, { params: { id: type._id.toString() }, body: { name: 'Casual Time Off' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  await flushAuditLogs();

  const entry = await AuditLog.findOne({ action: 'leave_type_updated' }).lean();
  assert.ok(entry, 'audit entry persisted');
  assert.equal(entry.metadata?.previous?.name, 'Casual Leave');
  assert.equal(entry.metadata?.next?.name, 'Casual Time Off');
  // entityId persists top-level (AuditLog schema), not inside metadata.
  assert.equal(entry.entityId?.toString(), type._id.toString());
});

test('updateHoliday logs previous → next', async () => {
  const admin = await createAdmin();
  const holiday = await Holiday.create({
    date: new Date('2026-01-26T00:00:00Z'),
    name: 'Republic Day',
    isActive: true,
  });

  const res = mockRes();
  await updateHoliday(
    mockReq(admin, { params: { id: holiday._id.toString() }, body: { name: 'Republic Day (Observed)' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  await flushAuditLogs();

  const entry = await AuditLog.findOne({ action: 'holiday_updated' }).lean();
  assert.ok(entry, 'audit entry persisted');
  assert.equal(entry.metadata?.previous?.name, 'Republic Day');
  assert.equal(entry.metadata?.next?.name, 'Republic Day (Observed)');
});

test('viewer filters by module, employee, record and date range', async () => {
  const admin = await createAdmin();
  const now = Date.now();
  const oldStamp = new Date(now - 10 * 86_400_000);
  const newStamp = new Date(now - 1 * 86_400_000);
  const requestId = new mongoose.Types.ObjectId().toString();
  await AuditLog.create([
    {
      action: 'leave_request_approved',
      userId: admin._id,
      email: 'manager@test.example',
      timestamp: newStamp,
      metadata: { requestId },
    },
    {
      action: 'attendance_marked',
      userId: admin._id,
      email: 'manager@test.example',
      timestamp: oldStamp,
      metadata: {},
    },
    {
      action: 'leave_request_rejected',
      userId: admin._id,
      email: 'other@test.example',
      timestamp: newStamp,
      metadata: { requestId: new mongoose.Types.ObjectId().toString() },
    },
  ]);

  async function query(query) {
    const res = mockRes();
    await listAuditLogs(mockReq(admin, { query }), res);
    assert.equal(res.statusCode, 200);
    return res.body;
  }

  const byModule = await query({ module: 'leave', limit: 20 });
  assert.equal(byModule.pagination.total, 2);

  const byEmployee = await query({ employee: 'manager@test.example', limit: 20 });
  assert.equal(byEmployee.pagination.total, 2);

  const byRecord = await query({ entityId: requestId, limit: 20 });
  assert.equal(byRecord.pagination.total, 1);
  assert.equal(byRecord.logs[0].recordId, requestId);
  assert.equal(byRecord.logs[0].module, 'leave');

  const dayKey = new Date(newStamp).toISOString().slice(0, 10);
  const byRange = await query({ dateFrom: dayKey, dateTo: dayKey, limit: 20 });
  assert.equal(byRange.pagination.total, 2);

  const oldDay = new Date(oldStamp).toISOString().slice(0, 10);
  const oldOnly = await query({ dateFrom: oldDay, dateTo: oldDay, limit: 20 });
  assert.equal(oldOnly.pagination.total, 1);
});

test('unified q search matches email, user id, and record id with OR semantics', async () => {
  const admin = await createAdmin();
  const now = Date.now();
  const stamp = new Date(now - 1 * 86_400_000);
  const requestId = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId().toString();
  await AuditLog.create([
    {
      action: 'leave_request_approved',
      userId: admin._id,
      email: 'manager@test.example',
      timestamp: stamp,
      metadata: { requestId },
    },
    {
      action: 'attendance_marked',
      userId,
      email: 'other@test.example',
      timestamp: stamp,
      metadata: {},
    },
    {
      action: 'leave_request_rejected',
      userId: admin._id,
      email: 'unrelated@test.example',
      timestamp: stamp,
      metadata: { ticketId: requestId },
    },
  ]);

  async function query(query) {
    const res = mockRes();
    await listAuditLogs(mockReq(admin, { query }), res);
    assert.equal(res.statusCode, 200);
    return res.body;
  }

  // Partial email.
  const byEmail = await query({ q: 'manager@test', limit: 20 });
  assert.equal(byEmail.pagination.total, 1);

  // Exact user ObjectId (no CastError, matched as user).
  const byUser = await query({ q: userId, limit: 20 });
  assert.equal(byUser.pagination.total, 1);
  assert.equal(byUser.logs[0].action, 'attendance_marked');

  // Record id shared by two rows (metadata.requestId + metadata.ticketId).
  const byRecord = await query({ q: requestId, limit: 20 });
  assert.equal(byRecord.pagination.total, 2);

  // Non-hex garbage matches nothing and never throws a CastError.
  const byGarbage = await query({ q: 'not-an-id-at-all', limit: 20 });
  assert.equal(byGarbage.pagination.total, 0);
});

test('unified q search matches action text, stored module text, and date fragments', async () => {
  const admin = await createAdmin();
  const septStamp = new Date('2026-09-17T10:00:00.000Z'); // 15:30 IST, same day
  const augStamp = new Date('2026-08-05T10:00:00.000Z');
  await AuditLog.create([
    {
      action: 'login_success',
      userId: admin._id,
      email: 'a@test.example',
      timestamp: septStamp,
      metadata: {},
    },
    {
      action: 'custom_gamma',
      userId: admin._id,
      email: 'b@test.example',
      timestamp: septStamp,
      metadata: { module: 'payroll' },
    },
    {
      action: 'attendance_marked',
      userId: admin._id,
      email: 'c@test.example',
      timestamp: augStamp,
      metadata: {},
    },
  ]);

  async function query(query) {
    const res = mockRes();
    await listAuditLogs(mockReq(admin, { query }), res);
    assert.equal(res.statusCode, 200);
    return res.body;
  }

  // Action text, case-insensitive.
  const byAction = await query({ q: 'LOGIN', limit: 20 });
  assert.equal(byAction.pagination.total, 1);
  assert.equal(byAction.logs[0].action, 'login_success');

  // Stored module text (no action contains 'payroll').
  const byModuleText = await query({ q: 'payroll', limit: 20 });
  assert.equal(byModuleText.pagination.total, 1);
  assert.equal(byModuleText.logs[0].action, 'custom_gamma');

  // Full-day fragment (IST).
  const byDay = await query({ q: '2026-09-17', limit: 20 });
  assert.equal(byDay.pagination.total, 2);

  // Month fragment.
  const byMonth = await query({ q: '2026-09', limit: 20 });
  assert.equal(byMonth.pagination.total, 2);
  const byOtherMonth = await query({ q: '2026-08', limit: 20 });
  assert.equal(byOtherMonth.pagination.total, 1);

  // Impossible dates fall through to text matching: no crash, no rows.
  const byImpossible = await query({ q: '2026-13-45', limit: 20 });
  assert.equal(byImpossible.pagination.total, 0);
});

test("module filter 'other' returns only untaxonomied actions", async () => {
  const admin = await createAdmin();
  const stamp = new Date('2026-09-17T10:00:00.000Z');
  await AuditLog.create([
    { action: 'leave_request_approved', userId: admin._id, email: 'a@test.example', timestamp: stamp, metadata: {} },
    { action: 'custom_xyz', userId: admin._id, email: 'b@test.example', timestamp: stamp, metadata: {} },
  ]);

  const res = mockRes();
  await listAuditLogs(mockReq(admin, { query: { module: 'other', limit: 20 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagination.total, 1);
  assert.equal(res.body.logs[0].action, 'custom_xyz');
  assert.equal(res.body.logs[0].module, 'other');
});

test('export honors conflictsOnly without crashing on conflict-free data', async () => {
  const admin = await createAdmin();
  const stamp = new Date('2026-09-17T10:00:00.000Z');
  await AuditLog.create({
    action: 'login_success',
    userId: admin._id,
    email: 'a@test.example',
    timestamp: stamp,
    metadata: {},
  });

  const res = mockRes();
  await exportAuditLogs(
    mockReq(admin, { query: { conflictsOnly: 'true', format: 'csv' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['Content-Type'].includes('text/csv'));
  // Header row only: the lone entry has no conflict.
  assert.equal(String(res.ended).trim().split('\n').length, 1);
});

test('archive job archives months, prunes only verified old entries', async () => {
  const now = Date.now();
  const oldStamp = new Date(now - 70 * 86_400_000);
  const midStamp = new Date(now - 40 * 86_400_000);
  const newStamp = new Date(now - 5 * 86_400_000);
  await AuditLog.create([
    { action: 'login_success', timestamp: oldStamp, metadata: {} },
    { action: 'login_success', timestamp: midStamp, metadata: {} },
    { action: 'login_success', timestamp: newStamp, metadata: {} },
  ]);

  const dry = await runAuditArchiveJob({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.prunedEntries, 0);
  assert.equal(await AuditLog.countDocuments(), 3);

  const result = await runAuditArchiveJob({ dryRun: false });
  assert.ok(result.archivedEntries >= 2, 'old + mid months archived');
  assert.ok(result.archivedMonths.length >= 2);
  for (const entry of result.archivedMonths) {
    assert.ok(entry.location, 'archive location recorded');
    assert.ok(entry.bytes > 0, 'archive object non-empty');
  }

  // >60d pruned, 40d kept, 5d kept (+ the run's own audit entry).
  assert.equal(await AuditLog.countDocuments({ timestamp: oldStamp }), 0);
  assert.equal(await AuditLog.countDocuments({ timestamp: midStamp }), 1);
  assert.equal(await AuditLog.countDocuments({ timestamp: newStamp }), 1);

  // Archive files exist locally with one JSON object per line.
  const files = await fs.readdir(archiveDir);
  assert.ok(files.some((file) => file.endsWith('.jsonl')));
  const monthKey = `${oldStamp.getUTCFullYear()}-${String(oldStamp.getUTCMonth() + 1).padStart(2, '0')}`;
  const lines = (await fs.readFile(path.join(archiveDir, `${monthKey}.jsonl`), 'utf8'))
    .trim()
    .split('\n');
  assert.ok(lines.length >= 1);
  assert.equal(JSON.parse(lines[0]).action, 'login_success');

  // Second run is stable: nothing new to archive or prune.
  const again = await runAuditArchiveJob({ dryRun: false });
  assert.equal(again.prunedEntries, 0);
});
