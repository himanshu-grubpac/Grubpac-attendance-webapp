/**
 * B-014 — help ticket comment bell matrix (integration, real Mongo).
 *
 * Scoped stakeholders only: ticket creator, company-wide help managers,
 * reporting manager, and team-scoped managers whose managed team includes
 * the creator — never every help.ticket.u holder company-wide.
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
import { Department } from '../models/Department.js';
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
    Department.deleteMany({}),
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

async function createUser(name, fields = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `9${String(100000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    isActive: true,
    ...fields,
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

async function latestLinkFor(userId, type = 'help.comment') {
  const row = await Notification.findOne({ userId, type }).sort({ createdAt: -1 }).lean();
  return row?.link ?? null;
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

test('admin who is also reporting manager gets company help ticket link (not team issues)', async () => {
  const adminRole = await createRole('admin-rm', [
    PERMISSIONS.HELP_MANAGE,
    PERMISSIONS.HELP_TICKET_R,
    PERMISSIONS.EMPLOYEES_RECORD_R,
  ]);
  const empRole = await createRole('emp-rm', [PERMISSIONS.HELP_WRITE]);
  const adminRm = await createUser('AdminRm', { roleId: adminRole._id });
  const employee = await createUser('EmpUnderAdmin', {
    roleId: empRole._id,
    reportingManagerId: adminRm._id,
  });
  const ticket = await HelpTicket.create({
    title: 'VPN down',
    category: 'Attendance',
    description: 'Cannot connect from home.',
    createdBy: employee._id,
  });

  await addHelpComment(
    ticket._id.toString(),
    employee,
    [PERMISSIONS.HELP_WRITE],
    { body: 'Still broken after reboot.' },
  );

  const link = await latestLinkFor(adminRm._id);
  assert.equal(link, `/admin/help/tickets/${ticket._id.toString()}`, 'admin RM lands on Help tickets route');
});

test('reporting manager without company record read keeps team issues link', async () => {
  const { manager, employee, ticket } = await setupThread();

  await addHelpComment(
    ticket._id.toString(),
    employee,
    [PERMISSIONS.HELP_WRITE],
    { body: 'Any update?' },
  );

  const link = await latestLinkFor(manager._id);
  assert.equal(link, `/admin/help/team/${ticket._id.toString()}`, 'RM stays on team issues route');
});

test('multi-dept RM is notified for managed-department employee without direct report link', async () => {
  const deptA = await Department.create({ name: 'Ops A', code: `OA${sequence}`, isActive: true });
  const rmRole = await createRole('rm-multi', [PERMISSIONS.HELP_MANAGE, PERMISSIONS.HELP_TICKET_R]);
  const empRole = await createRole('emp-multi', [PERMISSIONS.HELP_WRITE]);
  const rm = await createUser('MultiRm', { roleId: rmRole._id, managedDepartmentIds: [deptA._id] });
  const employee = await createUser('DeptMember', {
    roleId: empRole._id,
    departmentId: deptA._id,
  });
  const ticket = await HelpTicket.create({
    title: 'Hardware fault',
    category: 'Other',
    description: 'Laptop keyboard stops responding after sleep.',
    createdBy: employee._id,
  });

  await addHelpComment(
    ticket._id.toString(),
    employee,
    [PERMISSIONS.HELP_WRITE],
    { body: 'Still broken after reboot.' },
  );

  assert.equal(await countFor(rm._id), 1, 'multi-dept RM notified for dept member');
  const link = await latestLinkFor(rm._id);
  assert.equal(link, `/admin/help/team/${ticket._id.toString()}`, 'RM lands on team issues route');
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
