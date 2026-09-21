/**
 * Generates attendance portal TARGET RBAC matrix (enterprise spec for team-lead sign-off).
 * Values reflect how the portal SHOULD work — not current code/seed defaults.
 *
 * Admin role = ghost account (admin portal only). The real person uses a separate
 * Employee login for check-in, leave, pay, etc. Portal switch is hidden for Admin.
 *
 * Run from repo root: node server/scripts/dev/generate-rbac-matrix.mjs
 */
import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_GROUPS, PERMISSIONS } from '../../../shared/permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(
  __dirname,
  '../../../.cursor/notes/attendance-portal-rbac-matrix.xlsx',
);

const ROLES = ['Admin', 'HR', 'Reporting Manager', 'Employee'];
const Y = 'Yes';
const N = 'No';

/** @param {string} label @param {string} admin @param {string} hr @param {string} rm @param {string} emp */
function row(label, admin, hr, rm, emp) {
  return {
    label,
    values: {
      Admin: admin,
      HR: hr,
      'Reporting Manager': rm,
      Employee: emp,
    },
  };
}

/** Target permission grants (enterprise RBAC — dynamic Role document is source of truth). */
const TARGET_PERM = {
  [PERMISSIONS.USERS_READ]: [Y, Y, Y, N],
  [PERMISSIONS.USERS_WRITE]: [Y, Y, N, N],
  [PERMISSIONS.DEPARTMENTS_MANAGE]: [Y, Y, N, N],
  [PERMISSIONS.ROLES_MANAGE]: [Y, N, N, N],
  [PERMISSIONS.ATTENDANCE_READ_OWN]: [N, Y, Y, Y],
  [PERMISSIONS.ATTENDANCE_READ_TEAM]: [Y, N, Y, N],
  [PERMISSIONS.ATTENDANCE_READ_ALL]: [Y, Y, N, N],
  [PERMISSIONS.LEAVE_READ]: [N, Y, Y, Y],
  [PERMISSIONS.LEAVE_APPLY]: [N, Y, Y, Y],
  [PERMISSIONS.LEAVE_APPROVE]: [Y, Y, Y, N],
  [PERMISSIONS.LEAVE_READ_TEAM]: [Y, N, Y, N],
  [PERMISSIONS.LEAVE_READ_ALL]: [Y, Y, N, N],
  [PERMISSIONS.LEAVE_MANAGE_POLICIES]: [Y, Y, N, N],
  [PERMISSIONS.LEAVE_ADJUST_BALANCES]: [Y, Y, N, N],
  [PERMISSIONS.SALARY_READ]: [Y, Y, Y, Y],
  [PERMISSIONS.SALARY_READ_TEAM]: [Y, N, Y, N],
  [PERMISSIONS.SALARY_WRITE]: [Y, Y, N, N],
  [PERMISSIONS.HELP_READ]: [N, Y, Y, Y],
  [PERMISSIONS.HELP_WRITE]: [N, Y, Y, Y],
  [PERMISSIONS.HELP_MANAGE]: [Y, Y, Y, N],
  [PERMISSIONS.AUDIT_READ]: [Y, Y, N, N],
  [PERMISSIONS.OFFICE_MANAGE]: [Y, Y, N, N],
  [PERMISSIONS.NOTIFICATIONS_READ]: [Y, Y, Y, Y],
  [PERMISSIONS.DEMO_FAQ_READ]: [Y, Y, Y, Y],
  [PERMISSIONS.DEMO_FAQ_MANAGE]: [Y, N, N, N],
};

function permRow(groupLabel, permLabel, permKey) {
  const [a, h, r, e] = TARGET_PERM[permKey] ?? [N, N, N, N];
  return row(`${groupLabel} — ${permLabel}`, a, h, r, e);
}

/**
 * Sheet tabs follow nav.js section names where possible; dedicated tabs restored
 * for Salary LOP Audit, Audit Logs, Notifications, Table Preferences, etc.
 * Row labels match client/src/config/nav.js and pageMeta.js exactly.
 */
const SHEETS = [
  {
    name: 'Roles & Permissions',
    rows: [
      row('Admin portal login', Y, Y, Y, N),
      row('Employee portal login', N, Y, Y, Y),
      row(
        'Ghost Admin account (admin portal only; personal life on separate Employee login)',
        Y,
        N,
        N,
        N,
      ),
      row('Portal switch UI (hidden for Admin ghost account)', N, Y, Y, N),
      row('Permissions loaded from Role document (dynamic)', Y, Y, Y, Y),
      row('Permission changes apply immediately (UI + API)', Y, Y, Y, Y),
      row('Create and edit custom roles', Y, N, N, N),
      row('Edit system role permissions (except Admin lock)', Y, N, N, N),
      row('Company salary rollup (Admin and HR only; RM uses team salary)', Y, Y, N, N),
      row('Roles & Permissions', Y, N, N, N),
      ...PERMISSION_GROUPS.flatMap((group) =>
        group.permissions.map((p) => permRow(group.label, p.label, p.key)),
      ),
    ],
  },
  {
    name: 'Account',
    rows: [
      row('Admin portal login', Y, Y, Y, N),
      row('Employee portal login', N, Y, Y, Y),
      row('Switch Admin and Employee portal', N, Y, Y, N),
      row('Session refresh and logout', Y, Y, Y, Y),
      row('Account settings', Y, Y, Y, N),
      row('Account settings', N, Y, Y, Y),
      row('Change password', Y, Y, Y, Y),
      row('Set or change PIN (self-service)', Y, Y, Y, Y),
      row('Forgot / reset password (public)', Y, Y, Y, Y),
    ],
  },
  {
    name: 'Overview',
    rows: [
      row('Dashboard', Y, Y, Y, N),
      row('Dashboard', N, Y, Y, Y),
      row('Reports summary (scoped by role)', Y, Y, Y, N),
      row('Pending approvals badge', Y, Y, Y, N),
      row('Default landing route respects role permissions', Y, Y, Y, N),
      row('Dashboard: Check-in / check-out', N, Y, Y, Y),
      row('Dashboard: Team today strip (direct reports)', N, N, Y, N),
    ],
  },
  {
    name: 'Employees',
    rows: [
      row('Employee List (company-wide)', Y, Y, N, N),
      row('Employee List (direct reports only)', N, N, Y, N),
      row('Employee details (company-wide)', Y, Y, N, N),
      row('Employee details (direct reports only)', N, N, Y, N),
      row('Register Employee', Y, Y, N, N),
      row('Register New Employee', Y, Y, N, N),
      row('Bulk Import', Y, Y, N, N),
      row('Bulk Employee Sync: preview before sync', Y, Y, N, N),
      row('Bulk Employee Sync: download template', Y, Y, N, N),
      row('Employee details: Update employee profile', Y, Y, N, N),
      row('Employee details: Assign delegate approver', Y, Y, N, N),
      row('Employee details: Reset employee password', Y, Y, N, N),
      row('Employee details: Reset employee PIN', Y, Y, N, N),
      row('Register New Employee: Send credentials email', Y, Y, N, N),
      row('Employee details: Deactivate / reactivate employee', Y, Y, N, N),
      row('Employee List: Employee stats cards', Y, Y, Y, N),
      row('Employee List: List managers picker', Y, Y, Y, N),
      row('Employee List: Salary column visibility', Y, Y, Y, N),
      row('Employee details: Manage salary on employee record', Y, Y, N, N),
    ],
  },
  {
    name: 'Leaves',
    rows: [
      row('Leave balances', N, Y, Y, Y),
      row('Apply leave', N, Y, Y, Y),
      row('Apply WFH', N, Y, Y, Y),
      row('Request comp off', N, Y, Y, Y),
      row('My requests', N, Y, Y, Y),
      row('My requests: Edit / cancel / withdraw own request', N, Y, Y, Y),
      row('Leave policies', Y, Y, N, N),
      row('Pending Requests', Y, Y, Y, N),
      row('Comp off requests', Y, Y, Y, N),
      row('Pending Requests: Assess comp off', Y, Y, Y, N),
      row('Pending Requests: Approve (direct reports + delegate)', N, N, Y, N),
      row('Pending Requests: Approve (company-wide)', Y, Y, N, N),
      row('Leave policies: Leave admin exception (policy override)', Y, Y, N, N),
      row('Calendar management', Y, Y, N, N),
      row('Calendar management: Holiday categories CRUD', Y, Y, N, N),
      row('Leave policies: Create / update leave types', Y, Y, N, N),
      row('Leave policies: Create / update leave policies', Y, Y, N, N),
      row('Pending Requests: View all leave requests (company)', Y, Y, N, N),
      row('Pending Requests: View team leave requests (direct reports)', N, N, Y, N),
      row('Leave policies: Adjust leave balances', Y, Y, N, N),
      row('Leave policies: Leave balance history (per employee)', Y, Y, N, N),
      row('Leave policies: Bulk leave balance upload', Y, Y, N, N),
      row('Leave policies: Leave encashment', Y, Y, N, N),
      row('Leave policies: Year-end carry forward', Y, Y, N, N),
      row('Leave policies: Run accrual job (manual trigger)', Y, Y, N, N),
      row('Salary Calculation / LOP: LOP records (company-wide)', Y, Y, N, N),
      row('Salary Calculation / LOP: LOP records (direct reports only)', N, N, Y, N),
      row('Pending Requests: Email decision link (token, no login)', Y, Y, Y, Y),
      row('Late Warning', Y, Y, Y, N),
    ],
  },
  {
    name: 'Attendance',
    rows: [
      row('Attendance history', N, Y, Y, Y),
      row('Attendance history: Month attendance summary (own)', N, Y, Y, Y),
      row('Attendance history: Quarter warnings (own)', N, Y, Y, Y),
      row('Attendance history: Undo check-in / check-out', N, Y, Y, Y),
      row('Attendance history', Y, Y, Y, N),
      row('Attendance history (company-wide list)', Y, Y, N, N),
      row('Attendance history (direct reports list)', N, N, Y, N),
      row('Attendance history: Create / edit attendance records', Y, Y, Y, N),
      row('Attendance history: Confirm / undo attendance confirmation', Y, Y, Y, N),
      row('Attendance history: Week attendance confirmation', Y, Y, Y, N),
      row('Attendance history: Reset quarter warnings (scoped)', Y, Y, Y, N),
      row('Today present', Y, Y, Y, N),
      row('Late Warning: Quarter warnings summary (admin)', Y, Y, Y, N),
      row('Geolocation & Timings: Read office settings (attendance context)', Y, Y, Y, N),
    ],
  },
  {
    name: 'Salary LOP Audit',
    rows: [
      row('My pay estimate', N, Y, Y, Y),
      row('Salary Summary (company-wide)', Y, Y, N, N),
      row('Salary Calculation / LOP (company-wide)', Y, Y, N, N),
      row('Team Salary Audit', N, N, Y, N),
      row('Salary Calculation / LOP: Single employee LOP detail (company-wide)', Y, Y, N, N),
      row('Salary Calculation / LOP: Single employee LOP detail (direct reports)', N, N, Y, N),
      row('Salary Management: Salary History tab (company-wide)', Y, Y, N, N),
      row('Salary Management: Salary History tab (direct reports only)', N, N, Y, N),
      row('Employee details: Salary / History (company-wide)', Y, Y, N, N),
      row('Employee details: Salary / History (direct reports only)', N, N, Y, N),
      row('Salary Summary: Export salary Excel (company)', Y, Y, N, N),
      row('Salary Calculation / LOP: Export LOP bulk (company)', Y, Y, N, N),
      row('Salary Calculation / LOP: Export LOP single (direct reports)', N, N, Y, N),
      row('Team Salary Audit: Export salary audit (company)', Y, Y, N, N),
      row('Team Salary Audit: Export salary audit (team)', N, N, Y, N),
      row('Salary Management: Update employee salary', Y, Y, N, N),
      row('Salary Management: Salary settings', Y, Y, N, N),
      row('Salary Management: Month-end settle', Y, Y, N, N),
      row('Salary Management: Generate salary transfers', Y, Y, N, N),
    ],
  },
  {
    name: 'Operations',
    rows: [
      row('Geolocation & Timings', Y, Y, N, N),
      row('Geolocation & Timings: Update office settings', Y, Y, N, N),
      row('Geolocation & Timings: Read office settings (display only)', Y, Y, Y, N),
      row('Departments', Y, Y, N, N),
      row('Departments: List departments (picker)', Y, Y, Y, N),
      row('Departments: Create / update / delete department', Y, Y, N, N),
      row('Roles & Permissions: List permission catalog', Y, N, N, N),
      row('Register New Employee: List roles (dropdown)', Y, Y, N, N),
    ],
  },
  {
    name: 'Help and Support',
    rows: [
      row('Help: View own help tickets', N, Y, Y, Y),
      row('Help: Create help ticket', N, Y, Y, Y),
      row('Team issues', N, N, Y, N),
      row('Help tickets', Y, Y, N, N),
      row('Help tickets: Update ticket status', Y, Y, Y, N),
      row('Help: Delete own help ticket', N, Y, Y, Y),
      row('Help: Download help ticket attachments', N, Y, Y, Y),
    ],
  },
  {
    name: 'Audit Logs',
    rows: [
      row('Login Logs', Y, Y, N, N),
      row('Audit Logs: List audit logs', Y, Y, N, N),
      row('Audit Logs: Export audit logs', Y, Y, N, N),
      row('Audit Logs: Audit archive status / run', Y, N, N, N),
    ],
  },
  {
    name: 'Notifications',
    rows: [
      row('Notifications bell', Y, Y, Y, Y),
      row('Notifications: List notifications', Y, Y, Y, Y),
      row('Notifications: Unread count', Y, Y, Y, Y),
      row('Notifications: Mark read / clear all', Y, Y, Y, Y),
    ],
  },
  {
    name: 'Demo FAQ',
    rows: [
      row('FAQ & Demo: View FAQ items (role-filtered)', Y, Y, Y, Y),
      row('FAQ & Demo: Manage all items (admin view)', Y, N, N, N),
      row('FAQ & Demo: Create / update / delete FAQ item', Y, N, N, N),
      row('FAQ & Demo', Y, Y, Y, N),
      row('FAQ & Demo', N, Y, Y, Y),
    ],
  },
  {
    name: 'Scope and Access',
    rows: [
      row('Company-wide scope (attendance, leave, salary)', Y, Y, N, N),
      row('Team scope (direct reports + delegate chain)', N, N, Y, N),
      row('Own self-service scope only', N, N, N, Y),
      row('Ghost Admin (admin portal only on Admin role login)', Y, N, N, N),
      row('Dual portal (admin shell + employee shell)', N, Y, Y, N),
      row('Help tickets (company help queue)', Y, Y, N, N),
      row('Team issues (team help queue)', N, N, Y, N),
      row('My pay estimate (own pay estimate only)', N, N, N, Y),
    ],
  },
  {
    name: 'Table Preferences',
    rows: [
      row('Edit columns', Y, Y, Y, Y),
      row('Edit columns: Save column layout', Y, Y, Y, Y),
      row('Edit columns: Salary column visibility (employee list)', Y, Y, Y, N),
      row('Edit columns: Employee code column (today present)', Y, Y, Y, N),
    ],
  },
  {
    name: 'Payroll',
    rows: [
      row('My pay estimate', N, Y, Y, Y),
    ],
  },
  {
    name: 'Support',
    rows: [
      row('Help', N, Y, Y, Y),
      row('FAQ & Demo', N, Y, Y, Y),
    ],
  },
];

const HEADER_GREEN = 'FF1B5E20';
const HEADER_GREEN_LIGHT = 'FF2E7D32';
const WHITE = 'FFFFFFFF';
const ROW_EVEN = 'FFF1F8E9';
const ROW_ODD = 'FFFFFFFF';
const BORDER_COLOR = 'FFC8E6C9';
const YES_FILL = 'FFE8F5E9';
const NO_FILL = 'FFFFEBEE';

function applyHeaderStyle(row, colCount) {
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: c === 1 ? HEADER_GREEN : HEADER_GREEN_LIGHT },
    };
    cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: BORDER_COLOR } },
      left: { style: 'thin', color: { argb: BORDER_COLOR } },
      bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
      right: { style: 'thin', color: { argb: BORDER_COLOR } },
    };
  }
  row.height = 24;
}

function styleValueCell(cell, value) {
  const fill = value === Y ? YES_FILL : NO_FILL;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  cell.font = { bold: value === Y, size: 10 };
  cell.border = {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  };
}

function styleDataRow(row, rowIndex, colCount) {
  const bg = rowIndex % 2 === 0 ? ROW_EVEN : ROW_ODD;
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    if (c === 1) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
      cell.font = { size: 10 };
    } else if (c <= ROLES.length + 1) {
      styleValueCell(cell, cell.value);
      continue;
    } else {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.font = { size: 10 };
    }
    cell.border = {
      top: { style: 'thin', color: { argb: BORDER_COLOR } },
      left: { style: 'thin', color: { argb: BORDER_COLOR } },
      bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
      right: { style: 'thin', color: { argb: BORDER_COLOR } },
    };
  }
  row.height = 28;
}

function buildSheet(workbook, sheetDef) {
  const safeName = sheetDef.name.slice(0, 31);
  const sheet = workbook.addWorksheet(safeName, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 18 },
  });

  const headers = ['Feature / Action', ...ROLES, 'Status'];
  const colCount = headers.length;

  const headerRow = sheet.getRow(1);
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h;
  });
  applyHeaderStyle(headerRow, colCount);

  sheetDef.rows.forEach((rowDef, idx) => {
    const dataRow = sheet.getRow(2 + idx);
    dataRow.getCell(1).value = rowDef.label;
    ROLES.forEach((role, i) => {
      dataRow.getCell(2 + i).value = rowDef.values[role];
    });
    dataRow.getCell(ROLES.length + 2).value = '';
    styleDataRow(dataRow, idx, colCount);
  });

  sheet.getColumn(1).width = 52;
  ROLES.forEach((_, i) => {
    sheet.getColumn(2 + i).width = 18;
  });
  sheet.getColumn(ROLES.length + 2).width = 14;

  if (sheetDef.rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1 + sheetDef.rows.length, column: colCount },
    };
  }

  return sheetDef.rows.length;
}

function findAccountSettingsRow(sheetName, adminValue) {
  return SHEETS.find((s) => s.name === sheetName)?.rows.find(
    (r) => r.label === 'Account settings' && r.values.Admin === adminValue,
  );
}

function verifyTargetSpec() {
  const errors = [];
  const teamSlugs = [
    PERMISSIONS.ATTENDANCE_READ_TEAM,
    PERMISSIONS.LEAVE_READ_TEAM,
    PERMISSIONS.SALARY_READ_TEAM,
  ];
  const allSlugs = [
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.LEAVE_READ_ALL,
  ];

  for (const slug of teamSlugs) {
    const [, hr, rm] = TARGET_PERM[slug];
    if (hr === Y) errors.push(`HR must not have team slug ${slug}`);
    if (rm !== Y) errors.push(`RM must have team slug ${slug}`);
  }

  for (const slug of allSlugs) {
    const [, hr, rm] = TARGET_PERM[slug];
    if (hr !== Y) errors.push(`HR must have company slug ${slug}`);
    if (rm === Y) errors.push(`RM must not have company slug ${slug}`);
  }

  if (TARGET_PERM[PERMISSIONS.ROLES_MANAGE][1] === Y) {
    errors.push('HR must not have roles.manage');
  }
  if (TARGET_PERM[PERMISSIONS.USERS_READ][3] === Y) {
    errors.push('Employee must not have users.read');
  }
  if (TARGET_PERM[PERMISSIONS.SALARY_READ][3] !== Y) {
    errors.push('Employee must have salary.read for own pay estimate');
  }

  const findRow = (labelPart) =>
    SHEETS.flatMap((s) => s.rows).find((r) => r.label.includes(labelPart));

  if (findRow('Employee portal login')?.values.Admin !== N) {
    errors.push('Admin ghost account must not use employee portal login');
  }
  if (findRow('Switch Admin and Employee portal')?.values.Admin !== N) {
    errors.push('Portal switch must be No for Admin ghost account');
  }

  const adminAccount = findAccountSettingsRow('Account', Y);
  const employeeAccount = findAccountSettingsRow('Account', N);
  if (adminAccount?.values.Employee !== N) {
    errors.push('Admin ghost account must not use employee Account settings');
  }
  for (const role of ['HR', 'Reporting Manager', 'Employee']) {
    if (employeeAccount?.values[role] !== Y) {
      errors.push(`Account settings (employee portal) must be Yes for ${role}`);
    }
  }

  if (findRow('Calendar management')?.values['Reporting Manager'] === Y) {
    errors.push('RM must not manage holiday calendar');
  }
  if (findRow('Salary Summary (company-wide)')?.values['Reporting Manager'] === Y) {
    errors.push('RM must not access company Salary Summary');
  }

  if (errors.length) {
    console.error('RBAC spec verification failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('RBAC spec verification: passed');
}

async function main() {
  verifyTargetSpec();
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Grubpac Engineering — Target RBAC Matrix';
  workbook.created = new Date();

  let totalRows = 0;
  const tabSummary = [];

  for (const sheetDef of SHEETS) {
    const count = buildSheet(workbook, sheetDef);
    totalRows += count;
    tabSummary.push({ name: sheetDef.name, rows: count });
  }

  await workbook.xlsx.writeFile(OUTPUT_PATH);

  console.log(`Created: ${OUTPUT_PATH}`);
  console.log('Mode: TARGET enterprise RBAC (team-lead sign-off spec — not current code)');
  console.log(`Roles: ${ROLES.join(', ')}`);
  console.log(`Values: Yes / No only`);
  console.log(`Tabs: ${SHEETS.length}; Total rows: ${totalRows}`);
  for (const t of tabSummary) {
    console.log(`  ${t.name}: ${t.rows}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
