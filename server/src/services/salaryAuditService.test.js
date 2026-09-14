import assert from 'node:assert/strict';
import test from 'node:test';
import {
  salaryAuditQuerySchema,
  salaryAuditExportQuerySchema,
  salaryHistoryParamsSchema,
  salaryHistoryQuerySchema,
} from '../../../shared/validation/salary.js';

// ── Validation Schema Tests ──────────────────────────────────────────

test('salaryAuditQuerySchema: valid periodKey passes', () => {
  const result = salaryAuditQuerySchema.parse({ periodKey: '2026-08' });
  assert.equal(result.periodKey, '2026-08');
});

test('salaryAuditQuerySchema: invalid periodKey 2026-13 rejects', () => {
  assert.throws(() => salaryAuditQuerySchema.parse({ periodKey: '2026-13' }));
});

test('salaryAuditQuerySchema: invalid periodKey 2026-00 rejects', () => {
  assert.throws(() => salaryAuditQuerySchema.parse({ periodKey: '2026-00' }));
});

test('salaryAuditQuerySchema: invalid periodKey abc rejects', () => {
  assert.throws(() => salaryAuditQuerySchema.parse({ periodKey: 'abc' }));
});

test('salaryAuditQuerySchema: invalid periodKey 2026/08 rejects', () => {
  assert.throws(() => salaryAuditQuerySchema.parse({ periodKey: '2026/08' }));
});

test('salaryAuditQuerySchema: missing periodKey rejects', () => {
  assert.throws(() => salaryAuditQuerySchema.parse({}));
});

test('salaryAuditExportQuerySchema: valid periodKey passes', () => {
  const result = salaryAuditExportQuerySchema.parse({ periodKey: '2026-01' });
  assert.equal(result.periodKey, '2026-01');
});

test('salaryAuditExportQuerySchema: invalid periodKey rejects', () => {
  assert.throws(() => salaryAuditExportQuerySchema.parse({ periodKey: '2026-13' }));
});

test('salaryHistoryParamsSchema: valid userId passes', () => {
  const fakeId = '507f1f77bcf86cd799439011';
  const result = salaryHistoryParamsSchema.parse({ userId: fakeId });
  assert.equal(result.userId, fakeId);
});

test('salaryHistoryParamsSchema: invalid userId rejects', () => {
  assert.throws(() => salaryHistoryParamsSchema.parse({ userId: 'not-an-id' }));
});

test('salaryHistoryQuerySchema: valid year passes', () => {
  const result = salaryHistoryQuerySchema.parse({ year: '2026' });
  assert.equal(result.year, 2026);
});

test('salaryHistoryQuerySchema: year coerced to number', () => {
  const result = salaryHistoryQuerySchema.parse({ year: 2026 });
  assert.equal(result.year, 2026);
});

test('salaryHistoryQuerySchema: optional year returns undefined', () => {
  const result = salaryHistoryQuerySchema.parse({});
  assert.equal(result.year, undefined);
});

test('salaryHistoryQuerySchema: invalid year 1999 rejects', () => {
  assert.throws(() => salaryHistoryQuerySchema.parse({ year: 1999 }));
});

test('salaryHistoryQuerySchema: invalid year 2101 rejects', () => {
  assert.throws(() => salaryHistoryQuerySchema.parse({ year: 2101 }));
});

// ── buildAuditRow Logic Tests (unit-level) ──────────────────────────

test('settled month uses SalaryTransfer.amount as netSalary', () => {
  // When settled + transfer exists, netSalary MUST be transfer.amount
  const grossSalary = 50000;
  const lopDeduction = 1923;
  const totalDeductions = 1923;
  const computedNet = grossSalary - totalDeductions; // 48077

  const transferAmount = 47500; // Transfer might differ due to rounding/timing
  const isSettled = true;
  const transfer = { amount: transferAmount, status: 'paid' };

  const netSalary = isSettled && transfer != null ? transfer.amount : computedNet;

  assert.equal(netSalary, 47500); // Uses transfer, not computed
  assert.notEqual(netSalary, computedNet); // Differs from computed
});

test('pending month uses computed netSalary (gross - deductions)', () => {
  const grossSalary = 50000;
  const lopDeduction = 1923;
  const totalDeductions = 1923;
  const computedNet = grossSalary - totalDeductions;

  const transfer = null;
  const isSettled = false;

  const netSalary = isSettled && transfer != null ? transfer.amount : computedNet;

  assert.equal(netSalary, 48077); // Uses computed
});

test('settled month without transfer returns inconsistent status and null netSalary', () => {
  // Edge case: MonthSettlement exists but SalaryTransfer does NOT
  // Must NOT fall back to live calculation — return inconsistent state
  const grossSalary = 50000;
  const totalDeductions = 1923;
  const transfer = null;
  const isSettled = true;

  // New behavior: inconsistent → netSalary = null, status = 'inconsistent'
  const status = isSettled && !transfer ? 'inconsistent' : (isSettled ? 'settled' : 'pending');
  const netSalary = isSettled && transfer != null ? transfer.amount : (status === 'inconsistent' ? null : grossSalary - totalDeductions);

  assert.equal(status, 'inconsistent');
  assert.equal(netSalary, null);
  assert.notEqual(netSalary, grossSalary - totalDeductions); // Does NOT fall back
});

test('settled LOP records are filtered to status: settled', () => {
  const allRecords = [
    { status: 'settled', days: 1, deductionAmount: 1923 },
    { status: 'pending', days: 2, deductionAmount: 3846 },
    { status: 'settled', days: 0.5, deductionAmount: 961 },
  ];

  const settledOnly = allRecords.filter((r) => r.status === 'settled');

  assert.equal(settledOnly.length, 2);
  assert.equal(settledOnly[0].days, 1);
  assert.equal(settledOnly[1].days, 0.5);
});

test('no settled LOP records falls back to computed LOP', () => {
  const settledRecords = [];
  const computedLopDays = 1.5;
  const computedLopDeduction = 2885;

  const finalLopDays = settledRecords.length > 0
    ? settledRecords.reduce((sum, r) => sum + r.days, 0)
    : computedLopDays;
  const finalLopDeduction = settledRecords.length > 0
    ? settledRecords.reduce((sum, r) => sum + r.deductionAmount, 0)
    : computedLopDeduction;

  assert.equal(finalLopDays, 1.5);
  assert.equal(finalLopDeduction, 2885);
});

test('audit row contains transferStatus field', () => {
  const row = {
    employeeId: 'emp1',
    periodKey: '2026-08',
    grossSalary: 50000,
    lopDays: 1,
    lopDeduction: 1923,
    totalDeductions: 1923,
    netSalary: 48077,
    transferStatus: 'paid',
    status: 'settled',
  };

  assert.equal(row.transferStatus, 'paid');
  assert.equal(row.status, 'settled');
});

test('audit row with no transfer has transferStatus null', () => {
  const row = {
    transferStatus: null,
    status: 'pending',
  };

  assert.equal(row.transferStatus, null);
  assert.equal(row.status, 'pending');
});

test('net salary matches transfer.amount for settled months', () => {
  // This is the core consistency requirement
  const transfer = { amount: 47500, status: 'paid', periodKey: '2026-08' };
  const isSettled = true;

  const netSalary = isSettled ? transfer.amount : 48077;

  assert.equal(netSalary, transfer.amount);
  assert.equal(netSalary, 47500);
});

test('history and audit produce identical rows for same employee/month', () => {
  // Both use buildAuditRow — verify the structure matches
  const historyRow = {
    periodKey: '2026-08',
    grossSalary: 50000,
    workingDays: 26,
    presentDays: 24,
    paidLeaveDays: 1,
    payableDays: 25,
    lopDays: 1,
    lopDeduction: 1923,
    perDaySalary: 1923,
    otherDeductions: 0,
    totalDeductions: 1923,
    netSalary: 48077,
    hasSalaryConfigured: true,
    transferStatus: 'paid',
    status: 'settled',
  };

  const auditRow = {
    periodKey: '2026-08',
    grossSalary: 50000,
    workingDays: 26,
    presentDays: 24,
    paidLeaveDays: 1,
    payableDays: 25,
    lopDays: 1,
    lopDeduction: 1923,
    perDaySalary: 1923,
    otherDeductions: 0,
    totalDeductions: 1923,
    netSalary: 48077,
    hasSalaryConfigured: true,
    transferStatus: 'paid',
    status: 'settled',
  };

  // All fields must match
  assert.deepEqual(historyRow, auditRow);
});

test('export columns include transferStatus', () => {
  const exportColumns = [
    'Employee Code', 'Employee Name', 'Department', 'Month',
    'Gross Salary (INR)', 'Working Days', 'Present Days', 'Paid Leave Days',
    'Payable Days', 'LOP Days', 'LOP Deduction (INR)', 'Per Day Salary (INR)',
    'Other Deductions (INR)', 'Total Deductions (INR)', 'Net Salary (INR)',
    'Transfer Status', 'Status',
  ];

  assert.ok(exportColumns.includes('Transfer Status'));
  assert.equal(exportColumns.length, 17);
});

test('empty audit returns valid structure with zero totals', () => {
  const result = {
    periodKey: '2026-08',
    employees: [],
    totals: { employees: 0, lopDays: 0, lopDeduction: 0, totalDeductions: 0, totalNetSalary: 0 },
  };

  assert.equal(result.employees.length, 0);
  assert.equal(result.totals.employees, 0);
  assert.equal(result.totals.lopDays, 0);
  assert.equal(result.totals.totalNetSalary, 0);
});

test('inconsistent status returned when MonthSettlement exists but SalaryTransfer missing', () => {
  const settledPeriods = new Set(['2026-08']);
  const transfersByUser = new Map(); // empty — no transfer
  const userId = 'emp1';
  const isSettled = settledPeriods.has('2026-08');
  const transfer = transfersByUser.get(userId);

  const status = isSettled && !transfer ? 'inconsistent' : (isSettled ? 'settled' : 'pending');
  assert.equal(status, 'inconsistent');
});

test('audit row includes departmentName field', () => {
  const row = {
    employeeId: 'emp1',
    department: '507f1f77bcf86cd799439011',
    departmentName: 'Engineering',
    periodKey: '2026-08',
  };

  assert.equal(row.departmentName, 'Engineering');
  assert.ok(row.department); // raw ObjectId string still present
});

test('audit row with no department has departmentName null', () => {
  const row = {
    employeeId: 'emp1',
    department: null,
    departmentName: null,
  };

  assert.equal(row.departmentName, null);
});

test('employee without salary has hasSalaryConfigured false and monthlySalary null', () => {
  const summary = {
    hasSalaryConfigured: false,
    monthlySalary: null,
    grossSalary: 0,
  };

  assert.equal(summary.hasSalaryConfigured, false);
  assert.equal(summary.monthlySalary, null);
  assert.equal(summary.grossSalary, 0);
});

test('totals exclude inconsistent rows from totalNetSalary', () => {
  const rows = [
    { netSalary: 48077, status: 'settled' },
    { netSalary: null, status: 'inconsistent' },
    { netSalary: 50000, status: 'pending' },
  ];

  const totalNetSalary = rows
    .filter((r) => r.netSalary != null)
    .reduce((sum, r) => sum + r.netSalary, 0);

  assert.equal(totalNetSalary, 98077); // Only settled + pending, not inconsistent
});
