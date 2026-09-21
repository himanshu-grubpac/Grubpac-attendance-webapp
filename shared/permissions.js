/**
 * Dynamic RBAC — shared permission catalog, role templates, and helpers.
 * Source of truth: shared/permissionCatalog.js (72 verified rows).
 */

import {
  ADMIN_LOCK_SLUGS,
  LEGACY_PERMISSION_MAP,
  PERMISSION_CATALOG,
  buildDefaultRolePermissions,
  buildPermissionGroups,
  buildPermissionMetadataMap,
  filterCatalogForRole,
  getAllCatalogSlugs,
  migrateLegacyPermissions,
  slugsFromRow,
} from './permissionCatalog.js';

export {
  ADMIN_LOCK_SLUGS,
  LEGACY_PERMISSION_MAP,
  PERMISSION_CATALOG,
  buildDefaultRolePermissions,
  buildPermissionGroups,
  buildPermissionMetadataMap,
  filterCatalogForRole,
  getAllCatalogSlugs,
  migrateLegacyPermissions,
  slugsFromRow,
};

/** Company-wide employee directory scope — row 5 READ slug. */
export const COMPANY_WIDE_SCOPE_SLUG = 'employees.record.r';

/**
 * Semantic permission aliases → catalog slugs.
 * Route guards and services use these names; values are the canonical slugs.
 */
export const PERMISSIONS = {
  // Portal gates (rows 1–3)
  PORTAL_ADMIN: 'portal.admin.r',
  PORTAL_EMPLOYEE: 'portal.employee.r',
  PORTAL_SWITCH: 'portal.switch.r',

  // Admin dashboard (row 4)
  DASHBOARD_ADMIN: 'dashboard.admin.r',

  // Employees (rows 5–18)
  EMPLOYEES_RECORD_C: 'employees.record.c',
  EMPLOYEES_RECORD_R: 'employees.record.r',
  EMPLOYEES_RECORD_U: 'employees.record.u',
  EMPLOYEES_RECORD_D: 'employees.record.d',
  EMPLOYEES_RECORD_X0: 'employees.record.x0',
  EMPLOYEES_STATS_R: 'employees.stats.r',
  EMPLOYEES_SALARY_COLUMN_R: 'employees.salary_column.r',
  EMPLOYEES_ACCOUNT_R: 'employees.account.r',
  EMPLOYEES_EMPLOYMENT_R: 'employees.employment.r',
  EMPLOYEES_EMPLOYMENT_U: 'employees.employment.u',
  EMPLOYEES_SALARY_R: 'employees.salary.r',
  EMPLOYEES_SALARY_U: 'employees.salary.u',
  EMPLOYEES_SALARY_HISTORY_R: 'employees.salary_history.r',
  EMPLOYEES_CREDENTIALS_U: 'employees.credentials.u',
  EMPLOYEES_CREDENTIALS_X0: 'employees.credentials.x0',
  EMPLOYEES_CREDENTIALS_X1: 'employees.credentials.x1',
  EMPLOYEES_CREDENTIALS_X2: 'employees.credentials.x2',
  EMPLOYEES_STATUS_U: 'employees.status.u',
  EMPLOYEES_STATUS_X0: 'employees.status.x0',
  EMPLOYEES_STATUS_X1: 'employees.status.x1',
  EMPLOYEES_SALARY_HISTORY_X0: 'employees.salary_history.x0',
  EMPLOYEES_REGISTER_X0: 'employees.register.x0',
  EMPLOYEES_REGISTER_X1: 'employees.register.x1',
  EMPLOYEES_REGISTER_X2: 'employees.register.x2',
  EMPLOYEES_BULK_EXPORT_X0: 'employees.bulk_export.x0',
  EMPLOYEES_BULK_UPLOAD_X0: 'employees.bulk_upload.x0',
  EMPLOYEES_DELEGATE_R: 'employees.delegate.r',
  EMPLOYEES_DELEGATE_U: 'employees.delegate.u',
  EMPLOYEES_MANAGED_DEPTS_R: 'employees.managed_depts.r',
  EMPLOYEES_MANAGED_DEPTS_U: 'employees.managed_depts.u',
  EMPLOYEES_REGISTER_C: 'employees.register.c',
  EMPLOYEES_BULK_EXPORT_R: 'employees.bulk_export.r',
  EMPLOYEES_BULK_UPLOAD_C: 'employees.bulk_upload.c',
  EMPLOYEES_BULK_UPLOAD_U: 'employees.bulk_upload.u',

  // Salary admin (rows 19–27)
  SALARY_PAYROLL_R: 'salary.payroll.r',
  SALARY_PAYROLL_X0: 'salary.payroll.x0',
  SALARY_PAYROLL_DETAIL_R: 'salary.payroll_detail.r',
  SALARY_TRANSFER_C: 'salary.transfer.c',
  SALARY_TRANSFER_R: 'salary.transfer.r',
  SALARY_TRANSFER_U: 'salary.transfer.u',
  SALARY_TRANSFER_X0: 'salary.transfer.x0',
  SALARY_TRANSFER_X1: 'salary.transfer.x1',
  SALARY_TRANSFER_X2: 'salary.transfer.x2',
  SALARY_SETTLEMENT_R: 'salary.settlement.r',
  SALARY_SETTLEMENT_X0: 'salary.settlement.x0',
  SALARY_HISTORY_R: 'salary.history.r',
  SALARY_AUDIT_R: 'salary.audit.r',
  SALARY_AUDIT_X0: 'salary.audit.x0',
  SALARY_STRUCTURE_R: 'salary.structure.r',
  SALARY_STRUCTURE_U: 'salary.structure.u',
  SALARY_SCHEDULE_R: 'salary.schedule.r',
  SALARY_SCHEDULE_U: 'salary.schedule.u',
  SALARY_TEAM_AUDIT_R: 'salary.team_audit.r',
  SALARY_TEAM_AUDIT_X0: 'salary.team_audit.x0',

  // Attendance admin (rows 28–31, 41)
  ATTENDANCE_RECORD_C: 'attendance.record.c',
  ATTENDANCE_RECORD_R: 'attendance.record.r',
  ATTENDANCE_RECORD_U: 'attendance.record.u',
  ATTENDANCE_RECORD_X0: 'attendance.record.x0',
  ATTENDANCE_RECORD_X1: 'attendance.record.x1',
  ATTENDANCE_RECORD_X2: 'attendance.record.x2',
  ATTENDANCE_LOG_R: 'attendance.log.r',
  ATTENDANCE_WARNING_COL_R: 'attendance.warning_col.r',
  ATTENDANCE_TODAY_R: 'attendance.today.r',
  ATTENDANCE_LATE_WARNING_R: 'attendance.late_warning.r',
  ATTENDANCE_LATE_WARNING_X0: 'attendance.late_warning.x0',
  ATTENDANCE_LATE_WARNING_X1: 'attendance.late_warning.x1',

  // Audit (rows 32–33)
  AUDIT_LOG_R: 'audit.log.r',
  AUDIT_LOG_X0: 'audit.log.x0',
  AUDIT_LOG_X1: 'audit.log.x1',
  AUDIT_LOG_PII_R: 'audit.log_pii.r',

  // Help admin (row 34)
  HELP_TICKET_R: 'help.ticket.r',
  HELP_TICKET_U: 'help.ticket.u',
  HELP_TICKET_D: 'help.ticket.d',
  HELP_TICKET_X0: 'help.ticket.x0',
  HELP_TICKET_X1: 'help.ticket.x1',
  HELP_TICKET_X2: 'help.ticket.x2',
  /** Set ticket priority (catalog extra help.ticket.x0). */
  HELP_SET_PRIORITY: 'help.ticket.x0',

  // Leave admin (rows 35–44)
  LEAVE_TYPE_C: 'leave.type.c',
  LEAVE_TYPE_R: 'leave.type.r',
  LEAVE_TYPE_U: 'leave.type.u',
  LEAVE_TYPE_D: 'leave.type.d',
  LEAVE_TYPE_X0: 'leave.type.x0',
  LEAVE_POLICY_C: 'leave.policy.c',
  LEAVE_POLICY_R: 'leave.policy.r',
  LEAVE_POLICY_U: 'leave.policy.u',
  LEAVE_POLICY_D: 'leave.policy.d',
  LEAVE_ADJUSTMENT_R: 'leave.adjustment.r',
  LEAVE_ADJUSTMENT_U: 'leave.adjustment.u',
  LEAVE_ADJUSTMENT_X0: 'leave.adjustment.x0',
  LEAVE_ADJUSTMENT_X1: 'leave.adjustment.x1',
  LEAVE_REQUEST_R: 'leave.request.r',
  LEAVE_REQUEST_APPROVE: 'leave.request.x0',
  LEAVE_REQUEST_REJECT: 'leave.request.x1',
  LEAVE_WFH_R: 'leave.wfh.r',
  LEAVE_WFH_APPROVE: 'leave.wfh.x0',
  LEAVE_WFH_REJECT: 'leave.wfh.x1',
  LEAVE_COMPOFF_R: 'leave.compoff.r',
  LEAVE_COMPOFF_APPROVE: 'leave.compoff.x0',
  LEAVE_COMPOFF_REJECT: 'leave.compoff.x1',
  LEAVE_HOLIDAY_C: 'leave.holiday.c',
  LEAVE_HOLIDAY_R: 'leave.holiday.r',
  LEAVE_HOLIDAY_U: 'leave.holiday.u',
  LEAVE_HOLIDAY_D: 'leave.holiday.d',
  LEAVE_CATEGORY_C: 'leave.category.c',
  LEAVE_CATEGORY_R: 'leave.category.r',
  LEAVE_CATEGORY_U: 'leave.category.u',
  LEAVE_CATEGORY_D: 'leave.category.d',
  LEAVE_RECURRING_C: 'leave.recurring.c',
  LEAVE_RECURRING_R: 'leave.recurring.r',
  LEAVE_RECURRING_U: 'leave.recurring.u',
  LEAVE_RECURRING_D: 'leave.recurring.d',
  LEAVE_RECURRING_X0: 'leave.recurring.x0',

  // Operations (rows 45–53)
  OPS_GEOFENCE_R: 'ops.geofence.r',
  OPS_GEOFENCE_U: 'ops.geofence.u',
  OPS_GEOFENCE_X0: 'ops.geofence.x0',
  OPS_HOURS_R: 'ops.hours.r',
  OPS_HOURS_U: 'ops.hours.u',
  OPS_WEEKEND_R: 'ops.weekend.r',
  OPS_WEEKEND_U: 'ops.weekend.u',
  OPS_SANDWICH_R: 'ops.sandwich.r',
  OPS_SANDWICH_U: 'ops.sandwich.u',
  OPS_WARNING_LIMIT_R: 'ops.warning_limit.r',
  OPS_WARNING_LIMIT_U: 'ops.warning_limit.u',
  OPS_AUTOCHECKOUT_R: 'ops.autocheckout.r',
  OPS_AUTOCHECKOUT_U: 'ops.autocheckout.u',
  OPS_DEPARTMENT_R: 'ops.department.r',
  OPS_DEPARTMENT_C: 'ops.department.c',
  OPS_DEPARTMENT_U: 'ops.department.u',
  OPS_DEPARTMENT_D: 'ops.department.d',
  OPS_DEPARTMENT_X0: 'ops.department.x0',
  OPS_DEPARTMENT_X1: 'ops.department.x1',
  OPS_DEPARTMENT_X2: 'ops.department.x2',
  OPS_FAQ_R: 'ops.faq.r',
  OPS_FAQ_C: 'ops.faq.c',
  OPS_FAQ_U: 'ops.faq.u',
  OPS_FAQ_D: 'ops.faq.d',
  OPS_FAQ_X0: 'ops.faq.x0',
  OPS_FAQ_X1: 'ops.faq.x1',
  OPS_GUIDE_R: 'ops.guide.r',

  // RBAC (rows 54–56)
  RBAC_ROLE_R: 'rbac.role.r',
  RBAC_ROLE_C: 'rbac.role.c',
  RBAC_ROLE_U: 'rbac.role.u',
  RBAC_ROLE_D: 'rbac.role.d',
  RBAC_ROLE_X0: 'rbac.role.x0',
  RBAC_CATALOG_R: 'rbac.catalog.r',
  RBAC_USER_R: 'rbac.user.r',
  RBAC_USER_U: 'rbac.user.u',

  // Account (rows 57–58)
  ACCOUNT_PROFILE_R: 'account.profile.r',
  ACCOUNT_PROFILE_U: 'account.profile.u',
  ACCOUNT_PASSWORD_U: 'account.password.u',

  // Employee portal (rows 59–72)
  EMP_DASHBOARD_R: 'emp.dashboard.r',
  EMP_PUNCH_C: 'emp.punch.c',
  EMP_PUNCH_U: 'emp.punch.u',
  EMP_PUNCH_X0: 'emp.punch.x0',
  EMP_TEAM_TODAY_R: 'emp.team_today.r',
  EMP_CALENDAR_R: 'emp.calendar.r',
  EMP_WFH_C: 'emp.wfh.c',
  EMP_WFH_R: 'emp.wfh.r',
  EMP_LEAVE_C: 'emp.leave.c',
  EMP_LEAVE_R: 'emp.leave.r',
  EMP_LEAVE_U: 'emp.leave.u',
  EMP_LEAVE_D: 'emp.leave.d',
  EMP_WFH_U: 'emp.wfh.u',
  EMP_WFH_D: 'emp.wfh.d',
  EMP_COMPOFF_C: 'emp.compoff.c',
  EMP_COMPOFF_R: 'emp.compoff.r',
  EMP_COMPOFF_U: 'emp.compoff.u',
  EMP_COMPOFF_D: 'emp.compoff.d',
  EMP_BALANCE_R: 'emp.balance.r',
  EMP_POLICY_SUMMARY_R: 'emp.policy_summary.r',
  EMP_REQUESTS_R: 'emp.requests.r',
  EMP_REQUESTS_X0: 'emp.requests.x0',
  EMP_ATTENDANCE_R: 'emp.attendance.r',
  EMP_PAY_R: 'emp.pay.r',
  EMP_FAQ_R: 'emp.faq.r',
  EMP_TICKET_C: 'emp.ticket.c',
  EMP_TICKET_R: 'emp.ticket.r',
  EMP_TICKET_D: 'emp.ticket.d',
  EMP_TICKET_X0: 'emp.ticket.x0',

  // ── Legacy semantic aliases (same slug values — keeps route/service diffs small) ──
  USERS_READ: 'employees.record.r',
  USERS_WRITE: 'employees.record.u',
  LEAVE_READ: 'emp.leave.r',
  LEAVE_APPLY: 'emp.leave.c',
  LEAVE_APPROVE: 'leave.request.x0',
  LEAVE_MANAGE_POLICIES: 'leave.policy.r',
  LEAVE_READ_TEAM: 'leave.request.r',
  LEAVE_READ_ALL: 'leave.request.r',
  LEAVE_ADJUST_BALANCES: 'leave.adjustment.u',
  SALARY_READ: 'salary.payroll.r',
  SALARY_READ_TEAM: 'salary.team_audit.r',
  SALARY_WRITE: 'salary.structure.u',
  HELP_READ: 'help.ticket.r',
  HELP_WRITE: 'emp.ticket.c',
  HELP_MANAGE: 'help.ticket.u',
  ROLES_MANAGE: 'rbac.role.r',
  OFFICE_MANAGE: 'ops.geofence.r',
  ATTENDANCE_READ_ALL: 'attendance.record.r',
  ATTENDANCE_READ_TEAM: 'attendance.record.r',
  ATTENDANCE_READ_OWN: 'emp.attendance.r',
  AUDIT_READ: 'audit.log.r',
  DEPARTMENTS_MANAGE: 'ops.department.r',
  NOTIFICATIONS_READ: 'portal.employee.r',
  DEMO_FAQ_READ: 'emp.faq.r',
  DEMO_FAQ_MANAGE: 'ops.faq.c',
};

export const ALL_PERMISSIONS = getAllCatalogSlugs();

/** Flat groups for Roles admin checkbox tree (portal → page sections). */
export const PERMISSION_GROUPS = buildPermissionGroups().flatMap((portal) =>
  portal.sections.map((section) => ({
    label: `${portal.label} — ${section.label}`,
    permissions: section.permissions,
  })),
);

/** Catalog tree for GET /api/rbac/catalog (nested portal → navGroup → page). */
export function getPermissionCatalogTree() {
  return buildPermissionGroups();
}

/** Permissions that grant admin-portal login (row 1). */
export const ADMIN_PORTAL_PERMISSIONS = [PERMISSIONS.PORTAL_ADMIN];

/** Permissions that grant employee-portal login (row 2). */
export const EMPLOYEE_PORTAL_PERMISSIONS = [PERMISSIONS.PORTAL_EMPLOYEE];

export const SYSTEM_ROLE_SLUGS = {
  ADMIN: 'admin',
  HR: 'hr',
  REPORTING_MANAGER: 'reporting-manager',
  EMPLOYEE: 'employee',
};

const DEFAULT_ROLE_PERMS = buildDefaultRolePermissions();

export const SYSTEM_ROLES = [
  {
    name: 'Admin',
    slug: SYSTEM_ROLE_SLUGS.ADMIN,
    description: 'Full system access including roles, users, and settings.',
    isSystem: true,
    permissions: DEFAULT_ROLE_PERMS.admin,
  },
  {
    name: 'HR',
    slug: SYSTEM_ROLE_SLUGS.HR,
    description: 'Manage employees, departments, attendance, and leave policies.',
    isSystem: true,
    permissions: DEFAULT_ROLE_PERMS.hr,
  },
  {
    name: 'Reporting Manager',
    slug: SYSTEM_ROLE_SLUGS.REPORTING_MANAGER,
    description: 'Team-scoped attendance, leave approvals, and salary audit.',
    isSystem: true,
    permissions: DEFAULT_ROLE_PERMS['reporting-manager'],
  },
  {
    name: 'Employee',
    slug: SYSTEM_ROLE_SLUGS.EMPLOYEE,
    description: 'Own attendance, leave requests, and help tickets.',
    isSystem: true,
    permissions: DEFAULT_ROLE_PERMS.employee,
  },
];

export const SEED_DEPARTMENTS = [
  { name: 'Development', code: 'DEV' },
  { name: 'Design', code: 'DES' },
  { name: 'GTM', code: 'GTM' },
  { name: 'Strategy', code: 'STR' },
];

export const SEED_LEAVE_TYPES = [
  { code: 'SL', name: 'Sick Leave' },
  { code: 'CL', name: 'Casual Leave' },
  { code: 'EL', name: 'Earned Leave' },
  { code: 'CO', name: 'Compensatory Off' },
  { code: 'WFH', name: 'Work From Home' },
  { code: 'RH', name: 'Restricted Holiday' },
];

export const SEED_LEAVE_POLICIES = [
  { typeCode: 'SL', annualQuota: 7, accrualPerMonth: 0, carryForwardMax: 23, maxAccumulation: 30, requireDocAfterConsecutiveDays: 2, paid: true, encashmentMaxPerYear: 0 },
  { typeCode: 'CL', annualQuota: 7, accrualPerMonth: 0, carryForwardMax: 20, maxAccumulation: 45, requireDocAfterConsecutiveDays: null, paid: true, encashmentMaxPerYear: 10, combinedCarryGroup: 'CL_EL' },
  { typeCode: 'EL', annualQuota: 18, accrualPerMonth: 1.5, carryForwardMax: 20, maxAccumulation: 45, requireDocAfterConsecutiveDays: null, paid: true, encashmentMaxPerYear: 10, combinedCarryGroup: 'CL_EL' },
  { typeCode: 'CO', annualQuota: 0, accrualPerMonth: 0, carryForwardMax: 0, maxAccumulation: 0, requireDocAfterConsecutiveDays: null, paid: true, encashmentMaxPerYear: 0 },
  { typeCode: 'WFH', annualQuota: 30, accrualPerMonth: 0, carryForwardMax: 0, maxAccumulation: 30, requireDocAfterConsecutiveDays: null, paid: true, encashmentMaxPerYear: 0 },
  { typeCode: 'RH', annualQuota: 2, accrualPerMonth: 0, carryForwardMax: 0, maxAccumulation: 2, requireDocAfterConsecutiveDays: null, paid: true, encashmentMaxPerYear: 0 },
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
  const perms = userPermissions ?? [];
  if (perms.includes(permission)) return true;
  // Legacy slug compatibility during migration window
  const legacyMapped = LEGACY_PERMISSION_MAP[permission];
  if (legacyMapped?.some((slug) => perms.includes(slug))) return true;
  return false;
}

export function hasAnyPermission(userPermissions, permissions = []) {
  if (!permissions.length) return true;
  return permissions.some((permission) => hasPermission(userPermissions, permission));
}

export function hasAllPermissions(userPermissions, permissions = []) {
  if (!permissions.length) return true;
  return permissions.every((permission) => hasPermission(userPermissions, permission));
}

export function hasAdminPortalAccess(userPermissions) {
  return hasPermission(userPermissions, PERMISSIONS.PORTAL_ADMIN);
}

export function hasEmployeePortalAccess(userPermissions) {
  return hasPermission(userPermissions, PERMISSIONS.PORTAL_EMPLOYEE);
}

/** Company-wide directory / salary rollup scope (row 5 READ). */
export function hasCompanyWideScope(userPermissions) {
  return hasPermission(userPermissions, COMPANY_WIDE_SCOPE_SLUG);
}

export function canViewSalaryFields(userPermissions) {
  return hasAnyPermission(userPermissions, [
    PERMISSIONS.EMPLOYEES_SALARY_R,
    PERMISSIONS.EMPLOYEES_SALARY_COLUMN_R,
    PERMISSIONS.SALARY_TEAM_AUDIT_R,
    PERMISSIONS.EMP_PAY_R,
  ]);
}

export function canSwitchPortal(userPermissions) {
  return hasPermission(userPermissions, PERMISSIONS.PORTAL_SWITCH);
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

/** Ensure Admin system role retains lockout-protection slugs. */
export function enforceAdminLockPermissions(permissions = []) {
  const set = new Set(permissions);
  for (const slug of ADMIN_LOCK_SLUGS) {
    set.add(slug);
  }
  return normalizePermissions([...set]);
}
