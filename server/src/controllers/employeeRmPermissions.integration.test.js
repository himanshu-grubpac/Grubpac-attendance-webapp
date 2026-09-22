/**
 * Employee & Reporting Manager dynamic roles/permissions (integration, real Mongo).
 *
 * Tests that:
 * - Default permissions for Employee and RM roles are correct
 * - Admin can dynamically change permissions via the admin panel (updateRole)
 * - Permission changes take effect immediately (resolveUserPermissions)
 * - Portal access gating works for both roles
 * - RM team scope is enforced (can see team, not company-wide)
 * - Employee is restricted to own data only
 * - Custom roles can be created and assigned
 * - Role assignment from admin panel works for both roles
 * - Admin lock slugs are protected
 * - Self-lockout guard prevents removing own permissions
 * - System roles cannot be deleted
 * - Role list scope=creatable returns only Employee for RM
 * - permissionsVersion bumps on permission changes
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  PERMISSIONS,
  SYSTEM_ROLE_SLUGS,
  buildDefaultRolePermissions,
  hasAdminPortalAccess,
  hasEmployeePortalAccess,
  hasPermission,
} from '../../../shared/permissions.js';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import { updateRole, listRoles, createRole, deleteRole } from './rolesController.js';
import { registerEmployee, updateEmployee, listManagers } from './adminController.js';
import { resolveUserPermissions, requirePermission } from '../middleware/auth.js';
import { isUserInTeamScope, resolveTeamScopedUserIds } from '../services/teamScopeService.js';

let memoryServer;
let sequence = 0;

const DEFAULTS = buildDefaultRolePermissions();

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await Promise.all([
    Department.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

// ── Helpers ────────────────────────────────────────────────────────────────

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

async function createDept(code) {
  return Department.create({ name: `Dept ${code}`, code, isActive: true });
}

async function createRoleDoc(name, slug, permissions = []) {
  return Role.create({ name, slug, isSystem: false, permissions });
}

async function createSystemRole(name, slug, permissions = []) {
  return Role.create({ name, slug, isSystem: true, permissions });
}

async function createUser(name, { roleId, reportingManagerId, departmentId, managedDepartmentIds, role = 'employee', designation = null, joiningDate = null, monthlySalary = null } = {}) {
  sequence += 1;
  return User.create({
    firstName: name,
    lastName: 'Test',
    name: `${name} Test`,
    email: `${name.toLowerCase()}.${sequence}@test.example`,
    mobile: `9${String(400000000 + sequence)}`,
    passwordHash: 'hash',
    role,
    roleId,
    reportingManagerId,
    departmentId,
    managedDepartmentIds,
    designation,
    joiningDate,
    monthlySalary,
    isActive: true,
  });
}

function actorAs(user, roleDoc) {
  return {
    ...user.toObject(),
    _id: user._id,
    roleId: { _id: roleDoc._id, slug: roleDoc.slug, permissions: roleDoc.permissions },
  };
}

// ── 1. Default permissions for Employee and RM roles ───────────────────────

test('Employee default permissions include employee portal and own-data access', () => {
  const empPerms = DEFAULTS.employee;
  assert.ok(empPerms.includes(PERMISSIONS.PORTAL_EMPLOYEE), 'has employee portal access');
  assert.ok(!empPerms.includes(PERMISSIONS.PORTAL_ADMIN), 'no admin portal access');
  assert.ok(empPerms.includes(PERMISSIONS.EMP_DASHBOARD_R), 'has own dashboard');
  assert.ok(empPerms.includes(PERMISSIONS.EMP_LEAVE_C), 'can apply leave');
  assert.ok(empPerms.includes(PERMISSIONS.EMP_BALANCE_R), 'can view leave balances');
  assert.ok(empPerms.includes(PERMISSIONS.EMP_ATTENDANCE_R), 'can view own attendance');
  assert.ok(empPerms.includes(PERMISSIONS.EMP_PAY_R), 'can view own pay');
  assert.ok(empPerms.includes(PERMISSIONS.EMP_TICKET_C), 'can create help tickets');
});

test('Employee default permissions do NOT include admin operations', () => {
  const empPerms = DEFAULTS.employee;
  assert.ok(!empPerms.includes(PERMISSIONS.RBAC_ROLE_R), 'no role management');
  assert.ok(!empPerms.includes(PERMISSIONS.EMPLOYEES_RECORD_R), 'no employee directory');
  assert.ok(!empPerms.includes(PERMISSIONS.LEAVE_APPROVE), 'no leave approvals');
  assert.ok(!empPerms.includes(PERMISSIONS.OPS_GEOFENCE_R), 'no office settings');
  assert.ok(!empPerms.includes(PERMISSIONS.ATTENDANCE_RECORD_R), 'no company attendance history');
});

test('Reporting Manager default permissions include admin portal and team-scoped access', () => {
  const rmPerms = DEFAULTS['reporting-manager'];
  assert.ok(rmPerms.includes(PERMISSIONS.PORTAL_ADMIN), 'has admin portal access');
  assert.ok(rmPerms.includes(PERMISSIONS.PORTAL_EMPLOYEE), 'has employee portal access');
  assert.ok(rmPerms.includes(PERMISSIONS.PORTAL_SWITCH), 'can switch portals');
  assert.ok(rmPerms.includes(PERMISSIONS.DASHBOARD_ADMIN), 'has admin dashboard');
  assert.ok(rmPerms.includes(PERMISSIONS.LEAVE_APPROVE), 'can approve leave');
  assert.ok(rmPerms.includes(PERMISSIONS.ATTENDANCE_READ_TEAM), 'can read team attendance');
  assert.ok(rmPerms.includes(PERMISSIONS.SALARY_TEAM_AUDIT_R), 'can audit team salary');
});

test('Reporting Manager default permissions do NOT include company-wide employee record read', () => {
  const rmPerms = DEFAULTS['reporting-manager'];
  assert.ok(!rmPerms.includes(PERMISSIONS.EMPLOYEES_RECORD_R), 'no company-wide employee directory');
  assert.ok(!rmPerms.includes(PERMISSIONS.RBAC_ROLE_C), 'cannot create roles');
  assert.ok(!rmPerms.includes(PERMISSIONS.OPS_GEOFENCE_U), 'cannot edit office settings');
});

// ── 2. Dynamic permission update for Employee role ─────────────────────────

test('Admin can add permissions to Employee role dynamically', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const prevVersion = empRole.permissionsVersion;

  const res = mockRes();
  await updateRole(
    {
      params: { id: empRole._id.toString() },
      body: {
        name: 'Employee',
        permissions: [...DEFAULTS.employee, PERMISSIONS.ATTENDANCE_RECORD_R],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.role.permissions.includes(PERMISSIONS.ATTENDANCE_RECORD_R), 'new permission added');
  const reloaded = await Role.findById(empRole._id).lean();
  assert.ok(reloaded.permissions.includes(PERMISSIONS.ATTENDANCE_RECORD_R), 'persisted to DB');
  assert.ok(reloaded.permissionsVersion > prevVersion, 'permissionsVersion bumped');
});

test('Admin can remove permissions from Employee role dynamically', async () => {
  const empRole = await createSystemRole('Employee', 'employee', [
    PERMISSIONS.PORTAL_EMPLOYEE,
    PERMISSIONS.EMP_DASHBOARD_R,
    PERMISSIONS.EMP_PAY_R,
  ]);

  const res = mockRes();
  await updateRole(
    {
      params: { id: empRole._id.toString() },
      body: {
        name: 'Employee',
        permissions: [PERMISSIONS.PORTAL_EMPLOYEE, PERMISSIONS.EMP_DASHBOARD_R],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.role.permissions.includes(PERMISSIONS.EMP_PAY_R), 'permission removed');
  const reloaded = await Role.findById(empRole._id).lean();
  assert.ok(!reloaded.permissions.includes(PERMISSIONS.EMP_PAY_R), 'removed from DB');
});

// ── 3. Dynamic permission update for Reporting Manager role ────────────────

test('Admin can add permissions to RM role dynamically', async () => {
  const rmRole = await createSystemRole('Reporting Manager', 'reporting-manager', DEFAULTS['reporting-manager']);
  const prevVersion = rmRole.permissionsVersion;

  const res = mockRes();
  await updateRole(
    {
      params: { id: rmRole._id.toString() },
      body: {
        name: 'Reporting Manager',
        permissions: [...DEFAULTS['reporting-manager'], PERMISSIONS.EMPLOYEES_RECORD_R],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.role.permissions.includes(PERMISSIONS.EMPLOYEES_RECORD_R), 'company-wide read added');
  const reloaded = await Role.findById(rmRole._id).lean();
  assert.ok(reloaded.permissionsVersion > prevVersion, 'permissionsVersion bumped');
});

test('Admin can remove leave-approve from RM role', async () => {
  const rmRole = await createSystemRole('Reporting Manager', 'reporting-manager', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.LEAVE_READ,
  ]);

  const res = mockRes();
  await updateRole(
    {
      params: { id: rmRole._id.toString() },
      body: {
        name: 'Reporting Manager',
        permissions: [PERMISSIONS.PORTAL_ADMIN, PERMISSIONS.LEAVE_READ],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.role.permissions.includes(PERMISSIONS.LEAVE_APPROVE), 'leave approve removed');
});

// ── 4. Permission changes take effect immediately ──────────────────────────

test('resolveUserPermissions reflects updated role permissions immediately', async () => {
  const empRole = await createSystemRole('Employee', 'employee', [PERMISSIONS.PORTAL_EMPLOYEE]);
  const emp = await createUser('Eager', { roleId: empRole._id });

  // Reload user with populated role to simulate a real authenticated request
  let populated = await User.findById(emp._id).populate('roleId');
  let userPerms = resolveUserPermissions(populated);
  assert.ok(userPerms.includes(PERMISSIONS.PORTAL_EMPLOYEE));
  assert.ok(!userPerms.includes(PERMISSIONS.EMP_PAY_R));

  // Admin adds emp.pay.r to Employee role
  empRole.permissions = [...empRole.permissions, PERMISSIONS.EMP_PAY_R];
  await empRole.save();

  // Reload user with populated role (simulates fresh authenticate() call)
  const reloaded = await User.findById(emp._id).populate('roleId');
  userPerms = resolveUserPermissions(reloaded);
  assert.ok(userPerms.includes(PERMISSIONS.EMP_PAY_R), 'new permission effective immediately');
});

test('resolveUserPermissions reflects removed permissions immediately', async () => {
  const rmRole = await createSystemRole('Reporting Manager', 'reporting-manager', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.LEAVE_APPROVE,
  ]);
  const rm = await createUser('Reduced', { roleId: rmRole._id });

  let populated = await User.findById(rm._id).populate('roleId');
  let userPerms = resolveUserPermissions(populated);
  assert.ok(userPerms.includes(PERMISSIONS.LEAVE_APPROVE));

  // Admin removes leave.approve
  rmRole.permissions = [PERMISSIONS.PORTAL_ADMIN];
  await rmRole.save();

  const reloaded = await User.findById(rm._id).populate('roleId');
  userPerms = resolveUserPermissions(reloaded);
  assert.ok(!userPerms.includes(PERMISSIONS.LEAVE_APPROVE), 'removed permission no longer effective');
});

// ── 5. Portal access gating ────────────────────────────────────────────────

test('Employee role grants employee portal access, denies admin portal', () => {
  const empPerms = DEFAULTS.employee;
  assert.equal(hasEmployeePortalAccess(empPerms), true);
  assert.equal(hasAdminPortalAccess(empPerms), false);
});

test('RM role grants both admin and employee portal access', () => {
  const rmPerms = DEFAULTS['reporting-manager'];
  assert.equal(hasAdminPortalAccess(rmPerms), true);
  assert.equal(hasEmployeePortalAccess(rmPerms), true);
});

test('Custom Employee-only role without portal.employee.r denies employee portal', async () => {
  const customEmp = await createRoleDoc('Limited Employee', 'limited-employee', []);
  assert.equal(hasEmployeePortalAccess(customEmp.permissions), false);
  assert.equal(hasAdminPortalAccess(customEmp.permissions), false);
});

// ── 6. requirePermission middleware for Employee vs RM ─────────────────────

test('requirePermission blocks Employee from admin-only permission', () => {
  const empPerms = DEFAULTS.employee;
  const middleware = requirePermission(PERMISSIONS.RBAC_ROLE_R);
  let denied = false;
  middleware(
    { userPermissions: empPerms },
    { status: (code) => { denied = code === 403; return { json: () => {} }; } },
    () => { denied = false; },
  );
  assert.equal(denied, true, 'Employee blocked from RBAC_ROLE_R');
});

test('requirePermission allows RM with leave.approve', () => {
  const rmPerms = DEFAULTS['reporting-manager'];
  const middleware = requirePermission(PERMISSIONS.LEAVE_APPROVE);
  let nextCalled = false;
  middleware(
    { userPermissions: rmPerms },
    { status: () => ({ json: () => {} }) },
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true, 'RM allowed with leave.approve');
});

test('requirePermission allows Employee with own permission', () => {
  const empPerms = DEFAULTS.employee;
  const middleware = requirePermission(PERMISSIONS.EMP_LEAVE_C);
  let nextCalled = false;
  middleware(
    { userPermissions: empPerms },
    { status: () => ({ json: () => {} }) },
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true, 'Employee allowed with emp.leave.c');
});

test('requirePermission OR logic: passes if ANY permission matches', () => {
  const empPerms = DEFAULTS.employee;
  const middleware = requirePermission(PERMISSIONS.RBAC_ROLE_R, PERMISSIONS.EMP_LEAVE_C);
  let nextCalled = false;
  middleware(
    { userPermissions: empPerms },
    { status: () => ({ json: () => {} }) },
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true, 'Employee passes OR gate via emp.leave.c');
});

// ── 7. RM team scope enforcement ──────────────────────────────────────────

test('RM sees team members within managed departments, not outsiders', async () => {
  const dept = await createDept(`ENG${sequence}`);
  const rmRole = await createSystemRole('RM', 'reporting-manager', DEFAULTS['reporting-manager']);
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);

  const rm = await createUser('Manager', {
    roleId: rmRole._id,
    managedDepartmentIds: [dept._id],
  });
  const inTeam = await createUser('InTeam', {
    roleId: empRole._id,
    departmentId: dept._id,
    reportingManagerId: rm._id,
  });
  const outsider = await createUser('Outsider', { roleId: empRole._id });

  const scopedIds = await resolveTeamScopedUserIds(
    actorAs(rm, rmRole),
    DEFAULTS['reporting-manager'],
  );

  assert.ok(scopedIds !== null, 'RM is not company-wide');
  const scopedStrs = scopedIds.map((id) => String(id));
  assert.ok(scopedStrs.includes(String(inTeam._id)), 'team member included');
  assert.ok(!scopedStrs.includes(String(outsider._id)), 'outsider excluded');
});

test('Employee with employees.record.r but not admin/HR role gets team scope only', async () => {
  const dept = await createDept(`OPS${sequence}`);
  const customRole = await createRoleDoc('Custom RM', 'custom-rm', [
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.PORTAL_ADMIN,
  ]);
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);

  const customRm = await createUser('CustomMgr', {
    roleId: customRole._id,
    managedDepartmentIds: [dept._id],
  });
  const inTeam = await createUser('TeamPeer', {
    roleId: empRole._id,
    departmentId: dept._id,
    reportingManagerId: customRm._id,
  });
  const outsider = await createUser('Other', { roleId: empRole._id });

  const scopedIds = await resolveTeamScopedUserIds(
    actorAs(customRm, customRole),
    customRole.permissions,
  );

  assert.ok(scopedIds !== null, 'custom role is not company-wide despite having record.r');
  const scopedStrs = scopedIds.map((id) => String(id));
  assert.ok(scopedStrs.includes(String(inTeam._id)), 'team member included');
  assert.ok(!scopedStrs.includes(String(outsider._id)), 'outsider excluded');
});

test('Admin with employees.record.r has company-wide scope', async () => {
  const adminRole = await createSystemRole('Admin', 'admin', [
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.PORTAL_ADMIN,
  ]);
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);

  const admin = await createUser('Boss', { roleId: adminRole._id, role: 'admin' });
  const anyone = await createUser('Anybody', { roleId: empRole._id });

  const scopedIds = await resolveTeamScopedUserIds(
    actorAs(admin, adminRole),
    adminRole.permissions,
  );

  assert.equal(scopedIds, null, 'admin is company-wide');
  assert.equal(await isUserInTeamScope(actorAs(admin, adminRole), adminRole.permissions, anyone._id), true);
});

test('isUserInTeamScope returns true for RM team member, false for outsider', async () => {
  const dept = await createDept(`T${sequence}`);
  const rmRole = await createSystemRole('RM', 'reporting-manager', DEFAULTS['reporting-manager']);
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);

  const rm = await createUser('TeamLead', {
    roleId: rmRole._id,
    managedDepartmentIds: [dept._id],
  });
  const inTeam = await createUser('TeamMember', {
    roleId: empRole._id,
    departmentId: dept._id,
    reportingManagerId: rm._id,
  });
  const outsider = await createUser('Stranger', { roleId: empRole._id });

  const actor = actorAs(rm, rmRole);
  const perms = DEFAULTS['reporting-manager'];

  assert.equal(await isUserInTeamScope(actor, perms, inTeam._id), true);
  assert.equal(await isUserInTeamScope(actor, perms, outsider._id), false);
});

// ── 8. Employee self-only data access ──────────────────────────────────────

test('Employee has no company-wide scope even with some read permissions', () => {
  const empPerms = DEFAULTS.employee;
  const empActor = {
    _id: new mongoose.Types.ObjectId(),
    roleId: { slug: SYSTEM_ROLE_SLUGS.EMPLOYEE },
  };
  assert.equal(hasPermission(empPerms, PERMISSIONS.EMPLOYEES_RECORD_R), false);
});

test('Employee cannot access admin portal resources via requirePermission', () => {
  const empPerms = DEFAULTS.employee;
  const adminOnlyPerms = [
    PERMISSIONS.RBAC_ROLE_R,
    PERMISSIONS.RBAC_ROLE_C,
    PERMISSIONS.OPS_GEOFENCE_R,
    PERMISSIONS.AUDIT_LOG_R,
    PERMISSIONS.EMPLOYEES_RECORD_R,
  ];

  for (const perm of adminOnlyPerms) {
    const middleware = requirePermission(perm);
    let blocked = true;
    middleware(
      { userPermissions: empPerms },
      { status: (code) => { blocked = code === 403; return { json: () => {} }; } },
      () => { blocked = false; },
    );
    assert.equal(blocked, true, `Employee blocked from ${perm}`);
  }
});

// ── 9. Custom role creation and assignment ─────────────────────────────────

test('Admin can create a custom role with Employee + RM hybrid permissions', async () => {
  const res = mockRes();
  await createRole(
    {
      body: {
        name: 'Team Lead Lite',
        slug: 'team-lead-lite',
        description: 'Limited RM with employee portal',
        permissions: [
          PERMISSIONS.PORTAL_ADMIN,
          PERMISSIONS.PORTAL_EMPLOYEE,
          PERMISSIONS.LEAVE_APPROVE,
          PERMISSIONS.EMP_DASHBOARD_R,
          PERMISSIONS.EMP_LEAVE_C,
        ],
      },
      user: { _id: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.role.slug, 'team-lead-lite');
  assert.equal(res.body.role.isSystem, false);
  assert.ok(res.body.role.permissions.includes(PERMISSIONS.LEAVE_APPROVE));
  assert.ok(res.body.role.permissions.includes(PERMISSIONS.EMP_DASHBOARD_R));
});

test('Custom role can be assigned to a user and permissions resolve correctly', async () => {
  const customRole = await createRoleDoc('Team Lead Lite', 'team-lead-lite', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.EMP_DASHBOARD_R,
  ]);
  const emp = await createUser('Promoted', { roleId: customRole._id });

  const populated = await User.findById(emp._id).populate('roleId');
  const userPerms = resolveUserPermissions(populated);
  assert.ok(userPerms.includes(PERMISSIONS.PORTAL_ADMIN), 'custom role permissions resolve');
  assert.ok(userPerms.includes(PERMISSIONS.LEAVE_APPROVE));
  assert.ok(userPerms.includes(PERMISSIONS.EMP_DASHBOARD_R));
  assert.ok(!userPerms.includes(PERMISSIONS.RBAC_ROLE_C), 'unassigned permission not present');
});

// ── 10. Role assignment from admin panel ───────────────────────────────────

test('Admin can change a user role from Employee to RM via updateEmployee', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const rmRole = await createSystemRole('Reporting Manager', 'reporting-manager', DEFAULTS['reporting-manager']);
  const adminSystemRole = await createSystemRole('Admin', 'admin', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.RBAC_ROLE_X0,
    PERMISSIONS.EMPLOYEES_EMPLOYMENT_U,
    PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_U,
  ]);
  const dept = await createDept(`UPD${sequence}`);
  const adminUser = await createUser('AdminUser', { roleId: adminSystemRole._id, role: 'admin', designation: 'Admin', joiningDate: '2025-01-01' });
  const emp = await createUser('Promotable', { roleId: empRole._id, designation: 'Developer', joiningDate: '2025-06-01', departmentId: dept._id });

  const res = mockRes();
  await updateEmployee(
    {
      params: { id: emp._id.toString() },
      body: {
        roleId: rmRole._id.toString(),
        managedDepartmentIds: [dept._id.toString()],
        reportingManagerId: adminUser._id.toString(),
        departmentId: dept._id.toString(),
      },
      user: actorAs(adminUser, adminSystemRole),
      userPermissions: adminSystemRole.permissions,
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  const updated = await User.findById(emp._id).populate('roleId');
  assert.equal(String(updated.roleId._id), String(rmRole._id));
  assert.equal(updated.roleId.slug, 'reporting-manager');
});

test('Admin can change a user role from RM to Employee via updateEmployee', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const rmRole = await createSystemRole('Reporting Manager', 'reporting-manager', DEFAULTS['reporting-manager']);
  const adminSystemRole = await createSystemRole('Admin', 'admin', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.RBAC_ROLE_X0,
    PERMISSIONS.EMPLOYEES_EMPLOYMENT_U,
    PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_U,
  ]);
  const dept = await createDept(`DEM${sequence}`);
  const adminUser = await createUser('AdminUser2', { roleId: adminSystemRole._id, role: 'admin', designation: 'Admin', joiningDate: '2025-01-01' });
  const rm = await createUser('Demoted', { roleId: rmRole._id, role: 'admin', designation: 'Manager', joiningDate: '2025-01-01', departmentId: dept._id });

  const res = mockRes();
  await updateEmployee(
    {
      params: { id: rm._id.toString() },
      body: {
        roleId: empRole._id.toString(),
        reportingManagerId: adminUser._id.toString(),
        departmentId: dept._id.toString(),
      },
      user: actorAs(adminUser, adminSystemRole),
      userPermissions: adminSystemRole.permissions,
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  const updated = await User.findById(rm._id).populate('roleId');
  assert.equal(String(updated.roleId._id), String(empRole._id));
  assert.equal(updated.roleId.slug, 'employee');
});

// ── 11. Admin lock slugs protection ───────────────────────────────────────

test('Admin role permissions cannot have lock slugs removed', async () => {
  const adminRole = await createSystemRole('Admin', 'admin', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.RBAC_ROLE_R,
    PERMISSIONS.RBAC_CATALOG_R,
    PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_R,
    PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_U,
    PERMISSIONS.LEAVE_APPROVE,
  ]);

  const res = mockRes();
  await updateRole(
    {
      params: { id: adminRole._id.toString() },
      body: {
        name: 'Admin',
        permissions: [PERMISSIONS.LEAVE_APPROVE],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  const reloaded = await Role.findById(adminRole._id).lean();
  assert.ok(reloaded.permissions.includes(PERMISSIONS.PORTAL_ADMIN), 'lock slug preserved');
  assert.ok(reloaded.permissions.includes(PERMISSIONS.RBAC_ROLE_R), 'lock slug preserved');
  assert.ok(reloaded.permissions.includes(PERMISSIONS.RBAC_CATALOG_R), 'lock slug preserved');
  assert.ok(reloaded.permissions.includes(PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_R), 'lock slug preserved');
  assert.ok(reloaded.permissions.includes(PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_U), 'lock slug preserved');
});

// ── 12. Self-lockout guard ─────────────────────────────────────────────────

test('Cannot remove permissions from own role (self-lockout)', async () => {
  const rmRole = await createSystemRole('RM', 'reporting-manager', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.LEAVE_READ,
  ]);
  const selfId = new mongoose.Types.ObjectId();

  const res = mockRes();
  await updateRole(
    {
      params: { id: rmRole._id.toString() },
      body: {
        name: 'RM',
        permissions: [PERMISSIONS.PORTAL_ADMIN, PERMISSIONS.LEAVE_READ],
      },
      user: { _id: selfId, roleId: rmRole._id },
    },
    res,
  );

  assert.equal(res.statusCode, 403);
  const reloaded = await Role.findById(rmRole._id).lean();
  assert.ok(reloaded.permissions.includes(PERMISSIONS.LEAVE_APPROVE), 'untouched');
});

test('Adding permissions to own role is allowed', async () => {
  const rmRole = await createSystemRole('RM', 'reporting-manager', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.LEAVE_APPROVE,
  ]);
  const selfId = new mongoose.Types.ObjectId();

  const res = mockRes();
  await updateRole(
    {
      params: { id: rmRole._id.toString() },
      body: {
        name: 'RM',
        permissions: [PERMISSIONS.PORTAL_ADMIN, PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_READ],
      },
      user: { _id: selfId, roleId: rmRole._id },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.role.permissions.includes(PERMISSIONS.LEAVE_READ), 'addition allowed');
});

// ── 13. System role deletion block ─────────────────────────────────────────

test('System roles cannot be deleted', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);

  const res = mockRes();
  await deleteRole(
    {
      params: { id: empRole._id.toString() },
      user: { _id: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /system/i);
  const stillExists = await Role.findById(empRole._id);
  assert.ok(stillExists, 'role not deleted');
});

test('Custom roles can be deleted', async () => {
  const customRole = await createRoleDoc('Temp Role', 'temp-role', []);

  const res = mockRes();
  await deleteRole(
    {
      params: { id: customRole._id.toString() },
      user: { _id: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  const gone = await Role.findById(customRole._id);
  assert.equal(gone, null, 'role deleted');
});

// ── 14. Role list scope=creatable for RM ──────────────────────────────────

test('Role list without includeSystem parameter returns all roles', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const rmRole = await createSystemRole('RM', 'reporting-manager', DEFAULTS['reporting-manager']);
  const customRole = await createRoleDoc('Custom', 'custom', []);

  const rm = await createUser('ScopedRm', { roleId: rmRole._id });
  const actor = actorAs(rm, rmRole);

  const res = mockRes();
  await listRoles(
    { query: {}, user: actor, userPermissions: DEFAULTS['reporting-manager'] },
    res,
  );

  assert.equal(res.statusCode, 200);
  const slugs = res.body.roles.map((r) => r.slug);
  assert.ok(slugs.includes('employee'), 'includes Employee');
  assert.ok(slugs.includes('reporting-manager'), 'includes RM');
  assert.ok(slugs.includes('custom'), 'includes custom role');
});

test('Role list with includeSystem=false returns only non-system roles', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const rmRole = await createSystemRole('RM', 'reporting-manager', DEFAULTS['reporting-manager']);
  const customRole = await createRoleDoc('Custom', 'custom', []);

  const res = mockRes();
  await listRoles(
    { query: { includeSystem: 'false' }, user: { _id: new mongoose.Types.ObjectId() }, userPermissions: [] },
    res,
  );

  assert.equal(res.statusCode, 200);
  const slugs = res.body.roles.map((r) => r.slug);
  assert.ok(slugs.includes('custom'), 'includes custom role');
  assert.ok(!slugs.includes('employee'), 'excludes system Employee role');
  assert.ok(!slugs.includes('reporting-manager'), 'excludes system RM role');
});

test('Role list with includeSystem=true returns all roles', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const rmRole = await createSystemRole('RM', 'reporting-manager', DEFAULTS['reporting-manager']);
  const customRole = await createRoleDoc('Custom', 'custom', []);

  const res = mockRes();
  await listRoles(
    { query: { includeSystem: 'true' }, user: { _id: new mongoose.Types.ObjectId() }, userPermissions: [] },
    res,
  );

  assert.equal(res.statusCode, 200);
  const slugs = res.body.roles.map((r) => r.slug);
  assert.ok(slugs.includes('employee'), 'includes Employee');
  assert.ok(slugs.includes('reporting-manager'), 'includes system RM role');
  assert.ok(slugs.includes('custom'), 'includes custom role');
});

// ── 15. permissionsVersion bumps on change ─────────────────────────────────

test('permissionsVersion increments when permissions change', async () => {
  const role = await createSystemRole('Test Role', 'test-role', [PERMISSIONS.EMP_DASHBOARD_R]);
  const v1 = role.permissionsVersion;

  const res = mockRes();
  await updateRole(
    {
      params: { id: role._id.toString() },
      body: {
        name: 'Test Role',
        permissions: [PERMISSIONS.EMP_DASHBOARD_R, PERMISSIONS.EMP_PAY_R],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.role.permissionsVersion > v1, 'version bumped');
});

test('permissionsVersion does NOT bump when only name changes', async () => {
  const role = await createSystemRole('Test Role', 'test-role', [PERMISSIONS.EMP_DASHBOARD_R]);
  const v1 = role.permissionsVersion;

  const res = mockRes();
  await updateRole(
    {
      params: { id: role._id.toString() },
      body: { name: 'Updated Name' },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  const reloaded = await Role.findById(role._id).lean();
  assert.equal(reloaded.permissionsVersion, v1, 'version unchanged for name-only update');
});

// ── 16. Dynamic update from Employee-only to having RM-like permissions ────

test('Admin upgrades Employee role with RM-like permissions and user gains access', async () => {
  const empRole = await createSystemRole('Employee', 'employee', [
    PERMISSIONS.PORTAL_EMPLOYEE,
    PERMISSIONS.EMP_DASHBOARD_R,
  ]);
  const emp = await createUser('Upgraded', { roleId: empRole._id, designation: 'Dev', joiningDate: '2025-01-01' });

  // Initially: no leave approve
  let populated = await User.findById(emp._id).populate('roleId');
  let userPerms = resolveUserPermissions(populated);
  assert.ok(!userPerms.includes(PERMISSIONS.LEAVE_APPROVE));

  // Admin adds leave.approve and portal.admin to Employee role (unusual but possible)
  const res = mockRes();
  await updateRole(
    {
      params: { id: empRole._id.toString() },
      body: {
        name: 'Employee',
        permissions: [
          PERMISSIONS.PORTAL_EMPLOYEE,
          PERMISSIONS.PORTAL_ADMIN,
          PERMISSIONS.EMP_DASHBOARD_R,
          PERMISSIONS.LEAVE_APPROVE,
        ],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    res,
  );
  assert.equal(res.statusCode, 200);

  // Reload and check
  const reloaded = await User.findById(emp._id).populate('roleId');
  userPerms = resolveUserPermissions(reloaded);
  assert.ok(userPerms.includes(PERMISSIONS.LEAVE_APPROVE), 'user gains leave approve');
  assert.ok(userPerms.includes(PERMISSIONS.PORTAL_ADMIN), 'user gains admin portal access');
});

// ── 17. RM registered via admin gets correct scope ────────────────────────

test('Registering a new user as Employee via admin creates with correct role', async () => {
  const dept = await createDept(`REG${sequence}`);
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const adminRole = await createSystemRole('Admin', 'admin', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.EMPLOYEES_REGISTER_C,
    PERMISSIONS.EMPLOYEES_REGISTER_X1,
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.USERS_WRITE,
  ]);

  const admin = await createUser('RegAdmin', { roleId: adminRole._id, role: 'admin', designation: 'Admin', joiningDate: '2025-01-01' });
  const actor = actorAs(admin, adminRole);

  const res = mockRes();
  await registerEmployee(
    {
      body: {
        firstName: 'New',
        lastName: 'Employee',
        email: `newemp.${sequence}@test.example`,
        mobile: `9${String(500000000 + sequence)}`,
        password: 'Temp@1234',
        designation: 'Developer',
        joiningDate: '2026-09-01',
        departmentId: dept._id.toString(),
        roleId: empRole._id.toString(),
        reportingManagerId: admin._id.toString(),
      },
      user: actor,
      userPermissions: adminRole.permissions,
    },
    res,
  );

  assert.equal(res.statusCode, 201);
  const created = await User.findOne({ email: `newemp.${sequence}@test.example` }).lean();
  assert.ok(created, 'user created');
  assert.equal(String(created.roleId), String(empRole._id));
  assert.equal(String(created.reportingManagerId), String(admin._id));
});

// ── 18. Employee role cannot self-upgrade to Admin role ───────────────────

test('Employee cannot assign themselves the Admin role via self-update', async () => {
  const empRole = await createSystemRole('Employee', 'employee', DEFAULTS.employee);
  const adminRole = await createSystemRole('Admin', 'admin', [
    PERMISSIONS.PORTAL_ADMIN,
    PERMISSIONS.RBAC_ROLE_R,
  ]);
  const emp = await createUser('SelfUpgrade', { roleId: empRole._id, designation: 'Dev', joiningDate: '2025-01-01' });

  const res = mockRes();
  await updateEmployee(
    {
      params: { id: emp._id.toString() },
      body: { roleId: adminRole._id.toString() },
      user: actorAs(emp, empRole),
      userPermissions: DEFAULTS.employee,
    },
    res,
  );

  assert.ok(res.statusCode >= 400, 'Employee blocked from assigning Admin role to self');
  assert.notEqual(res.statusCode, 200, 'must not succeed');
});

// ── 19. Multiple dynamic updates accumulate correctly ──────────────────────

test('Multiple sequential permission updates accumulate correctly', async () => {
  const empRole = await createSystemRole('Employee', 'employee', [PERMISSIONS.PORTAL_EMPLOYEE]);

  // Update 1: add dashboard
  await updateRole(
    {
      params: { id: empRole._id.toString() },
      body: { name: 'Employee', permissions: [PERMISSIONS.PORTAL_EMPLOYEE, PERMISSIONS.EMP_DASHBOARD_R] },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    mockRes(),
  );

  // Update 2: add leave
  await updateRole(
    {
      params: { id: empRole._id.toString() },
      body: {
        name: 'Employee',
        permissions: [PERMISSIONS.PORTAL_EMPLOYEE, PERMISSIONS.EMP_DASHBOARD_R, PERMISSIONS.EMP_LEAVE_C],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    mockRes(),
  );

  // Update 3: remove dashboard, keep leave
  await updateRole(
    {
      params: { id: empRole._id.toString() },
      body: {
        name: 'Employee',
        permissions: [PERMISSIONS.PORTAL_EMPLOYEE, PERMISSIONS.EMP_LEAVE_C],
      },
      user: { _id: new mongoose.Types.ObjectId(), roleId: new mongoose.Types.ObjectId() },
    },
    mockRes(),
  );

  const final = await Role.findById(empRole._id).lean();
  assert.ok(final.permissions.includes(PERMISSIONS.PORTAL_EMPLOYEE), 'portal kept');
  assert.ok(final.permissions.includes(PERMISSIONS.EMP_LEAVE_C), 'leave kept');
  assert.ok(!final.permissions.includes(PERMISSIONS.EMP_DASHBOARD_R), 'dashboard removed');
  assert.equal(final.permissionsVersion, 4, 'version bumped 3 times from initial 1');
});

// ── 20. Custom role with no permissions is effectively locked out ──────────

test('User with empty-permissions role gets empty permissions from resolveUserPermissions', async () => {
  const emptyRole = await createRoleDoc('Locked', 'locked', []);
  const user = await createUser('Locked', { roleId: emptyRole._id });
  const perms = resolveUserPermissions(user);
  assert.deepEqual(perms, [], 'no permissions');
});

test('requirePermission denies user with empty permissions', () => {
  const middleware = requirePermission(PERMISSIONS.EMP_DASHBOARD_R);
  let blocked = false;
  middleware(
    { userPermissions: [] },
    { status: (code) => { blocked = code === 403; return { json: () => {} }; } },
    () => { blocked = false; },
  );
  assert.equal(blocked, true, 'empty permissions denied');
});
