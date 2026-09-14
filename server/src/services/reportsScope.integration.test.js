/**
 * Dashboard KPI scope (integration, real Mongo).
 *
 * getAdminReportsSummary(actor, permissions):
 * - READ_ALL (admin/HR) → org-wide counts, exactly as before.
 * - team-only (RM) → counts confined to direct reports (+ delegate chain).
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { HelpTicket } from '../models/HelpTicket.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { getAdminReportsSummary } from './reportsService.js';

let memoryServer;
let sequence = 0;

const RM_PERMS = [PERMISSIONS.USERS_READ, PERMISSIONS.LEAVE_READ, PERMISSIONS.ATTENDANCE_READ_TEAM];
const ADMIN_PERMS = [PERMISSIONS.USERS_READ, PERMISSIONS.LEAVE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_ALL];

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    AttendanceRecord.deleteMany({}),
    HelpTicket.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LeaveType.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser(name, { reportingManagerId = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `7${String(300000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    reportingManagerId,
    isActive: true,
  });
}

test('RM sees only direct-report counts, admin sees the org', async () => {
  const manager = await createUser('ScopeMgr');
  const report = await createUser('ScopeRep', { reportingManagerId: manager._id });
  await createUser('ScopeOut');

  const rmSummary = await getAdminReportsSummary(manager, RM_PERMS);
  assert.equal(rmSummary.activeEmployees, 1, 'RM counts only their report');
  assert.equal(rmSummary.presentToday, 0);
  assert.equal(rmSummary.pendingLeaveRequests, 0);

  const adminSummary = await getAdminReportsSummary(manager, ADMIN_PERMS);
  assert.equal(adminSummary.activeEmployees, 3, 'admin counts the whole org');
});

test('RM present-today excludes outsiders checked in today', async () => {
  const manager = await createUser('PresMgr');
  const report = await createUser('PresRep', { reportingManagerId: manager._id });
  const outsider = await createUser('PresOut');
  const now = new Date();
  const geo = {
    latitude: 1, longitude: 1, accuracyMeters: 5, distanceMeters: 5,
    officeLatitude: 1, officeLongitude: 1, radiusMeters: 100,
  };
  await AttendanceRecord.create([
    { userId: report._id, type: 'check_in', status: 'allowed', timestamp: now, ...geo },
    { userId: outsider._id, type: 'check_in', status: 'allowed', timestamp: now, ...geo },
  ]);

  const rmSummary = await getAdminReportsSummary(manager, RM_PERMS);
  assert.equal(rmSummary.presentToday, 1, 'only the report counts as present');
  assert.equal(rmSummary.absentToday, 0, 'no phantom absents in scoped view');

  const adminSummary = await getAdminReportsSummary(manager, ADMIN_PERMS);
  assert.equal(adminSummary.presentToday, 2, 'admin sees both check-ins');
});
