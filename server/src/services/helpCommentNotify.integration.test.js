/**
 * B-014 — help ticket comment bell matrix (integration, real Mongo).
 *
 * Every comment must ring all thread stakeholders exactly once, mirroring the
 * ticket-creation matrix: the ticket creator, the creator's reporting
 * manager, and every HELP_MANAGE holder — never the commenting actor.
 * - staff (admin) comment → creator + manager + fellow admins notified
 * - reporting-manager comment → creator + admins notified (no self-ping, no dupe)
 * - creator comment → manager + admins notified (unchanged behavior)
 * - repeated comments notify again (no suppression)
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
import { addHelpComment } from './helpService.js';

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

async function setupThread() {
  const adminRole = await createRole('admin', [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE]);
  const rmRole = await createRole('rm', [PERMISSIONS.HELP_MANAGE]);
  const empRole = await createRole('emp', [PERMISSIONS.HELP_WRITE]);

  const admin1 = await createUser('AdminOne', { roleId: adminRole._id });
  const admin2 = await createUser('AdminTwo', { roleId: adminRole._id });
  const manager = await createUser('Manager', { roleId: rmRole._id });
  const employee = await createUser('Employee', {
    roleId: empRole._id,
    reportingManagerId: manager._id,
  });

  const ticket = await HelpTicket.create({
    title: 'Cannot check in',
    category: 'Attendance',
    description: 'Mobile app shows outside geofence even at office.',
    createdBy: employee._id,
  });

  return { admin1, admin2, manager, employee, ticket };
}

async function countFor(userId) {
  return Notification.countDocuments({ userId, type: 'help.comment' });
}

test('admin comment notifies creator, reporting manager, and fellow admins (not self)', async () => {
  const { admin1, admin2, manager, employee, ticket } = await setupThread();

  await addHelpComment(
    ticket._id.toString(),
    admin1,
    [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE],
    { body: 'Looking into this.' },
  );

  assert.equal(await countFor(employee._id), 1, 'creator notified');
  assert.equal(await countFor(manager._id), 1, 'reporting manager notified');
  assert.equal(await countFor(admin2._id), 1, 'fellow admin notified');
  assert.equal(await countFor(admin1._id), 0, 'actor never self-notified');
});

test('reporting-manager comment notifies creator and admins once each (no dupe via HELP_MANAGE)', async () => {
  const { admin1, admin2, manager, employee, ticket } = await setupThread();

  await addHelpComment(
    ticket._id.toString(),
    manager,
    [PERMISSIONS.HELP_MANAGE],
    { body: 'Please share your GPS reading.' },
  );

  assert.equal(await countFor(employee._id), 1, 'creator notified');
  assert.equal(await countFor(admin1._id), 1, 'admin notified');
  assert.equal(await countFor(admin2._id), 1, 'second admin notified');
  assert.equal(await countFor(manager._id), 0, 'manager never self-notified');
});

test('creator comment notifies manager and admins (unchanged behavior)', async () => {
  const { admin1, admin2, manager, employee, ticket } = await setupThread();

  await addHelpComment(
    ticket._id.toString(),
    employee,
    [PERMISSIONS.HELP_WRITE],
    { body: 'Accuracy is about 25 meters.' },
  );

  assert.equal(await countFor(manager._id), 1, 'reporting manager notified');
  assert.equal(await countFor(admin1._id), 1, 'admin notified');
  assert.equal(await countFor(admin2._id), 1, 'second admin notified');
  assert.equal(await countFor(employee._id), 0, 'creator never self-notified');
});

test('repeated comments notify again (no suppression)', async () => {
  const { admin1, employee, ticket } = await setupThread();

  await addHelpComment(
    ticket._id.toString(),
    admin1,
    [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE],
    { body: 'First reply.' },
  );
  await addHelpComment(
    ticket._id.toString(),
    admin1,
    [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE],
    { body: 'Second reply.' },
  );

  assert.equal(await countFor(employee._id), 2, 'creator notified on every comment');
});
