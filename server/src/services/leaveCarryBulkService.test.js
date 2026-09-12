import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import {
  leaveCarryBulkRowSchema,
  leaveCarryBulkTemplateQuerySchema,
} from '../../../shared/validation/leaveCarryBulk.js';
import { adjustLeaveBalanceSchema } from '../../../shared/validation/leave.js';
import { applyCarryBulkRows, parseCarryBulkWorkbook } from './leaveCarryBulkService.js';

test('leaveCarryBulkTemplateQuerySchema requires fromYear and toYear', () => {
  const result = leaveCarryBulkTemplateQuerySchema.safeParse({
    year: 2026,
    fromYear: 2025,
    toYear: 2026,
    userIds: '507f1f77bcf86cd799439011',
  });
  assert.equal(result.success, true);
  assert.equal(result.data.fromYear, 2025);
  assert.equal(result.data.toYear, 2026);
});

test('leaveCarryBulkTemplateQuerySchema rejects to year before from year', () => {
  const result = leaveCarryBulkTemplateQuerySchema.safeParse({
    year: 2026,
    fromYear: 2026,
    toYear: 2025,
    userIds: '507f1f77bcf86cd799439011',
  });
  assert.equal(result.success, false);
});

test('leaveCarryBulkRowSchema rejects to year before from year', () => {
  const result = leaveCarryBulkRowSchema.safeParse({
    employeeCode: 'EMP001',
    fromYear: 2026,
    toYear: 2025,
    leaveType: 'CL',
    carriedDays: 2,
    reason: 'Year-end carry',
  });
  assert.equal(result.success, false);
});

test('parseCarryBulkWorkbook maps template headers', () => {
  const worksheet = XLSX.utils.aoa_to_sheet([
    [
      'employeeName',
      'employeeCode',
      'fromYear',
      'toYear',
      'leaveType',
      'carriedDays',
      'reason',
    ],
    ['Jane Doe', 'EMP001', 2025, 2026, 'CL', 3, 'Approved carry'],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'CarriedLeave');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const rows = parseCarryBulkWorkbook(buffer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].data.employeeCode, 'EMP001');
  assert.equal(rows[0].data.leaveType, 'CL');
  assert.equal(rows[0].data.carriedDays, 3);
});

test('parseCarryBulkWorkbook finds header row after styled title rows', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CarriedLeave');
  sheet.mergeCells(1, 1, 1, 8);
  sheet.getCell(1, 1).value = 'Grubpac Technologies';
  sheet.mergeCells(2, 1, 2, 8);
  sheet.getCell(2, 1).value = 'Leave Carry Forward — Balance Year 2026 | Carry 2025 → 2026';
  sheet.mergeCells(3, 1, 3, 8);
  sheet.getCell(3, 1).value = 'Fill Carry columns and reason only; do not edit pre-filled balance columns.';
  sheet.getRow(6).values = [
    null,
    'employeeName',
    'employeeCode',
    'fromYear',
    'toYear',
    'leaveType',
    'carriedDays',
    'reason',
  ];
  sheet.getRow(7).values = [null, 'Jane Doe', 'EMP002', 2025, 2026, 'SL', 2, 'Carry approved'];

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const rows = parseCarryBulkWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowNumber, 7);
  assert.equal(rows[0].data.employeeCode, 'EMP002');
  assert.equal(rows[0].data.leaveType, 'SL');
  assert.equal(rows[0].data.carriedDays, 2);
});

test('parseCarryBulkWorkbook expands wide format rows into carry entries', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CarriedLeave');
  sheet.mergeCells(1, 1, 1, 16);
  sheet.getCell(1, 1).value = 'Grubpac Technologies';
  sheet.mergeCells(2, 1, 2, 16);
  sheet.getCell(2, 1).value = 'Leave Carry Forward — Balance Year 2025 | Carry 2025 → 2026';
  sheet.mergeCells(3, 1, 3, 16);
  sheet.getCell(3, 1).value = 'Fill Carry columns and reason only; do not edit pre-filled Entitled, Used, or Remaining columns.';

  sheet.getRow(5).values = [
    null,
    'employeeName',
    'employeeCode',
    'contractStartDate',
    'contractEndDate',
    'balanceYear',
    'fromYear',
    'toYear',
    'Casual Leave (CL)',
    null,
    null,
    null,
    'Sick Leave (SL)',
    null,
    null,
    null,
    'reason',
  ];
  sheet.getRow(6).values = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'Entitled',
    'Used',
    'Remaining',
    'Carry',
    'Entitled',
    'Used',
    'Remaining',
    'Carry',
    null,
  ];
  sheet.getRow(7).values = [
    null,
    'Jane Doe',
    'EMP001',
    '2025-01-01',
    '',
    2025,
    2025,
    2026,
    12,
    3,
    9,
    2,
    10,
    1,
    9,
    1,
    'Year-end carry',
  ];

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const rows = parseCarryBulkWorkbook(buffer);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowNumber, 7);
  assert.equal(rows[0].data.employeeCode, 'EMP001');
  assert.equal(rows[0].data.leaveType, 'CL');
  assert.equal(rows[0].data.carriedDays, 2);
  assert.equal(rows[0].data.reason, 'Year-end carry');
  assert.equal(rows[1].data.leaveType, 'SL');
  assert.equal(rows[1].data.carriedDays, 1);
  assert.equal(rows[1].data.reason, 'Year-end carry');
});

test('parseCarryBulkWorkbook parses production-like merged template with carry values', async () => {
  const leaveTypes = [
    { code: 'CL', name: 'Casual Leave' },
    { code: 'SL', name: 'Sick Leave' },
  ];
  const fixedHeaders = [
    'employeeName',
    'employeeCode',
    'contractStartDate',
    'contractEndDate',
    'balanceYear',
    'fromYear',
    'toYear',
  ];
  const subColumns = ['Entitled', 'Used', 'Remaining', 'Carry'];
  const colCount = fixedHeaders.length + leaveTypes.length * subColumns.length + 1;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CarriedLeave');
  sheet.mergeCells(1, 1, 1, colCount);
  sheet.getCell(1, 1).value = 'Grubpac Technologies';
  sheet.mergeCells(2, 1, 2, colCount);
  sheet.getCell(2, 1).value = 'Leave Carry Forward — Balance Year 2025 | Carry 2025 → 2026';
  sheet.mergeCells(3, 1, 3, colCount);
  sheet.getCell(3, 1).value = 'Fill Carry columns and reason only; do not edit pre-filled Entitled, Used, or Remaining columns.';

  fixedHeaders.forEach((header, index) => {
    const column = index + 1;
    sheet.mergeCells(5, column, 6, column);
    sheet.getCell(5, column).value = header;
  });

  let columnIndex = fixedHeaders.length + 1;
  for (const leaveType of leaveTypes) {
    const groupStart = columnIndex;
    const groupEnd = columnIndex + subColumns.length - 1;
    sheet.mergeCells(5, groupStart, 5, groupEnd);
    sheet.getCell(5, groupStart).value = `${leaveType.name} (${leaveType.code})`;
    subColumns.forEach((label, subIndex) => {
      sheet.getCell(6, groupStart + subIndex).value = label;
    });
    columnIndex = groupEnd + 1;
  }

  sheet.mergeCells(5, columnIndex, 6, columnIndex);
  sheet.getCell(5, columnIndex).value = 'reason';

  const values = [
    'Jane Doe',
    'EMP001',
    '2025-01-01',
    '',
    2025,
    2025,
    2026,
    12,
    3,
    9,
    4,
    10,
    1,
    9,
    '',
    'Year-end carry',
  ];
  values.forEach((value, valueIndex) => {
    sheet.getRow(7).getCell(valueIndex + 1).value = value;
  });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const rows = parseCarryBulkWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.employeeCode, 'EMP001');
  assert.equal(rows[0].data.leaveType, 'CL');
  assert.equal(rows[0].data.carriedDays, 4);
  assert.equal(rows[0].data.reason, 'Year-end carry');
});

test('parseCarryBulkWorkbook parses wide format when fixed headers share the sub-header row', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CarriedLeave');
  const colCount = 16;

  for (let row = 1; row <= 3; row += 1) {
    sheet.mergeCells(row, 1, row, colCount);
    sheet.getCell(row, 1).value = `Banner row ${row}`;
  }

  sheet.mergeCells(5, 8, 5, 11);
  sheet.getCell(5, 8).value = 'Casual Leave (CL)';
  sheet.mergeCells(5, 12, 5, 15);
  sheet.getCell(5, 12).value = 'Sick Leave (SL)';

  const fixedHeaders = [
    'employeeName',
    'employeeCode',
    'contractStartDate',
    'contractEndDate',
    'balanceYear',
    'fromYear',
    'toYear',
  ];
  fixedHeaders.forEach((header, index) => {
    sheet.getCell(6, index + 1).value = header;
  });
  ['Entitled', 'Used', 'Remaining', 'Carry'].forEach((label, index) => {
    sheet.getCell(6, 8 + index).value = label;
  });
  ['Entitled', 'Used', 'Remaining', 'Carry'].forEach((label, index) => {
    sheet.getCell(6, 12 + index).value = label;
  });
  sheet.getCell(6, 16).value = 'reason';

  const values = [
    'Jane Doe',
    'EMP001',
    '2025-01-01',
    '',
    2025,
    2025,
    2026,
    12,
    3,
    9,
    5,
    10,
    1,
    9,
    0,
    'Year-end carry',
  ];
  values.forEach((value, valueIndex) => {
    sheet.getRow(7).getCell(valueIndex + 1).value = value;
  });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const rows = parseCarryBulkWorkbook(buffer);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].data.employeeCode, 'EMP001');
  assert.equal(rows[0].data.leaveType, 'CL');
  assert.equal(rows[0].data.carriedDays, 5);
  assert.equal(rows[1].data.leaveType, 'SL');
  assert.equal(rows[1].data.carriedDays, 0);
});

test('parseCarryBulkWorkbook survives an XLSX rewrite round-trip with edited Carry', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CarriedLeave');
  sheet.mergeCells(1, 1, 1, 16);
  sheet.getCell(1, 1).value = 'Grubpac Technologies';
  sheet.mergeCells(2, 1, 2, 16);
  sheet.getCell(2, 1).value = 'Leave Carry Forward';
  sheet.mergeCells(3, 1, 3, 16);
  sheet.getCell(3, 1).value = 'Fill Carry columns and reason only.';
  sheet.getRow(5).values = [
    null,
    'employeeName',
    'employeeCode',
    'contractStartDate',
    'contractEndDate',
    'balanceYear',
    'fromYear',
    'toYear',
    'Casual Leave (CL)',
    null,
    null,
    null,
    'Sick Leave (SL)',
    null,
    null,
    null,
    'reason',
  ];
  sheet.getRow(6).values = [
    null, null, null, null, null, null, null, null,
    'Entitled', 'Used', 'Remaining', 'Carry',
    'Entitled', 'Used', 'Remaining', 'Carry', null,
  ];
  sheet.getRow(7).values = [
    null, 'Jane Doe', 'EMP001', '2025-01-01', '', 2025, 2025, 2026,
    12, 3, 9, '', 10, 1, 9, '', 'Year-end carry',
  ];

  const template = Buffer.from(await workbook.xlsx.writeBuffer());
  // Simulate an Excel open/save round-trip, then an HR edit of Carry cells.
  const roundTripped = XLSX.write(XLSX.read(template, { type: 'buffer' }), {
    type: 'buffer',
    bookType: 'xlsx',
  });
  const editable = XLSX.read(roundTripped, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(editable.Sheets.CarriedLeave, { header: 1, defval: '' });
  aoa[6][11] = 4; // CL Carry
  const editedSheet = XLSX.utils.aoa_to_sheet(aoa);
  const editedBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(editedBook, editedSheet, 'CarriedLeave');
  const edited = XLSX.write(editedBook, { type: 'buffer', bookType: 'xlsx' });

  const rows = parseCarryBulkWorkbook(edited);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.employeeCode, 'EMP001');
  assert.equal(rows[0].data.leaveType, 'CL');
  assert.equal(rows[0].data.carriedDays, 4);
});

test('parseCarryBulkWorkbook prefers the CarriedLeave sheet over sheet order', () => {
  const carried = XLSX.utils.aoa_to_sheet([
    ['employeeName', 'employeeCode', 'fromYear', 'toYear', 'leaveType', 'carriedDays', 'reason'],
    ['Jane Doe', 'EMP001', 2025, 2026, 'CL', 3, 'Approved carry'],
  ]);
  const decoy = XLSX.utils.aoa_to_sheet([['notes'], ['hello']]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, decoy, 'Notes');
  XLSX.utils.book_append_sheet(workbook, carried, 'CarriedLeave');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const rows = parseCarryBulkWorkbook(buffer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.employeeCode, 'EMP001');
  assert.equal(rows[0].data.carriedDays, 3);
});

test('parseCarryBulkWorkbook names available sheets when CarriedLeave is missing', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['a']]), 'Notes');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['b']]), 'Scratch');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  assert.throws(
    () => parseCarryBulkWorkbook(buffer),
    /Could not find the "CarriedLeave" sheet\. Found sheet\(s\): Notes, Scratch/,
  );
});

test('parseCarryBulkWorkbook reports employee rows with blank Carry instead of empty', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CarriedLeave');
  sheet.getRow(5).values = [
    null,
    'employeeName', 'employeeCode', 'contractStartDate', 'contractEndDate',
    'balanceYear', 'fromYear', 'toYear',
    'Casual Leave (CL)', null, null, null, 'reason',
  ];
  sheet.getRow(6).values = [
    null, null, null, null, null, null, null, null,
    'Entitled', 'Used', 'Remaining', 'Carry', null,
  ];
  sheet.getRow(7).values = [
    null, 'Jane Doe', 'EMP001', '2025-01-01', '', 2025, 2025, 2026,
    12, 3, 9, '', '',
  ];

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  assert.throws(
    () => parseCarryBulkWorkbook(buffer),
    /Found 1 employee row\(s\) but no Carry values\. Fill at least one Carry cell/,
  );
});

test('parseCarryBulkWorkbook parses ragged rows trimmed by spreadsheet editors', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('CarriedLeave');
  sheet.getRow(5).values = [
    null,
    'employeeName', 'employeeCode', 'contractStartDate', 'contractEndDate',
    'balanceYear', 'fromYear', 'toYear',
    'Casual Leave (CL)', null, null, null, 'reason',
  ];
  sheet.getRow(6).values = [
    null, null, null, null, null, null, null, null,
    'Entitled', 'Used', 'Remaining', 'Carry', null,
  ];
  sheet.getRow(7).values = [
    null, 'Jane Doe', 'EMP001', '2025-01-01', '', 2025, 2025, 2026,
    12, 3, 9, 2,
  ];

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const rows = parseCarryBulkWorkbook(buffer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.leaveType, 'CL');
  assert.equal(rows[0].data.carriedDays, 2);
});

test('parseCarryBulkWorkbook rejects files without a recognizable header row', () => {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['Grubpac Technologies'],
    ['Leave Carry Forward'],
    ['Instructions only'],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'CarriedLeave');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  assert.throws(
    () => parseCarryBulkWorkbook(buffer),
    /Could not find header row with employeeName or employeeCode columns/,
  );
});

test('leaveCarryBulkRowSchema accepts negative carriedDays as a deduction', () => {
  const result = leaveCarryBulkRowSchema.safeParse({
    employeeCode: 'EMP001',
    fromYear: 2025,
    toYear: 2026,
    leaveType: 'CL',
    carriedDays: -5,
  });
  assert.equal(result.success, true);
  assert.equal(result.data.carriedDays, -5);
});

test('leaveCarryBulkRowSchema still bounds carriedDays to +-365', () => {
  for (const carriedDays of [-366, 366]) {
    const result = leaveCarryBulkRowSchema.safeParse({
      employeeCode: 'EMP001',
      fromYear: 2025,
      toYear: 2026,
      leaveType: 'CL',
      carriedDays,
    });
    assert.equal(result.success, false, `carriedDays=${carriedDays} must be rejected`);
  }
});

test('adjustLeaveBalanceSchema accepts negative carried as a deduction', () => {
  const result = adjustLeaveBalanceSchema.safeParse({
    leaveTypeId: '507f1f77bcf86cd799439011',
    year: 2026,
    carried: -3,
    reason: 'Year-end correction',
  });
  assert.equal(result.success, true);
});

test('applyCarryBulkRows names the offending field in validation messages', async () => {
  const { summary, results } = await applyCarryBulkRows(
    [
      {
        rowNumber: 7,
        data: {
          employeeCode: '',
          fromYear: 2025,
          toYear: 2026,
          leaveType: 'CL',
          carriedDays: 3,
        },
      },
    ],
    '507f1f77bcf86cd799439011',
  );
  assert.equal(summary.validation_error, 1);
  assert.match(results[0].message, /employeeCode:/);
});
