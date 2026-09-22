/**
 * RM help team scope — managed departments, canManageTicket, list filter,
 * and scoped notification routing (no company-wide help.ticket.u blast).
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  PERMISSIONS,
  hasCompanyHelpAccess,
  hasCompanyHelpManageAccess,
} from '../../../shared/permissions.js';
import { Department } from '../models/Department.js';
import { HelpTicket } from '../models/HelpTicket.js';
import { Notification } from '../models/Notification.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { HelpComment } from '../models/HelpComment.js';
import {
  addHelpComment,
  canManageTicket,
  createHelpTicket,
  listHelpTickets,
  updateHelpTicketStatus,
} from './helpService.js';

let memoryServer;
let sequence = 0;

const RM_PERMS = [
  PERMISSIONS.HELP_TICKET_R,
  PERMISSIONS.HELP_TICKET_U,
  PERMISSIONS.HELP_MANAGE,
];
const EMP_PERMS = [PERMISSIONS.HELP_WRITE];
const ADMIN_PERMS = [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE, PERMISSIONS.HELP_TICKET_R];

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
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

async function setupMultiDeptRm() {
  const deptA = await Department.create({ name: 'Dept A', code: `DA${sequence}`, isActive: true });
  const deptB = await Department.create({ name: 'Dept B', code: `DB${sequence}`, isActive: true });
  const deptC = await Department.create({ name: 'Dept C', code: `DC${sequence}`, isActive: true });
  const rmRole = await createRole('rm', RM_PERMS);
  const empRole = await createRole('emp', EMP_PERMS);
  const adminRole = await createRole('admin', ADMIN_PERMS);

  const rm = await createUser('MultiDeptRm', {
    roleId: rmRole._id,
    managedDepartmentIds: [deptA._id, deptB._id],
  });
  const deptAEmployee = await createUser('DeptAEmployee', {
    roleId: empRole._id,
    departmentId: deptA._id,
  });
  const deptBEmployee = await createUser('DeptBEmployee', {
    roleId: empRole._id,
    departmentId: deptB._id,
  });
  const outsider = await createUser('Outsider', {
    roleId: empRole._id,
    departmentId: deptC._id,
  });
  const admin = await createUser('Admin', { roleId: adminRole._id });
  const otherRmRole = await createRole('rm-other', RM_PERMS);
  const otherRm = await createUser('OtherRm', {
    roleId: otherRmRole._id,
    managedDepartmentIds: [],
  });

  return {
    deptA,
    deptB,
    deptC,
    rm,
    deptAEmployee,
    deptBEmployee,
    outsider,
    admin,
    otherRm,
  };
}

test('canManageTicket: multi-dept RM can manage tickets from managed departments without direct report link', async () => {
  const { rm, deptAEmployee } = await setupMultiDeptRm();
  const ticket = await HelpTicket.create({
    title: 'VPN issue',
    category: 'Login',
    description: 'Cannot connect from home office network.',
    createdBy: deptAEmployee._id,
  });
  await ticket.populate([{ path: 'createdBy', select: 'name email reportingManagerId' }]);

  assert.equal(await canManageTicket(rm, ticket, RM_PERMS), true);
});

test('canManageTicket: RM cannot manage tickets outside managed team', async () => {
  const { rm, outsider } = await setupMultiDeptRm();
  const ticket = await HelpTicket.create({
    title: 'Payroll question',
    category: 'Salary',
    description: 'Need clarification on last month deduction.',
    createdBy: outsider._id,
  });
  await ticket.populate([{ path: 'createdBy', select: 'name email reportingManagerId' }]);

  assert.equal(await canManageTicket(rm, ticket, RM_PERMS), false);
});

test('listHelpTickets team scope supports departmentId filter across two managed departments', async () => {
  const { rm, deptA, deptAEmployee, deptBEmployee } = await setupMultiDeptRm();

  await HelpTicket.create({
    title: 'Dept A ticket',
    category: 'Leave',
    description: 'Need help applying comp-off for last week.',
    createdBy: deptAEmployee._id,
  });
  await HelpTicket.create({
    title: 'Dept B ticket',
    category: 'Attendance',
    description: 'Check-in failed at the gate reader today morning.',
    createdBy: deptBEmployee._id,
  });

  const allTeam = await listHelpTickets(rm, RM_PERMS, { scope: 'team', page: 1, limit: 20 });
  assert.equal(allTeam.tickets.length, 2, 'both managed departments visible');

  const deptAOnly = await listHelpTickets(rm, RM_PERMS, {
    scope: 'team',
    page: 1,
    limit: 20,
    departmentId: deptA._id.toString(),
  });
  assert.equal(deptAOnly.tickets.length, 1, 'department filter narrows to dept A');
  assert.equal(deptAOnly.tickets[0].createdBy, deptAEmployee._id.toString());
});

test('createHelpTicket notifies company admin and in-scope RM, not every help.ticket.u holder', async () => {
  const { rm, deptAEmployee, admin, otherRm } = await setupMultiDeptRm();

  await createHelpTicket(
    deptAEmployee,
    {
      title: 'App crash',
      category: 'Other',
      description: 'Mobile app closes immediately after login attempt.',
    },
    EMP_PERMS,
  );

  const rmCount = await Notification.countDocuments({ userId: rm._id, type: 'help.new' });
  const adminCount = await Notification.countDocuments({ userId: admin._id, type: 'help.new' });
  const otherRmCount = await Notification.countDocuments({ userId: otherRm._id, type: 'help.new' });

  assert.equal(rmCount, 1, 'in-scope multi-dept RM notified');
  assert.equal(adminCount, 1, 'company admin notified');
  assert.equal(otherRmCount, 0, 'unrelated RM not blasted company-wide');
});

test('addHelpComment notifies multi-dept RM for managed-department creator comment', async () => {
  const { rm, deptAEmployee } = await setupMultiDeptRm();
  const ticket = await HelpTicket.create({
    title: 'Hardware fault',
    category: 'Other',
    description: 'Laptop keyboard stops responding after sleep.',
    createdBy: deptAEmployee._id,
  });

  await addHelpComment(
    ticket._id.toString(),
    deptAEmployee,
    EMP_PERMS,
    { body: 'Still broken after reboot.' },
  );

  const rmCount = await Notification.countDocuments({ userId: rm._id, type: 'help.comment' });
  assert.equal(rmCount, 1, 'multi-dept RM notified on creator comment');
});

test('custom role slug with company-wide help perms gets company help behavior', async () => {
  const customPerms = [
    PERMISSIONS.HELP_TICKET_R,
    PERMISSIONS.HELP_MANAGE,
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.EMPLOYEES_RECORD_U,
  ];
  assert.equal(hasCompanyHelpAccess(customPerms), true);
  assert.equal(hasCompanyHelpManageAccess(customPerms), true);

  const { outsider } = await setupMultiDeptRm();
  const customRole = await createRole('custom-ops', customPerms);
  const customUser = await createUser('CustomOps', { roleId: customRole._id });

  const outsiderTicket = await HelpTicket.create({
    title: 'Outsider ticket',
    category: 'Other',
    description: 'Outside any managed department.',
    createdBy: outsider._id,
  });
  await outsiderTicket.populate([{ path: 'createdBy', select: 'name email reportingManagerId' }]);

  assert.equal(await canManageTicket(customUser, outsiderTicket, customPerms), true);

  const allTickets = await listHelpTickets(customUser, customPerms, {
    scope: 'all',
    page: 1,
    limit: 50,
  });
  assert.ok(allTickets.tickets.length >= 1);
  assert.ok(
    allTickets.tickets.some((row) => row.id === outsiderTicket._id.toString()),
    'company-wide custom role lists all tickets',
  );
});

test('updateHelpTicketStatus: multi-dept RM can update in-scope team ticket', async () => {
  const { rm, deptBEmployee } = await setupMultiDeptRm();
  const ticket = await HelpTicket.create({
    title: 'Leave balance',
    category: 'Leave',
    description: 'Balance shows negative after approved WFH day.',
    createdBy: deptBEmployee._id,
  });

  const updated = await updateHelpTicketStatus(
    ticket._id.toString(),
    rm,
    RM_PERMS,
    { status: 'in_progress' },
  );

  assert.equal(updated.status, 'in_progress');
});
