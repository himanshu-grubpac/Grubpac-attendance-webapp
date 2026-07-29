import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { buildEmployeeInputSchema } from '../../../shared/validation/employee.js';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import {
  buildEmployeeTemplateWorkbook,
  normalizeExcelDateCell,
  parseEmployeeWorkbook,
} from './excelImportService.js';
import { buildSalaryExportWorkbook } from './salaryService.js';

function assertXlsxZipMagic(buffer, label) {
  assert.ok(Buffer.isBuffer(buffer), `${label} should return a Buffer`);
  assert.ok(buffer.length >= 4, `${label} should not be empty`);
  assert.equal(buffer[0], 0x50, `${label} should start with PK zip magic (0x50)`);
  assert.equal(buffer[1], 0x4b, `${label} should start with PK zip magic (0x4b)`);
}

function buildWorkbookBuffer(rows) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('buildEmployeeTemplateWorkbook returns a valid xlsx zip buffer', () => {
  assertXlsxZipMagic(buildEmployeeTemplateWorkbook(), 'Employee template');
});

test('normalizeExcelDateCell converts Excel serial numbers to YYYY-MM-DD', () => {
  assert.equal(normalizeExcelDateCell(45658), '2024-12-31');
});

test('normalizeExcelDateCell keeps plain YYYY-MM-DD and empty ending dates', () => {
  assert.equal(normalizeExcelDateCell('2025-06-01'), '2025-06-01');
  assert.equal(normalizeExcelDateCell(''), '');
  assert.equal(normalizeExcelDateCell(null), '');
});

test('normalizeExcelDateCell converts DD-MM-YYYY and DD/MM/YYYY text', () => {
  assert.equal(normalizeExcelDateCell('01-06-2025'), '2025-06-01');
  assert.equal(normalizeExcelDateCell('01/06/2025'), '2025-06-01');
});

test('parseEmployeeWorkbook converts Excel date serials in joiningDate column', () => {
  const serial = 45658;
  const buffer = buildWorkbookBuffer([
    ['firstName', 'lastName', 'email', 'mobile', 'password', 'joiningDate', 'endingDate'],
    ['Jane', 'Doe', 'jane@example.com', '9876543210', 'Employee@123', serial, ''],
  ]);
  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.joiningDate, '2024-12-31');
  assert.equal(rows[0].data.endingDate, '');
});

test('buildEmployeeInputSchema bulkImport allows missing roleId', () => {
  const schema = buildEmployeeInputSchema({
    roleSlug: SYSTEM_ROLE_SLUGS.EMPLOYEE,
    hasDepartments: false,
    bulkImport: true,
  });

  const result = schema.safeParse({
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.bulk@example.com',
    mobile: '9876543210',
    password: 'Employee@123',
    designation: 'Engineer',
    joiningDate: '2025-06-01',
    endingDate: '',
    reportingManagerId: '507f1f77bcf86cd799439011',
  });

  assert.equal(result.success, true);
});

test('buildEmployeeInputSchema without bulkImport still requires roleId', () => {
  const schema = buildEmployeeInputSchema({
    roleSlug: SYSTEM_ROLE_SLUGS.EMPLOYEE,
    hasDepartments: false,
  });

  const result = schema.safeParse({
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.single@example.com',
    mobile: '9876543210',
    password: 'Employee@123',
    designation: 'Engineer',
    joiningDate: '2025-06-01',
    endingDate: '',
  });

  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.includes('roleId')));
});

test('parseEmployeeWorkbook maps reportingManagerEmail and reportingManagerCode headers', () => {
  const buffer = buildWorkbookBuffer([
    [
      'firstName',
      'lastName',
      'email',
      'mobile',
      'password',
      'department',
      'designation',
      'reportingManagerEmail',
      'reportingManagerCode',
      'joiningDate',
    ],
    [
      'Jane',
      'Doe',
      'jane.manager@example.com',
      '9876543210',
      'Employee@123',
      'Development',
      'Engineer',
      'manager@grubpac.com',
      'TL001',
      '2025-06-01',
    ],
  ]);
  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.reportingManagerEmail, 'manager@grubpac.com');
  assert.equal(rows[0].data.reportingManagerCode, 'TL001');
  assert.equal(rows[0].data.department, 'Development');
});

test('buildEmployeeTemplateWorkbook includes reporting manager columns', () => {
  const buffer = buildEmployeeTemplateWorkbook();
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const headerRow = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];

  assert.ok(headerRow.includes('reportingManagerEmail'));
  assert.ok(headerRow.includes('reportingManagerCode'));
});

test('buildEmployeeInputSchema requires departmentId when org has departments', () => {
  const schema = buildEmployeeInputSchema({
    roleSlug: SYSTEM_ROLE_SLUGS.EMPLOYEE,
    hasDepartments: true,
    bulkImport: true,
  });

  const result = schema.safeParse({
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.dept@example.com',
    mobile: '9876543210',
    password: 'Employee@123',
    designation: 'Engineer',
    joiningDate: '2025-06-01',
    endingDate: '',
    reportingManagerId: '507f1f77bcf86cd799439011',
  });

  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.includes('departmentId')));
});

test('buildEmployeeInputSchema requires reportingManagerId for employees', () => {
  const schema = buildEmployeeInputSchema({
    roleSlug: SYSTEM_ROLE_SLUGS.EMPLOYEE,
    hasDepartments: false,
    bulkImport: true,
  });

  const result = schema.safeParse({
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.rm@example.com',
    mobile: '9876543210',
    password: 'Employee@123',
    designation: 'Engineer',
    joiningDate: '2025-06-01',
    endingDate: '',
  });

  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.includes('reportingManagerId')));
});

test('buildSalaryExportWorkbook returns a valid xlsx zip buffer', () => {
  assertXlsxZipMagic(
    buildSalaryExportWorkbook(
      [
        {
          month: '2026-03',
          userName: 'Jane Doe',
          employeeCode: 'EMP001',
          monthlySalary: 50000,
          workingDaysInMonth: 22,
          presentDays: 20,
          paidLeaveDays: 1,
          payableDays: 21,
          lopDays: 1,
          perDaySalary: 2272.73,
          payableEstimate: 47727.27,
        },
      ],
      '2026-03',
    ),
    'Salary export',
  );
});
