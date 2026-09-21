/**
 * Team Attendance Today visibility matrix (integration, real Mongo).
 *
 * Product rule under test:
 * - plain employees see peers under the same RM plus the RM itself, never
 *   themselves (and nobody when they have no manager);
 * - RMs see own reports (+delegate chain), fellow RMs org-wide, and the
 *   upline management chain, never themselves;
 * - company-wide viewers (admin) see everyone.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';

const ADMIN_PERMS = [
  PERMISSIONS.ATTENDANCE_READ_ALL,
  PERMISSIONS.ATTENDANCE_READ_TEAM,
  PERMISSIONS.USERS_READ,
];
import { buildDefaultRolePermissions } from '../../../shared/permissionCatalog.js';
import '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { getTeamTodayStatusService } from './attendanceService.js';

const EMP_PERMS = [];
const RM_PERMS = [PERMISSIONS.ATTENDANCE_READ_TEAM];


let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([Role.deleteMany({}), User.deleteMany({})]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createUser(name, fields = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Vis',
    name: `${name} Vis`,
    email: `${name.toLowerCase().replace(/\s+/g, '-')}.${sequence}@test.example`,
    mobile: `6${String(330000000 + sequence)}`,
    passwordHash: 'hash',
    role: 'employee',
    isActive: true,
    ...fields,
  });
}

async function setupOrg() {
  const empRole = await Role.create({ name: 'employee', slug: `emp-${sequence}`, permissions: [] });
  const rmRole = await Role.create({ name: 'RM', slug: 'reporting-manager', permissions: RM_PERMS });
  //   bossRm
  //   ├── midRm ── alice, bob(emp), self-check below
  //   └── peerRm
  //   loner (no manager)
  const bossRm = await createUser('BossRm', { roleId: rmRole._id });
  const midRm = await createUser('MidRm', { roleId: rmRole._id, reportingManagerId: bossRm._id });
  const peerRm = await createUser('PeerRm', { roleId: rmRole._id, reportingManagerId: bossRm._id });
  const alice = await createUser('Alice', { roleId: empRole._id, reportingManagerId: midRm._id });
  const bob = await createUser('Bob', { roleId: empRole._id, reportingManagerId: midRm._id });
  const loner = await createUser('Loner', { roleId: empRole._id });
  return { empRole, rmRole, bossRm, midRm, peerRm, alice, bob, loner };
}

const idsOf = (rows) => rows.map((m) => String(m.userId));

test('employee sees peers plus own RM, never themself', async () => {
  const { alice, bob, midRm, peerRm, bossRm, loner } = await setupOrg();
  const rows = await getTeamTodayStatusService(alice, EMP_PERMS);
  const seen = new Set(idsOf(rows));
  assert.ok(seen.has(String(bob._id)), 'peer under same RM visible');
  assert.ok(seen.has(String(midRm._id)), 'own RM visible');
  assert.ok(!seen.has(String(alice._id)), 'self never listed');
  assert.ok(!seen.has(String(peerRm._id)), 'unrelated RM hidden');
  assert.ok(!seen.has(String(bossRm._id)), 'upline above own RM hidden from employees');
  assert.ok(!seen.has(String(loner._id)), 'stranger hidden');
});

test('employee without a manager sees nobody (and never themself)', async () => {
  const { loner } = await setupOrg();
  const rows = await getTeamTodayStatusService(loner, EMP_PERMS);
  assert.deepEqual(idsOf(rows), [], 'managerless employee gets an empty roster');
});

test('RM sees reports, fellow RMs and upline — never self', async () => {
  const { midRm, bossRm, peerRm, alice, bob, loner } = await setupOrg();
  const rows = await getTeamTodayStatusService(midRm, RM_PERMS);
  const seen = new Set(idsOf(rows));
  for (const u of [alice, bob, peerRm, bossRm]) {
    assert.ok(seen.has(String(u._id)), `visible: ${u.name}`);
  }
  assert.ok(!seen.has(String(midRm._id)), 'self never listed');
  assert.ok(!seen.has(String(loner._id)), 'stranger hidden');
});

test('RM upline chain resolves more than one level', async () => {
  const { bossRm, midRm, alice } = await setupOrg();
  // midRm reports to bossRm; alice's peers resolve through midRm.
  const rows = await getTeamTodayStatusService(alice, EMP_PERMS);
  assert.ok(new Set(idsOf(rows)).has(String(midRm._id)), 'direct RM visible to employee');
  const bossRows = await getTeamTodayStatusService(
    { ...bossRm.toObject(), _id: bossRm._id, roleSlug: SYSTEM_ROLE_SLUGS.ADMIN },
    ADMIN_PERMS,
  );
  assert.ok(new Set(idsOf(bossRows)).has(String(alice._id)), 'admin still sees everyone');
});

test('employee role defaults include the team-today grant', () => {
  const defaults = buildDefaultRolePermissions();
  assert.ok(
    defaults.employee.includes('emp.team_today.r'),
    'catalog row 61 grants team attendance today to employees',
  );
});
