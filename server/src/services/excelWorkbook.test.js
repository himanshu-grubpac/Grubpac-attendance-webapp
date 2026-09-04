import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { buildEmployeeInputSchema } from '../../../shared/validation/employee.js';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import {
  buildDirectoryExportRow,
  buildEmployeeTemplateWorkbook,
  normalizeExcelDateCell,
  parseBulkCreatePin,
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

test('parseEmployeeWorkbook maps id and isActive columns', () => {
  const buffer = buildWorkbookBuffer([
    ['id', 'firstName', 'lastName', 'email', 'mobile', 'password', 'designation', 'joiningDate', 'isActive'],
    ['507f1f77bcf86cd799439011', 'Jane', 'Doe', 'jane@example.com', '9876543210', 'Employee@123', 'Engineer', '2025-06-01', 'TRUE'],
  ]);
  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.id, '507f1f77bcf86cd799439011');
  assert.equal(rows[0].data.firstName, 'Jane');
  assert.equal(rows[0].data.email, 'jane@example.com');
  assert.equal(rows[0].data.isActive, 'TRUE');
});

test('parseEmployeeWorkbook handles blank id for new employee rows', () => {
  const buffer = buildWorkbookBuffer([
    ['id', 'firstName', 'email', 'mobile', 'password', 'designation', 'joiningDate'],
    ['', 'New', 'new@example.com', '9876543210', 'Employee@123', 'Engineer', '2025-06-01'],
  ]);
  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.id, '');
  assert.equal(rows[0].data.firstName, 'New');
});

test('parseEmployeeWorkbook correctly handles multiple rows with mix of id and blank id', () => {
  const buffer = buildWorkbookBuffer([
    ['id', 'firstName', 'email', 'mobile', 'password', 'designation', 'joiningDate'],
    ['507f1f77bcf86cd799439011', 'Existing', 'existing@example.com', '9876543210', '', 'Engineer', '2025-06-01'],
    ['', 'New', 'new@example.com', '9876543211', 'Employee@123', 'Manager', '2025-07-01'],
  ]);
  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].data.id, '507f1f77bcf86cd799439011');
  assert.equal(rows[0].data.firstName, 'Existing');
  assert.equal(rows[1].data.id, '');
  assert.equal(rows[1].data.firstName, 'New');
});

test('parseEmployeeWorkbook skips Instructions sheet and reads branded Employees sheet', () => {
  const workbook = XLSX.utils.book_new();
  const instructions = XLSX.utils.aoa_to_sheet([
    ['Employee Directory Export — Bulk Import Template'],
    [''],
    ['IMPORTANT RULES:'],
    ['• The "id" column (column A) is the unique employee identifier.'],
    ['• Rows with an "id" value will UPDATE the existing employee record.'],
  ]);
  XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions');
  const employees = XLSX.utils.aoa_to_sheet([
    ['Grubpac Technologies'],
    ['Employee Directory Export — 2 employees'],
    ['Rows with an id will UPDATE existing records.'],
    [],
    ['id', 'firstName', 'lastName', 'email', 'mobile', 'password', 'designation', 'joiningDate', 'isActive'],
    ['507f1f77bcf86cd799439011', 'Jane', 'Doe', 'jane@example.com', '9876543210', '', 'Engineer', '2025-06-01', 'TRUE'],
    ['', 'New', 'Hire', 'new@example.com', '9876543211', 'Employee@123', 'Manager', '2025-07-01', 'TRUE'],
  ]);
  XLSX.utils.book_append_sheet(workbook, employees, 'Employees');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowNumber, 6);
  assert.equal(rows[0].data.id, '507f1f77bcf86cd799439011');
  assert.equal(rows[0].data.firstName, 'Jane');
  assert.equal(rows[0].data.email, 'jane@example.com');
  assert.equal(rows[1].rowNumber, 7);
  assert.equal(rows[1].data.id, '');
  assert.equal(rows[1].data.firstName, 'New');
});

test('parseEmployeeWorkbook rejects files without a recognizable header row', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['Random'], ['nothing useful here']]),
    'Instructions',
  );
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  assert.throws(
    () => parseEmployeeWorkbook(buffer),
    /Could not find a header row/,
  );
});

test('parseEmployeeWorkbook maps the pin4Digite header to pin4', () => {
  const buffer = buildWorkbookBuffer([
    ['firstName', 'email', 'mobile', 'password', 'pin4Digite', 'employeeCode'],
    ['Jane', 'jane.pin@example.com', '9876543210', 'Employee@123', '4321', 'EMP001'],
  ]);
  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.pin4, '4321');
});

test('buildEmployeeTemplateWorkbook sample row aligns with its headers', () => {
  const buffer = buildEmployeeTemplateWorkbook();
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const [headers, sample] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  assert.equal(sample.length, headers.length, 'sample values must match header count');
  const codeIndex = headers.indexOf('employeeCode');
  assert.equal(sample[codeIndex], 'EMP001');
  assert.equal(sample[headers.indexOf('pin4Digite')], '1234');
});

test('buildDirectoryExportRow values align 1:1 with BULK_EXPORT_HEADERS', () => {
  const row = buildDirectoryExportRow({
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    mobile: '9876543210',
    employeeCode: 'EMP001',
    departmentId: { name: 'Development' },
    designation: 'Engineer',
    reportingManagerId: { email: 'manager@grubpac.com', employeeCode: 'TL001' },
    joiningDate: '2026-01-15',
    dateOfBirth: null,
    endingDate: null,
    isActive: true,
  });

  assert.equal(row.length, 16);
  assert.equal(row[0], '507f1f77bcf86cd799439011');
  assert.equal(row[7], 'EMP001');
  assert.equal(row[8], 'Development');
  assert.equal(row[15], 'TRUE');
});

test('parseEmployeeWorkbook maps isActive as lowercase true/false', () => {
  const buffer = buildWorkbookBuffer([
    ['id', 'firstName', 'email', 'mobile', 'password', 'designation', 'joiningDate', 'isActive'],
    ['507f1f77bcf86cd799439011', 'Active', 'active@example.com', '9876543210', '', 'Engineer', '2025-06-01', 'TRUE'],
    ['507f1f77bcf86cd799439012', 'Inactive', 'inactive@example.com', '9876543211', '', 'Engineer', '2025-06-01', 'FALSE'],
  ]);
  const rows = parseEmployeeWorkbook(buffer);

  assert.equal(rows[0].data.isActive, 'TRUE');
  assert.equal(rows[1].data.isActive, 'FALSE');
});

test('parseBulkCreatePin accepts blank and valid 4-digit PINs', () => {
  assert.equal(parseBulkCreatePin(''), '');
  assert.equal(parseBulkCreatePin(null), '');
  assert.equal(parseBulkCreatePin(undefined), '');
  assert.equal(parseBulkCreatePin('1234'), '1234');
  assert.equal(parseBulkCreatePin('  5678  '), '5678');
});

test('parseBulkCreatePin rejects non-4-digit PINs', () => {
  for (const value of ['12', '12345', '123456', 'abcd', '12a4']) {
    assert.throws(() => parseBulkCreatePin(value), `should reject ${JSON.stringify(value)}`);
  }
});
