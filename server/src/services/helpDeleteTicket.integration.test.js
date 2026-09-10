/**
 * Help upload rollback (#15) — creator may delete their own still-open
 * ticket (the EmployeeHelp failed-upload rollback path calls DELETE with
 * only HELP_WRITE). Non-open tickets stay staff-protected; strangers stay
 * forbidden; staff delete is unchanged.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import '../models/Department.js';
import { HelpComment } from '../models/HelpComment.js';
import { HelpTicket } from '../models/HelpTicket.js';
import { Notification } from '../models/Notification.js';
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
    HelpComment.deleteMany({}),
    HelpTicket.deleteMany({}),
    Notification.deleteMany({}),
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
    mobile: `9${String(100000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    roleId,
    reportingManagerId,
  });
}

async function setup() {
  const adminRole = await createRole('admin', [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE]);
  const empRole = await createRole('emp', [PERMISSIONS.HELP_WRITE]);
  const admin = await createUser('Admin', { roleId: adminRole._id });
  const employee = await createUser('Employee', { roleId: empRole._id });
  const stranger = await createUser('Stranger', { roleId: empRole._id });
  return { admin, employee, stranger };
}

async function createTicket(createdBy, status = 'open') {
  const ticket = await HelpTicket.create({
    title: 'Cannot check in',
    category: 'Attendance',
    description: 'Mobile app shows outside geofence even at office.',
    status,
    createdBy,
  });
  return ticket;
}

const EMP_PERMS = [PERMISSIONS.HELP_WRITE];
const ADMIN_PERMS = [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE];

test('creator with only HELP_WRITE can delete own open ticket (upload rollback)', async () => {
  const { employee } = await setup();
  const ticket = await createTicket(employee._id);
  await HelpComment.create({ ticketId: ticket._id, userId: employee._id, body: 'note' });

  await deleteHelpTicket(ticket._id.toString(), employee, EMP_PERMS);

  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 0, 'ticket removed');
  assert.equal(await HelpComment.countDocuments({ ticketId: ticket._id }), 0, 'comments cascade');
});

test('creator cannot delete own non-open ticket', async () => {
  const { employee } = await setup();
  const ticket = await createTicket(employee._id, 'in_progress');

  await assert.rejects(
    deleteHelpTicket(ticket._id.toString(), employee, EMP_PERMS),
    (err) => err.statusCode === 403,
    'in-progress ticket protected from creator delete',
  );
  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 1, 'ticket preserved');
});

test('non-creator employee cannot delete another open ticket', async () => {
  const { employee, stranger } = await setup();
  const ticket = await createTicket(employee._id);

  await assert.rejects(
    deleteHelpTicket(ticket._id.toString(), stranger, EMP_PERMS),
    (err) => err.statusCode === 403,
    'stranger forbidden',
  );
  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 1, 'ticket preserved');
});

test('staff delete of managed ticket still works', async () => {
  const { admin, employee } = await setup();
  const ticket = await createTicket(employee._id, 'in_progress');

  await deleteHelpTicket(ticket._id.toString(), admin, ADMIN_PERMS);

  assert.equal(await HelpTicket.countDocuments({ _id: ticket._id }), 0, 'staff delete works');
});
