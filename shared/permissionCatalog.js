/**
 * Canonical RBAC permission catalog — 72 rows verified 2026-09-18.
 * Source: .cursor/notes/rbac-permission-catalog-plan-2026-09-18.md
 *
 * Role column values: Y = granted, N = denied, R = granted but team-bounded at API layer.
 */

/** @typedef {'Y'|'N'|'R'} RoleGrant */
/** @typedef {'c'|'r'|'u'|'d'|'x'} ActionKind */

/**
 * @typedef {Object} CatalogRow
 * @property {number} row
 * @property {string} portal
 * @property {string} navGroup
 * @property {string} page
 * @property {string} resource
 * @property {string|null} create
 * @property {string|null} read
 * @property {string|null} update
 * @property {string|null} delete
 * @property {string[]} extras
 * @property {RoleGrant} admin
 * @property {RoleGrant} hr
 * @property {RoleGrant} reportingManager
 * @property {RoleGrant} employee
 * @property {string} [notes]
 */

/** @param {Partial<CatalogRow> & Pick<CatalogRow, 'row'|'portal'|'navGroup'|'page'|'resource'|'admin'|'hr'|'reportingManager'|'employee'>} row */
function row(def) {
  return {
    create: null,
    read: null,
    update: null,
    delete: null,
    extras: [],
    notes: '',
    ...def,
  };
}

/** @type {CatalogRow[]} */
export const PERMISSION_CATALOG = [
  row({ row: 1, portal: 'Admin', navGroup: 'Access', page: 'Portal access', resource: 'Admin portal', read: 'portal.admin.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N', notes: 'Gate for the whole admin shell' }),
  row({ row: 2, portal: 'Admin', navGroup: 'Access', page: 'Portal access', resource: 'Employee portal', read: 'portal.employee.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y', notes: 'Gate for the whole employee shell' }),
  row({ row: 3, portal: 'Admin', navGroup: 'Access', page: 'Portal access', resource: 'Portal switch', read: 'portal.switch.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'N', notes: 'Admin is Ghost Admin, no employee portal' }),
  row({ row: 4, portal: 'Admin', navGroup: 'Overview Cards', page: 'Dashboard', resource: 'Admin dashboard', read: 'dashboard.admin.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 5, portal: 'Admin', navGroup: 'Employees', page: 'Employee List', resource: 'Employee record', create: 'employees.record.c', read: 'employees.record.r', update: 'employees.record.u', delete: 'employees.record.d', extras: ['employees.record.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N', notes: 'R is team-bounded for RM via managed departments' }),
  row({ row: 6, portal: 'Admin', navGroup: 'Employees', page: 'Employee List', resource: 'Employee stats cards', read: 'employees.stats.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 7, portal: 'Admin', navGroup: 'Employees', page: 'Employee List', resource: 'Salary column in list', read: 'employees.salary_column.r', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 8, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Account details', read: 'employees.account.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 9, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Employment details', read: 'employees.employment.r', update: 'employees.employment.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 10, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Salary on employee record', read: 'employees.salary.r', update: 'employees.salary.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 11, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Salary / history block', read: 'employees.salary_history.r', extras: ['employees.salary_history.x0'], admin: 'Y', hr: 'Y', reportingManager: 'R', employee: 'N', notes: 'Month-wise gross, LOP, net' }),
  row({ row: 12, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Login credentials', update: 'employees.credentials.u', extras: ['employees.credentials.x0', 'employees.credentials.x1', 'employees.credentials.x2'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 13, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Employment status', update: 'employees.status.u', extras: ['employees.status.x0', 'employees.status.x1'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 14, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Delegate approver', read: 'employees.delegate.r', update: 'employees.delegate.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 15, portal: 'Admin', navGroup: 'Employees', page: 'Employee Detail', resource: 'Managed departments', read: 'employees.managed_depts.r', update: 'employees.managed_depts.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N', notes: 'THIS defines team scope for every .team permission' }),
  row({ row: 16, portal: 'Admin', navGroup: 'Employees', page: 'Register Employee', resource: 'New employee', create: 'employees.register.c', extras: ['employees.register.x0', 'employees.register.x1', 'employees.register.x2'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 17, portal: 'Admin', navGroup: 'Employees', page: 'Bulk Import', resource: 'Employee directory export', read: 'employees.bulk_export.r', extras: ['employees.bulk_export.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 18, portal: 'Admin', navGroup: 'Employees', page: 'Bulk Import', resource: 'Bulk sync upload', create: 'employees.bulk_upload.c', update: 'employees.bulk_upload.u', extras: ['employees.bulk_upload.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 19, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Monthly Payroll', resource: 'Monthly payroll', read: 'salary.payroll.r', extras: ['salary.payroll.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 20, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Monthly Payroll', resource: 'Payroll detail', read: 'salary.payroll_detail.r', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 21, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Transfers', resource: 'Salary transfer', create: 'salary.transfer.c', read: 'salary.transfer.r', update: 'salary.transfer.u', extras: ['salary.transfer.x0', 'salary.transfer.x1', 'salary.transfer.x2'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 22, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Transfers', resource: 'Month-end settlement', read: 'salary.settlement.r', extras: ['salary.settlement.x0'], admin: 'Y', hr: 'N', reportingManager: 'N', employee: 'N' }),
  row({ row: 23, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Salary History', resource: 'Salary history', read: 'salary.history.r', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 24, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Monthly Audit', resource: 'Monthly salary audit', read: 'salary.audit.r', extras: ['salary.audit.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 25, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Salary Structure', resource: 'Salary structure', read: 'salary.structure.r', update: 'salary.structure.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 26, portal: 'Admin', navGroup: 'Employees', page: 'Salary · Settings', resource: 'Payroll schedule', read: 'salary.schedule.r', update: 'salary.schedule.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 27, portal: 'Admin', navGroup: 'Employees', page: 'Team Salary Audit', resource: 'Team salary audit', read: 'salary.team_audit.r', extras: ['salary.team_audit.x0'], admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N', notes: 'RM sees own team only' }),
  row({ row: 28, portal: 'Admin', navGroup: 'Employees', page: 'Attendance history', resource: 'Attendance record', create: 'attendance.record.c', read: 'attendance.record.r', update: 'attendance.record.u', extras: ['attendance.record.x0', 'attendance.record.x1', 'attendance.record.x2'], admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 29, portal: 'Admin', navGroup: 'Employees', page: 'Attendance history', resource: 'Attendance event log', read: 'attendance.log.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 30, portal: 'Admin', navGroup: 'Employees', page: 'Attendance history', resource: 'Quarter warning column', read: 'attendance.warning_col.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 31, portal: 'Admin', navGroup: 'Employees', page: 'Today present', resource: 'Today present board', read: 'attendance.today.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 32, portal: 'Admin', navGroup: 'Employees', page: 'Login Logs', resource: 'Audit log', read: 'audit.log.r', extras: ['audit.log.x0', 'audit.log.x1'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 33, portal: 'Admin', navGroup: 'Employees', page: 'Login Logs', resource: 'Login event PII', read: 'audit.log_pii.r', admin: 'Y', hr: 'N', reportingManager: 'N', employee: 'N' }),
  row({ row: 34, portal: 'Admin', navGroup: 'Employees', page: 'Help tickets', resource: 'Help ticket queue', read: 'help.ticket.r', update: 'help.ticket.u', delete: 'help.ticket.d', extras: ['help.ticket.x0', 'help.ticket.x1', 'help.ticket.x2'], admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N', notes: 'RM sees team queue only' }),
  row({ row: 35, portal: 'Admin', navGroup: 'Leaves', page: 'Leave policies', resource: 'Leave type', create: 'leave.type.c', read: 'leave.type.r', update: 'leave.type.u', delete: 'leave.type.d', extras: ['leave.type.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 36, portal: 'Admin', navGroup: 'Leaves', page: 'Leave policies', resource: 'Leave policy', create: 'leave.policy.c', read: 'leave.policy.r', update: 'leave.policy.u', delete: 'leave.policy.d', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 37, portal: 'Admin', navGroup: 'Leaves', page: 'Leave policies', resource: 'Employee leave adjustment', read: 'leave.adjustment.r', update: 'leave.adjustment.u', extras: ['leave.adjustment.x0', 'leave.adjustment.x1'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 38, portal: 'Admin', navGroup: 'Leaves', page: 'Pending Requests', resource: 'Leave request', read: 'leave.request.r', extras: ['leave.request.x0', 'leave.request.x1'], admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 39, portal: 'Admin', navGroup: 'Leaves', page: 'Pending Requests', resource: 'WFH request', read: 'leave.wfh.r', extras: ['leave.wfh.x0', 'leave.wfh.x1'], admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 40, portal: 'Admin', navGroup: 'Leaves', page: 'Pending Requests', resource: 'Comp off request', read: 'leave.compoff.r', extras: ['leave.compoff.x0', 'leave.compoff.x1'], admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 41, portal: 'Admin', navGroup: 'Leaves', page: 'Late Warning', resource: 'Late warning', read: 'attendance.late_warning.r', extras: ['attendance.late_warning.x0', 'attendance.late_warning.x1'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 42, portal: 'Admin', navGroup: 'Leaves', page: 'Calendar management', resource: 'Holiday entry', create: 'leave.holiday.c', read: 'leave.holiday.r', update: 'leave.holiday.u', delete: 'leave.holiday.d', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 43, portal: 'Admin', navGroup: 'Leaves', page: 'Calendar management', resource: 'Holiday category', create: 'leave.category.c', read: 'leave.category.r', update: 'leave.category.u', delete: 'leave.category.d', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 44, portal: 'Admin', navGroup: 'Leaves', page: 'Calendar management', resource: 'Recurring rule', create: 'leave.recurring.c', read: 'leave.recurring.r', update: 'leave.recurring.u', delete: 'leave.recurring.d', extras: ['leave.recurring.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 45, portal: 'Admin', navGroup: 'Operations', page: 'Geolocation and Timings', resource: 'Office geofence', read: 'ops.geofence.r', update: 'ops.geofence.u', extras: ['ops.geofence.x0'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 46, portal: 'Admin', navGroup: 'Operations', page: 'Geolocation and Timings', resource: 'Office hours and thresholds', read: 'ops.hours.r', update: 'ops.hours.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 47, portal: 'Admin', navGroup: 'Operations', page: 'Geolocation and Timings', resource: 'Weekend days', read: 'ops.weekend.r', update: 'ops.weekend.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 48, portal: 'Admin', navGroup: 'Operations', page: 'Geolocation and Timings', resource: 'Sandwich leave policy', read: 'ops.sandwich.r', update: 'ops.sandwich.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 49, portal: 'Admin', navGroup: 'Operations', page: 'Geolocation and Timings', resource: 'Warnings per quarter', read: 'ops.warning_limit.r', update: 'ops.warning_limit.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 50, portal: 'Admin', navGroup: 'Operations', page: 'Geolocation and Timings', resource: 'Auto-checkout timings', read: 'ops.autocheckout.r', update: 'ops.autocheckout.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 51, portal: 'Admin', navGroup: 'Operations', page: 'FAQ and Demo', resource: 'FAQ or demo item', create: 'ops.faq.c', read: 'ops.faq.r', update: 'ops.faq.u', delete: 'ops.faq.d', extras: ['ops.faq.x0', 'ops.faq.x1'], admin: 'Y', hr: 'N', reportingManager: 'N', employee: 'N' }),
  row({ row: 52, portal: 'Admin', navGroup: 'Operations', page: 'FAQ and Demo', resource: 'Admin user guide', read: 'ops.guide.r', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 53, portal: 'Admin', navGroup: 'Operations', page: 'Departments', resource: 'Department', create: 'ops.department.c', read: 'ops.department.r', update: 'ops.department.u', delete: 'ops.department.d', extras: ['ops.department.x0', 'ops.department.x1', 'ops.department.x2'], admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 54, portal: 'Admin', navGroup: 'Operations', page: 'Roles and Permissions', resource: 'Role', create: 'rbac.role.c', read: 'rbac.role.r', update: 'rbac.role.u', delete: 'rbac.role.d', extras: ['rbac.role.x0'], admin: 'Y', hr: 'N', reportingManager: 'N', employee: 'N', notes: 'Admin role must stay locked' }),
  row({ row: 55, portal: 'Admin', navGroup: 'Operations', page: 'Roles and Permissions', resource: 'Permission catalog', read: 'rbac.catalog.r', admin: 'Y', hr: 'N', reportingManager: 'N', employee: 'N' }),
  row({ row: 56, portal: 'Admin', navGroup: 'Operations', page: 'Roles and Permissions', resource: 'User', read: 'rbac.user.r', update: 'rbac.user.u', admin: 'Y', hr: 'Y', reportingManager: 'N', employee: 'N' }),
  row({ row: 57, portal: 'Admin', navGroup: 'Account', page: 'Account settings', resource: 'Own profile', read: 'account.profile.r', update: 'account.profile.u', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 58, portal: 'Admin', navGroup: 'Account', page: 'Account settings', resource: 'Own password', update: 'account.password.u', admin: 'Y', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 59, portal: 'Employee', navGroup: 'Overview', page: 'Dashboard', resource: 'Employee dashboard', read: 'emp.dashboard.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 60, portal: 'Employee', navGroup: 'Overview', page: 'Dashboard', resource: 'Own check-in and check-out', create: 'emp.punch.c', update: 'emp.punch.u', extras: ['emp.punch.x0'], admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 61, portal: 'Employee', navGroup: 'Overview', page: 'Dashboard', resource: 'Team attendance today', read: 'emp.team_today.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'N' }),
  row({ row: 62, portal: 'Employee', navGroup: 'Overview', page: 'Dashboard', resource: 'Own attendance calendar', read: 'emp.calendar.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 63, portal: 'Employee', navGroup: 'Leave', page: 'Apply WFH', resource: 'Own WFH request', create: 'emp.wfh.c', read: 'emp.wfh.r', update: 'emp.wfh.u', delete: 'emp.wfh.d', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 64, portal: 'Employee', navGroup: 'Leave', page: 'Apply leave', resource: 'Own leave request', create: 'emp.leave.c', read: 'emp.leave.r', update: 'emp.leave.u', delete: 'emp.leave.d', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 65, portal: 'Employee', navGroup: 'Leave', page: 'Request comp off', resource: 'Own comp off request', create: 'emp.compoff.c', read: 'emp.compoff.r', update: 'emp.compoff.u', delete: 'emp.compoff.d', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 66, portal: 'Employee', navGroup: 'Leave', page: 'Leave balances', resource: 'Own leave balance', read: 'emp.balance.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 67, portal: 'Employee', navGroup: 'Leave', page: 'Leave balances', resource: 'Company policy summary', read: 'emp.policy_summary.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 68, portal: 'Employee', navGroup: 'Leave', page: 'My requests', resource: 'Own request history', read: 'emp.requests.r', extras: ['emp.requests.x0'], admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 69, portal: 'Employee', navGroup: 'Attendance', page: 'Attendance history', resource: 'Own attendance history', read: 'emp.attendance.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 70, portal: 'Employee', navGroup: 'Payroll', page: 'My pay estimate', resource: 'Own pay estimate', read: 'emp.pay.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 71, portal: 'Employee', navGroup: 'Support', page: 'FAQ and Demo', resource: 'FAQ and demo (employee)', read: 'emp.faq.r', admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
  row({ row: 72, portal: 'Employee', navGroup: 'Support', page: 'Help', resource: 'Own help ticket', create: 'emp.ticket.c', read: 'emp.ticket.r', delete: 'emp.ticket.d', extras: ['emp.ticket.x0'], admin: 'N', hr: 'Y', reportingManager: 'Y', employee: 'Y' }),
];

const ROLE_KEYS = ['admin', 'hr', 'reportingManager', 'employee'];

/**
 * Catalog rows assignable when editing the Employee system role in Roles admin.
 * Employee-portal resources, shared account.* profile/password, and portal.employee.r gate.
 */
export function catalogRowMatchesEmployeeRoleEditor(catalogRow) {
  if (catalogRow.portal === 'Employee') return true;
  for (const slug of slugsFromRow(catalogRow)) {
    if (slug.startsWith('account.')) return true;
    if (slug === 'portal.employee.r') return true;
  }
  return false;
}

/**
 * Filter catalog rows for the Roles modal by system role slug.
 * Employee → employee portal + account.* + portal.employee.r.
 * Admin → admin portal only (Ghost Admin — no emp.*).
 * HR, Reporting Manager, custom → full dual-portal catalog.
 */
export function filterCatalogForRole(catalog, roleSlug) {
  if (roleSlug === 'employee') {
    return catalog.filter(catalogRowMatchesEmployeeRoleEditor);
  }
  if (roleSlug === 'admin') {
    return catalog.filter((row) => row.portal === 'Admin');
  }
  return catalog;
}

/** Extract all slugs from a catalog row. */
export function slugsFromRow(catalogRow) {
  const slugs = [];
  for (const key of ['create', 'read', 'update', 'delete']) {
    if (catalogRow[key]) slugs.push(catalogRow[key]);
  }
  if (catalogRow.extras?.length) slugs.push(...catalogRow.extras);
  return slugs;
}

/** All unique permission slugs in catalog order. */
export function getAllCatalogSlugs() {
  const seen = new Set();
  const ordered = [];
  for (const catalogRow of PERMISSION_CATALOG) {
    for (const slug of slugsFromRow(catalogRow)) {
      if (!seen.has(slug)) {
        seen.add(slug);
        ordered.push(slug);
      }
    }
  }
  return ordered;
}

/** Metadata lookup keyed by slug. */
export function buildPermissionMetadataMap() {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const catalogRow of PERMISSION_CATALOG) {
    for (const slug of slugsFromRow(catalogRow)) {
      const action = slug.split('.').pop();
      map.set(slug, {
        slug,
        row: catalogRow.row,
        portal: catalogRow.portal,
        navGroup: catalogRow.navGroup,
        page: catalogRow.page,
        resource: catalogRow.resource,
        action,
        actionKind: action.length === 1 ? action : action.startsWith('x') ? 'x' : action,
        notes: catalogRow.notes ?? '',
        teamBounded: {
          admin: catalogRow.admin === 'R',
          hr: catalogRow.hr === 'R',
          reportingManager: catalogRow.reportingManager === 'R',
          employee: catalogRow.employee === 'R',
        },
      });
    }
  }
  return map;
}

/** Default permission arrays per system role slug. */
export function buildDefaultRolePermissions() {
  /** @type {Record<string, string[]>} */
  const result = {
    admin: [],
    hr: [],
    'reporting-manager': [],
    employee: [],
  };

  const roleMap = {
    admin: 'admin',
    hr: 'hr',
    'reporting-manager': 'reportingManager',
    employee: 'employee',
  };

  for (const catalogRow of PERMISSION_CATALOG) {
    for (const slug of slugsFromRow(catalogRow)) {
      for (const [systemSlug, catalogKey] of Object.entries(roleMap)) {
        const grant = catalogRow[catalogKey];
        if (grant === 'Y' || grant === 'R') {
          result[systemSlug].push(slug);
        }
      }
    }
  }

  for (const key of Object.keys(result)) {
    result[key] = [...new Set(result[key])].sort();
  }
  return result;
}

/** Checkbox tree for Roles & Permissions admin UI. */
export function buildPermissionGroups() {
  /** @type {Map<string, { label: string, pages: Map<string, { label: string, permissions: object[] }> }>} */
  const portalMap = new Map();

  for (const catalogRow of PERMISSION_CATALOG) {
    const portalKey = catalogRow.portal;
    if (!portalMap.has(portalKey)) {
      portalMap.set(portalKey, { label: portalKey, pages: new Map() });
    }
    const portal = portalMap.get(portalKey);
    const pageKey = `${catalogRow.navGroup} — ${catalogRow.page}`;
    if (!portal.pages.has(pageKey)) {
      portal.pages.set(pageKey, { label: pageKey, permissions: [] });
    }
    const page = portal.pages.get(pageKey);

    for (const slug of slugsFromRow(catalogRow)) {
      const action = slug.split('.').pop();
      const actionLabel = action.length === 1
        ? { c: 'Create', r: 'Read', u: 'Update', d: 'Delete' }[action] ?? action
        : action.startsWith('x') ? `Action ${action.slice(1)}` : action;
      page.permissions.push({
        key: slug,
        label: `${catalogRow.resource} — ${actionLabel}`,
        resource: catalogRow.resource,
        row: catalogRow.row,
      });
    }
  }

  return [...portalMap.values()].map((portal) => ({
    label: portal.label,
    sections: [...portal.pages.values()].map((page) => ({
      label: page.label,
      permissions: page.permissions,
    })),
  }));
}

/** Slugs that must remain on the Admin system role (lockout protection). */
export const ADMIN_LOCK_SLUGS = [
  'portal.admin.r',
  'rbac.role.r',
  'rbac.catalog.r',
  'employees.managed_depts.r',
  'employees.managed_depts.u',
];

/** Legacy pre-catalog slugs → replacement catalog slugs (for DB migration). */
export const LEGACY_PERMISSION_MAP = {
  'users.read': [
    'employees.record.r', 'employees.stats.r', 'employees.account.r', 'rbac.user.r',
    'employees.employment.r', 'employees.delegate.r',
  ],
  'users.write': [
    'employees.record.c', 'employees.record.u', 'employees.register.c', 'employees.bulk_upload.c',
    'employees.bulk_upload.u', 'employees.credentials.u', 'employees.status.u', 'employees.employment.u',
    'employees.delegate.u', 'employees.managed_depts.u', 'employees.salary.u', 'rbac.user.u',
  ],
  'leave.read': ['emp.leave.r', 'emp.wfh.r', 'emp.compoff.r', 'emp.balance.r', 'emp.requests.r', 'emp.policy_summary.r'],
  'leave.apply': ['emp.leave.c', 'emp.wfh.c', 'emp.compoff.c'],
  'leave.approve': ['leave.request.x0', 'leave.wfh.x0', 'leave.compoff.x0'],
  'leave.manage_policies': [
    'leave.type.r', 'leave.type.c', 'leave.type.u', 'leave.type.d', 'leave.policy.r', 'leave.policy.c',
    'leave.policy.u', 'leave.policy.d', 'leave.holiday.r', 'leave.holiday.c', 'leave.holiday.u',
    'leave.holiday.d', 'leave.category.r', 'leave.recurring.r',
  ],
  'leave.read_team': ['leave.request.r', 'leave.wfh.r', 'leave.compoff.r'],
  'leave.read_all': ['leave.request.r', 'leave.wfh.r', 'leave.compoff.r'],
  'leave.adjust_balances': ['leave.adjustment.r', 'leave.adjustment.u'],
  'salary.read': ['salary.payroll.r', 'salary.history.r', 'salary.audit.r', 'emp.pay.r'],
  'salary.read_team': ['salary.team_audit.r', 'employees.salary_history.r'],
  'salary.write': [
    'salary.structure.u', 'salary.schedule.u', 'salary.transfer.c', 'salary.transfer.u',
    'employees.salary.u',
  ],
  'help.read': ['help.ticket.r', 'emp.ticket.r'],
  'help.write': ['emp.ticket.c'],
  'help.manage': ['help.ticket.u', 'help.ticket.d'],
  'roles.manage': ['rbac.role.r', 'rbac.role.c', 'rbac.role.u', 'rbac.role.d', 'rbac.catalog.r'],
  'office.manage': [
    'ops.geofence.r', 'ops.geofence.u', 'ops.hours.r', 'ops.hours.u', 'ops.weekend.r',
    'ops.weekend.u', 'ops.sandwich.r', 'ops.sandwich.u', 'ops.warning_limit.r', 'ops.autocheckout.r',
  ],
  'attendance.read_all': ['attendance.record.r', 'attendance.log.r', 'attendance.today.r', 'attendance.warning_col.r'],
  'attendance.read_team': ['attendance.record.r', 'attendance.log.r', 'attendance.today.r', 'attendance.warning_col.r'],
  'attendance.read_own': ['emp.attendance.r', 'emp.punch.c', 'emp.punch.u', 'emp.calendar.r'],
  'audit.read': ['audit.log.r'],
  'departments.manage': ['ops.department.r', 'ops.department.c', 'ops.department.u', 'ops.department.d'],
  'notifications.read': ['portal.employee.r', 'portal.admin.r'],
  'demo_faq.read': ['emp.faq.r', 'ops.faq.r', 'ops.guide.r'],
  'demo_faq.manage': ['ops.faq.c', 'ops.faq.u', 'ops.faq.d'],
};

/** Migrate a role's permission array from legacy slugs to catalog slugs. */
export function migrateLegacyPermissions(permissions = []) {
  const catalogSlugs = new Set(getAllCatalogSlugs());
  const result = new Set();

  for (const key of permissions) {
    if (catalogSlugs.has(key)) {
      result.add(key);
      continue;
    }
    const mapped = LEGACY_PERMISSION_MAP[key];
    if (mapped?.length) {
      mapped.forEach((slug) => result.add(slug));
    }
  }

  return [...result].sort();
}

export { ROLE_KEYS };
