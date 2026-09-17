/**
 * Help-ticket audit rows must carry the actor's request context (ip, device,
 * user-agent) so the Audit Logs page never shows blank DEVICE/IP columns.
 * Regression: the service used to call auditLog without any request context.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { AuditLog } from '../models/AuditLog.js';
import { HelpTicket } from '../models/HelpTicket.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { flushAuditLogs } from '../utils/auditLog.js';
import { updateHelpTicketStatus } from './helpService.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
    AuditLog.deleteMany({}),
    HelpTicket.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

test('status-update audit row records ip, deviceId, and userAgent', async () => {
  sequence += 1;
  const role = await Role.create({
    name: `admin-${sequence}`,
    slug: `admin-${sequence}`,
    permissions: [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE],
  });
  const admin = await User.create({
    firstName: 'Admin',
    lastName: 'Test',
    name: 'Admin Test',
    email: `admin.${sequence}@test.example`,
    mobile: `9${String(100000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'admin',
    roleId: role._id,
    isActive: true,
  });
  const ticket = await HelpTicket.create({
    title: 'Cannot check in',
    category: 'Attendance',
    description: 'Geofence issue.',
    status: 'open',
    createdBy: admin._id,
  });

  await updateHelpTicketStatus(
    ticket._id.toString(),
    admin,
    [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE],
    { status: 'in_progress' },
    { ip: '1.2.3.4', deviceId: 'device-abc', userAgent: 'test-agent' },
  );
  await flushAuditLogs();

  const row = await AuditLog.findOne({ action: 'help_ticket_status_updated' }).lean();
  assert.ok(row, 'audit row must persist');
  assert.equal(row.status, 'success');
  assert.equal(row.ip, '1.2.3.4');
  assert.equal(row.deviceId, 'device-abc');
  assert.equal(row.userAgent, 'test-agent');
  assert.equal(row.metadata.status, 'in_progress');
  assert.equal(row.metadata.previousStatus, 'open');
});
