import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmployeeTemplateWorkbook } from './excelImportService.js';
import { buildSalaryExportWorkbook } from './salaryService.js';

function assertXlsxZipMagic(buffer, label) {
  assert.ok(Buffer.isBuffer(buffer), `${label} should return a Buffer`);
  assert.ok(buffer.length >= 4, `${label} should not be empty`);
  assert.equal(buffer[0], 0x50, `${label} should start with PK zip magic (0x50)`);
  assert.equal(buffer[1], 0x4b, `${label} should start with PK zip magic (0x4b)`);
}

test('buildEmployeeTemplateWorkbook returns a valid xlsx zip buffer', () => {
  assertXlsxZipMagic(buildEmployeeTemplateWorkbook(), 'Employee template');
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
