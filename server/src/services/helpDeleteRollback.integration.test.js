/**
 * #15 — help upload rollback (integration, real Mongo).
 *
 * The employee client deletes the just-created ticket when every attachment
 * upload fails. The DELETE route admits HELP_WRITE, so the service must let
 * the creator roll back their own still-open ticket even without HELP_MANAGE:
 * - creator deletes own OPEN ticket (no HELP_MANAGE) → gone, no orphans
 * - creator cannot delete own NON-OPEN ticket → 403 (staff-owned work)
 * - reporting manager can still delete team ticket → unchanged behavior
 * - stranger employee cannot delete → 403
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import '../models/Department.js';
import { HelpAttachment } from '../models/HelpAttachment.js';
import { HelpComment } from '../models/HelpComment.js';
import { HelpTicket } from '../models/HelpTicket.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { deleteHelpTicket } from './helpService.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
    HelpAttachment.deleteMany({}),
    HelpComment.deleteMany({}),
    HelpTicket.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createRole(slug, permissions) {
  sequence += 1;
  return Role.create({ name: slug, slug: `${slug}-${sequence}`, permissions });
}

async function createUser(name, { roleId = null, reportingManagerId = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `8${String(100000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId,
    reportingManagerId,
  });
}

async function setup() {
  const adminRole = await createRole('admin', [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE]);
  const rmRole = await createRole('rm', [PERMISSIONS.HELP_MANAGE]);
  const empRole = await createRole('emp', [PERMISSIONS.HELP_WRITE]);

  const manager = await createUser('Manager', { roleId: rmRole._id });
  const employee = await createUser('Employee', {
    roleId: empRole._id,
    reportingManagerId: manager._id,
  });
  const stranger = await createUser('Stranger', { roleId: empRole._id });
  return { adminRole, manager, employee, stranger };
}

async function createTicket(employee, status = 'open') {
  const ticket = await HelpTicket.create({
    title: 'Upload failed ticket',
    category: 'Other',
    description: 'Attachment upload failed so this must roll back.',
    createdBy: employee._id,
  });
  if (status !== 'open') {
    ticket.status = status;
    await ticket.save();
  }
  return ticket;
}

test('creator without HELP_MANAGE deletes own open ticket (rollback works)', async () => {
  const { employee } = await setup();
  const ticket = await createTicket(employee, 'open');
  await HelpComment.create({ ticketId: ticket._id, userId: employee._id, body: 'note' });

  await deleteHelpTicket(ticket._id.toString(), employee, [PERMISSIONS.HELP_WRITE]);

  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 0, 'ticket gone');
  assert.equal(await HelpComment.countDocuments({ ticketId: ticket._id }), 0, 'no orphan comments');
  assert.equal(await HelpAttachment.countDocuments({ ticketId: ticket._id }), 0, 'no orphan attachments');
});

test('creator cannot delete own non-open ticket', async () => {
  const { employee } = await setup();
  const ticket = await createTicket(employee, 'in_progress');

  await assert.rejects(
    deleteHelpTicket(ticket._id.toString(), employee, [PERMISSIONS.HELP_WRITE]),
    (err) => err.statusCode === 403,
    'expected 403 for non-open creator delete',
  );
  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 1, 'ticket preserved');
});

test('reporting manager delete path still works', async () => {
  const { manager, employee } = await setup();
  const ticket = await createTicket(employee, 'open');

  await deleteHelpTicket(ticket._id.toString(), manager, [PERMISSIONS.HELP_MANAGE]);

  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 0, 'manager delete works');
});

test('unrelated employee cannot delete', async () => {
  const { employee, stranger } = await setup();
  const ticket = await createTicket(employee, 'open');

  await assert.rejects(
    deleteHelpTicket(ticket._id.toString(), stranger, [PERMISSIONS.HELP_WRITE]),
    (err) => err.statusCode === 403,
    'expected 403 for stranger delete',
  );
  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 1, 'ticket preserved');
});
