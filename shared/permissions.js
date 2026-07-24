/**
 * Stable permission keys for RBAC. Shared by server and client.
 */

export const PERMISSIONS = {
  USERS_READ: 'users.read',
  USERS_WRITE: 'users.write',
  LEAVE_READ: 'leave.read',
  LEAVE_APPLY: 'leave.apply',
  LEAVE_APPROVE: 'leave.approve',
  LEAVE_MANAGE_POLICIES: 'leave.manage_policies',
  LEAVE_READ_TEAM: 'leave.read_team',
  LEAVE_READ_ALL: 'leave.read_all',
  LEAVE_ADJUST_BALANCES: 'leave.adjust_balances',
  SALARY_READ: 'salary.read',
  SALARY_READ_TEAM: 'salary.read_team',
  SALARY_WRITE: 'salary.write',
  HELP_READ: 'help.read',
  HELP_WRITE: 'help.write',
  HELP_MANAGE: 'help.manage',
  ROLES_MANAGE: 'roles.manage',
  OFFICE_MANAGE: 'office.manage',
  ATTENDANCE_READ_ALL: 'attendance.read_all',
  ATTENDANCE_READ_TEAM: 'attendance.read_team',
  ATTENDANCE_READ_OWN: 'attendance.read_own',
  AUDIT_READ: 'audit.read',
  DEPARTMENTS_MANAGE: 'departments.manage',
  NOTIFICATIONS_READ: 'notifications.read',
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const PERMISSION_GROUPS = [
  {
    label: 'Users',
    permissions: [
      { key: PERMISSIONS.USERS_READ, label: 'View users' },
      { key: PERMISSIONS.USERS_WRITE, label: 'Manage users' },
    ],
  },
  {
    label: 'Organization',
    permissions: [
      { key: PERMISSIONS.DEPARTMENTS_MANAGE, label: 'Manage departments' },
      { key: PERMISSIONS.ROLES_MANAGE, label: 'Manage roles' },
    ],
  },
  {
    label: 'Attendance',
    permissions: [
      { key: PERMISSIONS.ATTENDANCE_READ_OWN, label: 'Own attendance' },
      { key: PERMISSIONS.ATTENDANCE_READ_TEAM, label: 'Team attendance' },
      { key: PERMISSIONS.ATTENDANCE_READ_ALL, label: 'All attendance' },
    ],
  },
  {
    label: 'Leave',
    permissions: [
      { key: PERMISSIONS.LEAVE_READ, label: 'View own leave' },
      { key: PERMISSIONS.LEAVE_APPLY, label: 'Apply leave' },
      { key: PERMISSIONS.LEAVE_APPROVE, label: 'Approve leave' },
      { key: PERMISSIONS.LEAVE_READ_TEAM, label: 'Team leave calendar' },
      { key: PERMISSIONS.LEAVE_READ_ALL, label: 'All leave requests' },
      { key: PERMISSIONS.LEAVE_MANAGE_POLICIES, label: 'Manage leave policies' },
      { key: PERMISSIONS.LEAVE_ADJUST_BALANCES, label: 'Adjust leave balances' },
    ],
  },
  {
    label: 'Salary',
    permissions: [
      { key: PERMISSIONS.SALARY_READ, label: 'View salary reports' },
      { key: PERMISSIONS.SALARY_READ_TEAM, label: 'Team salary reports' },
      { key: PERMISSIONS.SALARY_WRITE, label: 'Manage salary data' },
    ],
  },
  {
    label: 'Help',
    permissions: [
      { key: PERMISSIONS.HELP_READ, label: 'View help tickets' },
      { key: PERMISSIONS.HELP_WRITE, label: 'Create help tickets' },
      { key: PERMISSIONS.HELP_MANAGE, label: 'Manage help tickets' },
    ],
  },
  {
    label: 'Operations',
    permissions: [
      { key: PERMISSIONS.OFFICE_MANAGE, label: 'Office settings' },
      { key: PERMISSIONS.AUDIT_READ, label: 'Audit logs' },
      { key: PERMISSIONS.NOTIFICATIONS_READ, label: 'Notifications' },
    ],
  },
];

/**
 * Permissions that grant access to the admin/management portal login.
 *
 * NOTE: PERMISSIONS.SALARY_READ is intentionally excluded. It is granted to the
 * Employee system role for self-service "my pay estimate" access, so including it
 * here would let a plain Employee pass admin-portal login and land on the admin
 * dashboard. Admin-grade salary access (the multi-employee salary rollup/export)
 * is gated separately by SALARY_READ + USERS_READ (see AdminSalarySummary route
 * guards and the salary export API), not by this list.
 */
export const ADMIN_PORTAL_PERMISSIONS = [
  PERMISSIONS.USERS_READ,
  PERMISSIONS.USERS_WRITE,
  PERMISSIONS.ROLES_MANAGE,
  PERMISSIONS.DEPARTMENTS_MANAGE,
  PERMISSIONS.OFFICE_MANAGE,
  PERMISSIONS.ATTENDANCE_READ_ALL,
  PERMISSIONS.ATTENDANCE_READ_TEAM,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.SALARY_WRITE,
  PERMISSIONS.HELP_MANAGE,
  PERMISSIONS.LEAVE_READ_ALL,
  PERMISSIONS.LEAVE_MANAGE_POLICIES,
  PERMISSIONS.LEAVE_ADJUST_BALANCES,
  PERMISSIONS.LEAVE_APPROVE,
];

export const SYSTEM_ROLE_SLUGS = {
  ADMIN: 'admin',
  HR: 'hr',
  REPORTING_MANAGER: 'reporting-manager',
  EMPLOYEE: 'employee',
};

export const SYSTEM_ROLES = [
  {
    name: 'Admin',
    slug: SYSTEM_ROLE_SLUGS.ADMIN,
    description: 'Full system access including roles, users, and settings.',
    isSystem: true,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    name: 'HR',
    slug: SYSTEM_ROLE_SLUGS.HR,
    description: 'Manage employees, departments, attendance, and leave policies.',
    isSystem: true,
    permissions: [
      PERMISSIONS.USERS_READ,
      PERMISSIONS.USERS_WRITE,
      PERMISSIONS.DEPARTMENTS_MANAGE,
      PERMISSIONS.ATTENDANCE_READ_ALL,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPLY,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.LEAVE_READ_ALL,
      PERMISSIONS.LEAVE_MANAGE_POLICIES,
      PERMISSIONS.LEAVE_ADJUST_BALANCES,
      PERMISSIONS.SALARY_READ,
      PERMISSIONS.SALARY_WRITE,
      PERMISSIONS.HELP_READ,
      PERMISSIONS.HELP_MANAGE,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.NOTIFICATIONS_READ,
    ],
  },
  {
    name: 'Reporting Manager',
    slug: SYSTEM_ROLE_SLUGS.REPORTING_MANAGER,
    description: 'View team attendance and approve leave/help for direct reports.',
    isSystem: true,
    permissions: [
      PERMISSIONS.USERS_READ,
      PERMISSIONS.ATTENDANCE_READ_OWN,
      PERMISSIONS.ATTENDANCE_READ_TEAM,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.LEAVE_READ_TEAM,
      PERMISSIONS.HELP_READ,
      PERMISSIONS.HELP_MANAGE,
      PERMISSIONS.SALARY_READ_TEAM,
      PERMISSIONS.NOTIFICATIONS_READ,
    ],
  },
  {
    name: 'Employee',
    slug: SYSTEM_ROLE_SLUGS.EMPLOYEE,
    description: 'Own attendance, leave requests, and help tickets.',
    isSystem: true,
    permissions: [
      PERMISSIONS.ATTENDANCE_READ_OWN,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPLY,
      PERMISSIONS.HELP_READ,
      PERMISSIONS.HELP_WRITE,
      PERMISSIONS.SALARY_READ,
      PERMISSIONS.NOTIFICATIONS_READ,
    ],
  },
];

export const SEED_DEPARTMENTS = [
  { name: 'Development', code: 'DEV' },
  { name: 'Design', code: 'DES' },
  { name: 'GTM', code: 'GTM' },
  { name: 'Strategy', code: 'STR' },
];

/** Handbook v0.2 leave seed — calendar year quotas. */
export const SEED_LEAVE_TYPES = [
  { code: 'SL', name: 'Sick Leave' },
  { code: 'CL', name: 'Casual Leave' },
  { code: 'EL', name: 'Earned Leave' },
  { code: 'CO', name: 'Compensatory Off' },
];

export const SEED_LEAVE_POLICIES = [
  {
    typeCode: 'SL',
    annualQuota: 7,
    accrualPerMonth: 0,
    carryForwardMax: 23,
    maxAccumulation: 30,
    requireDocAfterConsecutiveDays: 2,
    paid: true,
    encashmentMaxPerYear: 0,
  },
  {
    typeCode: 'CL',
    annualQuota: 7,
    accrualPerMonth: 0,
    carryForwardMax: 20,
    maxAccumulation: 45,
    requireDocAfterConsecutiveDays: null,
    paid: true,
    encashmentMaxPerYear: 10,
    combinedCarryGroup: 'CL_EL',
  },
  {
    typeCode: 'EL',
    annualQuota: 18,
    accrualPerMonth: 1.5,
    carryForwardMax: 20,
    maxAccumulation: 45,
    requireDocAfterConsecutiveDays: null,
    paid: true,
    encashmentMaxPerYear: 10,
    combinedCarryGroup: 'CL_EL',
  },
  {
    typeCode: 'CO',
    annualQuota: 0,
    accrualPerMonth: 0,
    carryForwardMax: 0,
    maxAccumulation: 0,
    requireDocAfterConsecutiveDays: null,
    paid: true,
    encashmentMaxPerYear: 0,
  },
];

export function isValidPermission(key) {
  return ALL_PERMISSIONS.includes(key);
}

export function normalizePermissions(permissions = []) {
  const unique = [...new Set(permissions.filter((key) => isValidPermission(key)))];
  return unique.sort();
}

export function hasPermission(userPermissions, permission) {
  if (!permission) return true;
  return (userPermissions ?? []).includes(permission);
}

export function hasAnyPermission(userPermissions, permissions = []) {
  if (!permissions.length) return true;
  return permissions.some((permission) => hasPermission(userPermissions, permission));
}

export function hasAdminPortalAccess(userPermissions) {
  return hasAnyPermission(userPermissions, ADMIN_PORTAL_PERMISSIONS);
}

export function legacyRoleFromSlug(slug) {
  if (
    slug === SYSTEM_ROLE_SLUGS.ADMIN ||
    slug === SYSTEM_ROLE_SLUGS.HR ||
    slug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER
  ) {
    return 'admin';
  }
  return 'employee';
}
