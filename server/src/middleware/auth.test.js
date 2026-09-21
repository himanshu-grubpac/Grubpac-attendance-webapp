import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSIONS,
  buildDefaultRolePermissions,
  hasAdminPortalAccess,
  hasEmployeePortalAccess,
  hasPermission,
  migrateLegacyPermissions,
} from '../../../shared/permissions.js';
import { requirePermission, resolveUserPermissions } from './auth.js';

function runRequirePermission(requiredPermissions, userPermissions) {
  const middleware = requirePermission(...requiredPermissions);
  const req = { userPermissions };
  let statusCode = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { statusCode, nextCalled };
}

test('hasPermission accepts catalog slugs directly', () => {
  assert.equal(hasPermission(['portal.admin.r'], PERMISSIONS.PORTAL_ADMIN), true);
  assert.equal(hasPermission(['emp.pay.r'], PERMISSIONS.EMP_PAY_R), true);
  assert.equal(hasPermission(['emp.pay.r'], PERMISSIONS.PORTAL_ADMIN), false);
});

test('hasPermission migrates legacy slugs during check window', () => {
  const migrated = migrateLegacyPermissions(['users.read', 'salary.read']);
  assert.ok(migrated.includes('employees.record.r'));
  assert.ok(migrated.includes('salary.payroll.r'));
});

test('portal gate helpers use catalog slugs', () => {
  assert.equal(hasAdminPortalAccess(['portal.admin.r']), true);
  assert.equal(hasAdminPortalAccess(['employees.record.r']), false);
  assert.equal(hasEmployeePortalAccess(['portal.employee.r']), true);
  assert.equal(hasEmployeePortalAccess(['portal.admin.r']), false);
});

test('settlement slug is admin-only in default templates', () => {
  const defaults = buildDefaultRolePermissions();
  assert.ok(defaults.admin.includes('salary.settlement.x0'));
  assert.ok(!defaults.hr.includes('salary.settlement.x0'));
});

test('credentials x0/x1 are distinct slugs', () => {
  assert.notEqual(PERMISSIONS.EMPLOYEES_CREDENTIALS_X0, PERMISSIONS.EMPLOYEES_CREDENTIALS_X1);
  assert.equal(PERMISSIONS.EMPLOYEES_CREDENTIALS_X0, 'employees.credentials.x0');
});

test('resolveUserPermissions migrates legacy role document slugs', () => {
  const user = {
    role: 'employee',
    roleId: {
      permissions: ['users.read', 'leave.read', 'attendance.read_own'],
    },
  };
  const perms = resolveUserPermissions(user);
  assert.ok(perms.includes('employees.record.r'));
  assert.ok(perms.includes('emp.leave.r'));
  assert.ok(perms.includes('emp.attendance.r'));
});

test('resolveUserPermissions returns empty array when role has empty permissions', () => {
  const user = {
    role: 'admin',
    roleId: {
      permissions: [],
    },
  };
  assert.deepEqual(resolveUserPermissions(user), []);
});

test('resolveUserPermissions returns empty array when roleId is missing', () => {
  const user = {
    role: 'employee',
    roleId: null,
  };
  assert.deepEqual(resolveUserPermissions(user), []);
});

test('GET /admin/departments gate allows ops or team-scoped read permissions', () => {
  const departmentListPermissions = [
    PERMISSIONS.OPS_DEPARTMENT_R,
    PERMISSIONS.EMPLOYEES_STATS_R,
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.SALARY_TEAM_AUDIT_R,
  ];

  assert.equal(runRequirePermission(departmentListPermissions, ['ops.department.r']).nextCalled, true);
  assert.equal(runRequirePermission(departmentListPermissions, ['employees.stats.r']).nextCalled, true);
  assert.equal(runRequirePermission(departmentListPermissions, ['employees.record.r']).nextCalled, true);
  assert.equal(runRequirePermission(departmentListPermissions, ['salary.team_audit.r']).nextCalled, true);
  assert.equal(runRequirePermission(departmentListPermissions, ['attendance.record.r']).nextCalled, false);
});
