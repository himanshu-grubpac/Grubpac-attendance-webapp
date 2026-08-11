/**
 * Generates attendance portal bug/feature tracker Excel.
 * Run: node server/scripts/generate-bugs-features-tracker.mjs
 */
import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '../../docs/attendance-portal-bugs-features-tracker.xlsx');

const BRAND_ORANGE = 'FFF97316';
const HEADER_DARK = 'FF1F2937';
const WHITE = 'FFFFFFFF';
const ROW_EVEN = 'FFF9FAFB';
const ROW_ODD = 'FFFFFFFF';
const SUMMARY_FILL = 'FFFFF7ED';
const BORDER_COLOR = 'FFE5E7EB';

const BUGS = [
  {
    id: 'B-001',
    severity: 'Critical',
    module: 'Leave',
    title: 'Leave list userId parameter bypasses RBAC scope',
    description:
      'Any authenticated user can pass ?userId=<otherEmployeeId> on GET /api/leave/requests and overwrite the scope filter, exposing other employees\' leave history.',
    steps:
      '1. Log in as Employee A with leave.read only.\n2. Call GET /api/leave/requests?scope=mine&userId=<Employee B id>.\n3. Observe Employee B\'s leave requests returned.',
    expectedVsActual:
      'Expected: userId query ignored or restricted to authorized scope.\nActual: filter.userId is overwritten unconditionally after scope resolution.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'leaveService.js listLeaveRequests() lines 541–543. Security / IDOR.',
  },
  {
    id: 'B-002',
    severity: 'High',
    module: 'Leave',
    title: 'Employee can self-set adminException to bypass lead/deputy rule',
    description:
      'POST /api/leave/requests accepts adminException: true from any employee with leave.apply, skipping validateLeadDeputyConflict without an admin role check.',
    steps:
      '1. Log in as a department lead employee.\n2. Apply leave on a day when deputy is also on leave.\n3. Include adminException: true in request body.\n4. Request is accepted instead of blocked.',
    expectedVsActual:
      'Expected: Only HR/admin can set adminException.\nActual: Any applicant can bypass the lead/deputy same-day conflict rule.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'createLeaveRequest() + shared/validation/leave.js. Privilege escalation.',
  },
  {
    id: 'B-003',
    severity: 'High',
    module: 'Leave',
    title: 'Department managers see approval queue but cannot approve',
    description:
      'resolveLeaveApprovalUserIds() includes all employees in managed departments, but canApproveLeave() only allows direct reporting manager or delegate — not department heads.',
    steps:
      '1. Log in as a user who manages a department but is not the direct manager.\n2. Open Pending leave approvals — requests appear.\n3. Attempt Approve — API returns 403.',
    expectedVsActual:
      'Expected: Queue visibility matches approve permission, OR dept heads can approve.\nActual: Visible in queue but blocked on decide.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'leaveService.js + teamScopeService.js. Product rule clarification needed.',
  },
  {
    id: 'B-004',
    severity: 'High',
    module: 'Auth',
    title: 'Admin default route causes redirect loop for limited roles',
    description:
      'getDefaultRoute() always sends admin-portal users to /admin/dashboard, which requires users.read. Custom roles with e.g. only leave.approve or office.manage fail the guard and loop.',
    steps:
      '1. Create custom admin-portal role without users.read.\n2. Log in via admin portal.\n3. User lands on /admin/dashboard → denied → redirected back to same route.',
    expectedVsActual:
      'Expected: Redirect to first permitted admin route.\nActual: Hardcoded /admin/dashboard for all admin-portal users.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'client/src/config/nav.js getDefaultRoute() + ProtectedRoute.jsx.',
  },
  {
    id: 'B-005',
    severity: 'High',
    module: 'Auth',
    title: 'Stale admin portal restored from localStorage after access revoked',
    description:
      'On session restore, stored attendance.loginPortal=admin is reused without verifying current admin-portal permissions. If admin access was revoked, user is stuck in admin shell with no portal switch.',
    steps:
      '1. User logs into admin portal (stored in localStorage).\n2. Admin revokes admin permissions; employee access remains.\n3. User refreshes — still in admin portal, cannot switch to employee portal.',
    expectedVsActual:
      'Expected: Portal resolved from current permissions on every load.\nActual: Stale localStorage portal takes precedence.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'AuthContext.jsx + nav.js resolveLoginPortal().',
  },
  {
    id: 'B-006',
    severity: 'Medium',
    module: 'Leave',
    title: 'Delegate approver cannot view leave request detail',
    description:
      'Delegate can approve leave (canApproveLeave checks delegateApproverId) but GET /api/leave/requests/:id only grants access if actor is the direct reportingManagerId.',
    steps:
      '1. Manager sets delegate approver.\n2. Delegate opens approval queue and sees pending item.\n3. Click to view detail — 403 unless they are the direct manager.',
    expectedVsActual:
      'Expected: Delegate can view requests they can approve.\nActual: GET handler missing delegate check.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'leaveController.js getLeaveRequestHandler() lines 207–211.',
  },
  {
    id: 'B-007',
    severity: 'Medium',
    module: 'Leave',
    title: 'Month/year filters miss leave spanning boundaries',
    description:
      'listLeaveRequests filters startDate within month/year only. Leaves starting before the period and ending inside it are omitted (e.g. Jan 28–Feb 5 missing from February view).',
    steps:
      '1. Create approved leave Jan 28 – Feb 5.\n2. Filter leave list by month=2026-02 or year=2026.\n3. Request absent from February results.',
    expectedVsActual:
      'Expected: Overlap query (startDate <= periodEnd AND endDate >= periodStart).\nActual: startDate-only range filter.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'leaveService.js lines 549–562. Team calendar uses correct overlap pattern.',
  },
  {
    id: 'B-008',
    severity: 'Medium',
    module: 'Leave',
    title: 'Team calendar default month uses server timezone not IST',
    description:
      'When month query param is omitted, getTeamCalendar defaults to server getMonth() (UTC on Lambda) instead of getISTMonth(), showing wrong month near IST midnight.',
    steps:
      '1. Call GET /api/leave/team-calendar without month param between 00:00–05:29 IST on the 1st.\n2. Compare with expected IST month.',
    expectedVsActual:
      'Expected: Default month from getISTMonth().\nActual: new Date().getMonth() on UTC server.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'leaveService.js line 599. istDate.js has getISTMonth() helper.',
  },
  {
    id: 'B-009',
    severity: 'Medium',
    module: 'Leave',
    title: 'Concurrent leave applications can overdraw balance',
    description:
      'validateLeaveRequestInput() reads balance outside the MongoDB transaction. Two parallel submissions can both pass validation before either reserves pending days.',
    steps:
      '1. Employee with 2 days CL remaining.\n2. Submit two 2-day CL requests simultaneously.\n3. Both may succeed, exceeding available balance.',
    expectedVsActual:
      'Expected: Balance check inside transaction with locking.\nActual: TOCTOU between validation and reserveValidatedLeaveBalance().',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'leaveService.js createLeaveRequest(). Race condition.',
  },
  {
    id: 'B-010',
    severity: 'Medium',
    module: 'Attendance',
    title: 'Admin edit cannot create missing check-out record',
    description:
      'When admin sends checkOutTime for a day with check-in but no check-out, adminEditAttendanceRecord only updates an existing check-out — it never creates one if missing.',
    steps:
      '1. Employee has allowed check-in, no check-out.\n2. Admin edits attendance and sets check-out time.\n3. Save succeeds but no check-out record created in DB.',
    expectedVsActual:
      'Expected: Admin can add missing check-out.\nActual: checkOutTime ignored when no existing check-out record.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'attendanceService.js adminEditAttendanceRecord() lines 679–705.',
  },
  {
    id: 'B-011',
    severity: 'Medium',
    module: 'Leave',
    title: 'Leave day preview race shows stale count',
    description:
      'EmployeeApplyLeave debounces previewDays API calls without abort or request sequencing. Slow older responses can overwrite preview after user changes dates.',
    steps:
      '1. Open Apply Leave.\n2. Select a long date range, then quickly change to a shorter range.\n3. Preview may show days from the first range.',
    expectedVsActual:
      'Expected: Preview always matches latest date selection.\nActual: Last response wins regardless of order.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'EmployeeApplyLeave.jsx lines 60–78.',
  },
  {
    id: 'B-012',
    severity: 'Medium',
    module: 'Leave',
    title: 'Leave policy year uses browser timezone instead of IST',
    description:
      'Policy fetch and balance year use new Date().getFullYear() (browser local TZ). App is IST-centric elsewhere; wrong policy year possible near Jan 1 00:00–05:29 IST or for non-IST users.',
    steps:
      '1. Access Apply Leave or Leave Balances near IST year boundary.\n2. Compare loaded policy year with IST calendar year.',
    expectedVsActual:
      'Expected: IST year via getISTYear().\nActual: Browser local getFullYear().',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'EmployeeApplyLeave.jsx, EmployeeLeaveBalances.jsx, AdminLeavePolicies.jsx.',
  },
  {
    id: 'B-013',
    severity: 'Medium',
    module: 'Leave',
    title: 'SL medical certificate not validated before submit on client',
    description:
      'Server rejects SL when consecutive working days exceed requireDocAfterConsecutiveDays without documentUrl. Client schema only validates URL format when present — no policy-aware rule.',
    steps:
      '1. Apply SL for 3+ consecutive working days.\n2. Leave document URL empty.\n3. Client allows submit; server returns error after round-trip.',
    expectedVsActual:
      'Expected: Client blocks submit with clear message when cert required.\nActual: Server-only enforcement.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'shared/validation/leave.js vs leaveService.js validateLeaveRequestInput().',
  },
  {
    id: 'B-014',
    severity: 'Low',
    module: 'Admin',
    title: 'Paginated lists show stale data on rapid filter changes',
    description:
      'Multiple admin/employee list pages fire API calls without in-flight cancellation. Slow earlier responses overwrite newer filter/page results.',
    steps:
      '1. Open Admin Leave Approvals or Employee Help.\n2. Rapidly switch filters or pages.\n3. Table may briefly or persistently show wrong rows.',
    expectedVsActual:
      'Expected: Only latest request updates UI.\nActual: Last-completed request wins.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'AdminLeaveApprovals.jsx, EmployeeHelp.jsx, EmployeeMyLeaveRequests.jsx, etc.',
  },
  {
    id: 'B-015',
    severity: 'Low',
    module: 'Salary',
    title: 'presentDays uncapped while LOP uses daily cap',
    description:
      'Salary summary presentDays sums raw attendance credits, but lopDays uses computeDailyCappedPayableDays (max 1.0/day). HR may see presentDays + paidLeaveDays > workingDays while LOP looks inconsistent.',
    steps:
      '1. Employee with multiple attendance records or edge credits on same day.\n2. Open salary summary for month.\n3. Compare presentDays vs lopDays math.',
    expectedVsActual:
      'Expected: Consistent daily-cap logic across all displayed fields.\nActual: presentDays uncapped, payable/lop capped.',
    status: 'Open',
    foundIn: 'Code review',
    notes: 'salaryService.js computeMonthlySalarySummary(). Display/consistency issue.',
  },
];

const FEATURES = [
  {
    id: 'F-001',
    priority: 'P1',
    module: 'Notifications',
    title: 'Email / SMS alerts for leave and help events',
    description:
      'In-app notifications exist (Notification model) but no email or SMS dispatch on leave approval/rejection, pending queue, or help ticket updates. Users must log in to see updates.',
    businessValue: 'Faster manager response; employees notified without checking portal daily.',
    status: 'Requested',
    notes: 'notificationService.js is DB-only. No SES/SNS integration in codebase.',
  },
  {
    id: 'F-002',
    priority: 'P1',
    module: 'Leave',
    title: 'Scheduled monthly accrual + year-end carry-forward jobs',
    description:
      'Accrual and carry-forward logic exists (leaveJobs.js, leaveBalanceService.applyYearEndCarryForward) but no EventBridge/cron wiring in template.yaml — only Lambda warmup schedule present.',
    businessValue: 'Automated EL accrual and Jan 1 carry-forward without manual HR intervention.',
    status: 'Backlog',
    notes: 'Run via npm run jobs:accrual manually today. Needs infra schedule.',
  },
  {
    id: 'F-003',
    priority: 'P1',
    module: 'Leave',
    title: 'Employee self-service leave encashment request',
    description:
      'Encashment API exists (POST /api/leave/balances/:userId/encash) and admin can record encashment in Leave Policies UI, but employees cannot request encashment from employee portal.',
    businessValue: 'CL/EL encashment per handbook without HR manually entering each request.',
    status: 'Requested',
    notes: 'Requires employee workflow + manager/HR approval if desired.',
  },
  {
    id: 'F-004',
    priority: 'P1',
    module: 'Leave',
    title: 'Bulk leave approval for managers/HR',
    description:
      'Managers approve/reject one leave request at a time. No multi-select or bulk action on pending queue.',
    businessValue: 'Saves time during holiday season when many requests pile up.',
    status: 'Backlog',
    notes: 'AdminLeaveApprovals.jsx — single decide API per row.',
  },
  {
    id: 'F-005',
    priority: 'P2',
    module: 'Salary',
    title: 'Payslip PDF export per employee/month',
    description:
      'Salary summary and Excel export exist for admin rollup, but no employee-facing payslip PDF with breakdown (present, LOP, net estimate).',
    businessValue: 'Self-service pay transparency; HR can share official-looking statements.',
    status: 'Backlog',
    notes: 'EmployeePayEstimate.jsx shows estimate only. No PDF generation library.',
  },
  {
    id: 'F-006',
    priority: 'P2',
    module: 'Help',
    title: 'Help ticket SLA tracking and escalation',
    description:
      'Help tickets have status workflow but no SLA timers, priority-based escalation, or overdue alerts for HR/managers.',
    businessValue: 'Ensures employee issues are resolved within agreed timelines.',
    status: 'Backlog',
    notes: 'HelpTicket model has status only; no dueAt or escalation fields.',
  },
  {
    id: 'F-007',
    priority: 'P2',
    module: 'Integration',
    title: 'Payroll / HRMS system export API',
    description:
      'No webhook or structured export API for external payroll systems (Tally, Razorpay Payroll, etc.). Data export is manual Excel from admin screens.',
    businessValue: 'Reduces double entry and payroll processing errors at month-end.',
    status: 'Backlog',
    notes: 'salaryService + reportsService are internal only.',
  },
  {
    id: 'F-008',
    priority: 'P2',
    module: 'Attendance',
    title: 'Native mobile app or offline-capable PWA check-in',
    description:
      'Web-only geo check-in requires active browser session. No installed mobile app, push reminders, or offline queue for check-in when connectivity is poor.',
    businessValue: 'Reliable field/remote attendance for employees on mobile networks.',
    status: 'Backlog',
    notes: 'Geo check-in in attendanceService; client is responsive web only.',
  },
  {
    id: 'F-009',
    priority: 'P2',
    module: 'Admin',
    title: 'Custom role permission-aware landing page',
    description:
      'Configurable default route per role (e.g. leave approvers land on Pending Approvals, office admin on Office Settings).',
    businessValue: 'Better UX for admin-portal users with narrow permissions.',
    status: 'Requested',
    notes: 'Requires role-to-route mapping in admin config.',
  },
];

function applyHeaderStyle(row, colCount) {
  row.height = 22;
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: WHITE }, size: 11, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_DARK } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  }
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  };
}

function styleDataRow(row, rowIndex, colCount) {
  const fill = rowIndex % 2 === 0 ? ROW_EVEN : ROW_ODD;
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.border = thinBorder();
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.font = { size: 10, name: 'Calibri' };
  }
}

function styleSummaryRow(row, colCount) {
  row.height = 20;
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUMMARY_FILL } };
    cell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF9A3412' } };
    cell.border = thinBorder();
    cell.alignment = { vertical: 'middle', wrapText: true };
  }
}

function addTitleRow(sheet, title, colCount) {
  sheet.mergeCells(1, 1, 1, colCount);
  const cell = sheet.getCell(1, 1);
  cell.value = title;
  cell.font = { bold: true, size: 14, name: 'Calibri', color: { argb: WHITE } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ORANGE } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 28;
}

function buildBugsSheet(workbook) {
  const sheet = workbook.addWorksheet('Bugs', {
    views: [{ state: 'frozen', ySplit: 4 }],
    properties: { defaultRowHeight: 18 },
  });

  const headers = [
    'ID',
    'Severity',
    'Module',
    'Title',
    'Description',
    'Steps to Reproduce',
    'Expected vs Actual',
    'Status',
    'Found In',
    'Notes',
  ];
  const colCount = headers.length;

  addTitleRow(sheet, 'Grubpac Attendance Portal — Bug Tracker (Code Review Aug 2026)', colCount);

  const openBugs = BUGS.filter((b) => b.status === 'Open');
  const critical = openBugs.filter((b) => b.severity === 'Critical').length;
  const high = openBugs.filter((b) => b.severity === 'High').length;
  const medium = openBugs.filter((b) => b.severity === 'Medium').length;
  const low = openBugs.filter((b) => b.severity === 'Low').length;

  const summaryRow = sheet.getRow(2);
  summaryRow.getCell(1).value = `Total Open: ${openBugs.length}`;
  summaryRow.getCell(2).value = `Critical: ${critical}`;
  summaryRow.getCell(3).value = `High: ${high}`;
  summaryRow.getCell(4).value = `Medium: ${medium}`;
  summaryRow.getCell(5).value = `Low: ${low}`;
  summaryRow.getCell(6).value = `Verified open bugs only — completed fixes not listed`;
  styleSummaryRow(summaryRow, colCount);

  const headerRow = sheet.getRow(3);
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h;
  });
  applyHeaderStyle(headerRow, colCount);

  BUGS.forEach((bug, idx) => {
    const row = sheet.getRow(4 + idx);
    row.values = [
      bug.id,
      bug.severity,
      bug.module,
      bug.title,
      bug.description,
      bug.steps,
      bug.expectedVsActual,
      bug.status,
      bug.foundIn,
      bug.notes,
    ];
    styleDataRow(row, idx, colCount);
  });

  const widths = [8, 12, 14, 32, 42, 36, 36, 10, 14, 36];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  sheet.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3 + BUGS.length, column: colCount },
  };
}

function buildFeaturesSheet(workbook) {
  const sheet = workbook.addWorksheet('New Features', {
    views: [{ state: 'frozen', ySplit: 4 }],
    properties: { defaultRowHeight: 18 },
  });

  const headers = ['ID', 'Priority', 'Module', 'Title', 'Description', 'Business Value', 'Status', 'Notes'];
  const colCount = headers.length;

  addTitleRow(sheet, 'Grubpac Attendance Portal — Feature Backlog (Aug 2026)', colCount);

  const requested = FEATURES.filter((f) => f.status === 'Requested').length;
  const backlog = FEATURES.filter((f) => f.status === 'Backlog').length;

  const summaryRow = sheet.getRow(2);
  summaryRow.getCell(1).value = `Total new features: ${FEATURES.length}`;
  summaryRow.getCell(2).value = `P1: ${FEATURES.filter((f) => f.priority === 'P1').length}`;
  summaryRow.getCell(3).value = `P2: ${FEATURES.filter((f) => f.priority === 'P2').length}`;
  summaryRow.getCell(4).value = `Requested: ${requested}`;
  summaryRow.getCell(5).value = `Backlog: ${backlog}`;
  summaryRow.getCell(6).value = `Completed work not listed — new scope only`;
  styleSummaryRow(summaryRow, colCount);

  const headerRow = sheet.getRow(3);
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h;
  });
  applyHeaderStyle(headerRow, colCount);

  FEATURES.forEach((feature, idx) => {
    const row = sheet.getRow(4 + idx);
    row.values = [
      feature.id,
      feature.priority,
      feature.module,
      feature.title,
      feature.description,
      feature.businessValue,
      feature.status,
      feature.notes,
    ];
    styleDataRow(row, idx, colCount);
  });

  const widths = [8, 10, 14, 34, 44, 32, 14, 38];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  sheet.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3 + FEATURES.length, column: colCount },
  };
}

async function main() {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Grubpac Engineering';
  workbook.created = new Date();

  buildBugsSheet(workbook);
  buildFeaturesSheet(workbook);

  await workbook.xlsx.writeFile(OUTPUT_PATH);

  const openBugs = BUGS.filter((b) => b.status === 'Open').length;
  console.log(`Created: ${OUTPUT_PATH}`);
  console.log(`Bugs: ${BUGS.length} total (${openBugs} open)`);
  console.log(`Features: ${FEATURES.length} total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
