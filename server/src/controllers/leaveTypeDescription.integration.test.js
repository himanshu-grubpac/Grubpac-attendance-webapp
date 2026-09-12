/**
 * Leave-type descriptions (integration, real Mongo).
 *
 * - Schema trims and caps descriptions at 500 chars (create defaults to '').
 * - create/update endpoints round-trip the description.
 * - listLeaveTypes (the employee apply-form source) exposes it.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  createLeaveTypeSchema,
  updateLeaveTypeSchema,
} from '../../../shared/validation/leave.js';
import { LeaveType } from '../models/LeaveType.js';
import { flushAuditLogs } from '../utils/auditLog.js';
import {
  createLeaveType,
  listLeaveTypes,
  updateLeaveType,
} from './leaveController.js';

let memoryServer;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await LeaveType.deleteMany({});
});

after(async () => {
  await flushAuditLogs();
  await mongoose.disconnect();
  await memoryServer.stop();
});

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function mockAdminReq(body = {}, params = {}) {
  return {
    body,
    params,
    user: { _id: new mongoose.Types.ObjectId() },
  };
}

test('create schema trims, caps at 500 chars, and defaults to empty', () => {
  const parsed = createLeaveTypeSchema.parse({
    code: 'cl',
    name: 'Casual Leave',
    description: '  Paid time off for personal work.  ',
  });
  assert.equal(parsed.code, 'CL');
  assert.equal(parsed.description, 'Paid time off for personal work.');

  const defaulted = createLeaveTypeSchema.parse({ code: 'SL', name: 'Sick Leave' });
  assert.equal(defaulted.description, '');

  assert.throws(() =>
    createLeaveTypeSchema.parse({ code: 'EL', name: 'Earned Leave', description: 'x'.repeat(501) }),
  );
});

test('update schema accepts a trimmed description and still requires a field', () => {
  const parsed = updateLeaveTypeSchema.parse({ description: '  Updated policy note.  ' });
  assert.equal(parsed.description, 'Updated policy note.');
  assert.throws(() => updateLeaveTypeSchema.parse({}));
  assert.throws(() => updateLeaveTypeSchema.parse({ description: 'x'.repeat(501) }));
});

test('create/update/list round-trip the description end to end', async () => {
  const createRes = mockRes();
  await createLeaveType(
    mockAdminReq({ code: 'CL', name: 'Casual Leave', description: 'Paid time off for personal work.' }),
    createRes,
  );
  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.body.type.description, 'Paid time off for personal work.');

  const stored = await LeaveType.findById(createRes.body.type.id).lean();
  assert.equal(stored.description, 'Paid time off for personal work.');

  const updateRes = mockRes();
  await updateLeaveType(
    mockAdminReq(
      { description: 'Updated: submit before payday.' },
      { id: createRes.body.type.id },
    ),
    updateRes,
  );
  assert.equal(updateRes.statusCode, 200);
  assert.equal(updateRes.body.type.description, 'Updated: submit before payday.');

  // Employee-visible list (apply form reads listTypes) exposes it.
  const listRes = mockRes();
  await listLeaveTypes(mockAdminReq(), listRes);
  assert.equal(listRes.body.types.length, 1);
  assert.equal(listRes.body.types[0].description, 'Updated: submit before payday.');
});

test('types created without a description expose an empty string', async () => {
  const createRes = mockRes();
  await createLeaveType(mockAdminReq({ code: 'SL', name: 'Sick Leave' }), createRes);
  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.body.type.description, '');
});
