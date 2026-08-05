import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import {
  leaveCarryBulkRowSchema,
  MAX_CARRY_BULK_USERS,
} from '../../../shared/validation/leaveCarryBulk.js';
import { MAX_BULK_UPLOAD_ROWS } from '../../../shared/validation/common.js';
import { adjustLeaveBalanceSchema } from '../../../shared/validation/leave.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { LeaveType } from '../models/LeaveType.js';
import { adjustBalance, getBalancesForUser } from './leaveBalanceService.js';
import { getISTDateInputValue } from '../utils/istDate.js';

const COMPANY_NAME = 'Grubpac Technologies';
const BRAND_ORANGE = 'FFE85D04';
const HEADER_DARK = 'FF1F2937';
const WHITE = 'FFFFFFFF';
const ROW_EVEN = 'FFF9FAFB';
const ROW_ODD = 'FFFFFFFF';
const INSTRUCTION_FILL = 'FFFFF7ED';
const INSTRUCTION_TEXT = 'FF9A3412';
const BORDER_COLOR = 'FFE5E7EB';
const HEADER_SCAN_LIMIT = 12;
const TEMPLATE_GROUP_HEADER_ROW = 5;
const TEMPLATE_HEADER_ROW = 6;
const TEMPLATE_DATA_START_ROW = 7;

const FIXED_HEADERS = [
  'employeeName',
  'employeeCode',
  'contractStartDate',
  'contractEndDate',
  'balanceYear',
  'fromYear',
  'toYear',
];

const LEAVE_TYPE_SUB_COLUMNS = [
  { key: 'entitled', label: 'Entitled' },
  { key: 'used', label: 'Used' },
  { key: 'remaining', label: 'Remaining' },
  { key: 'carry', label: 'Carry' },
];

const LEAVE_TYPE_AUDIT_SUB_COLUMNS = [
  { key: 'entitled', label: 'Entitled' },
  { key: 'used', label: 'Used' },
  { key: 'remaining', label: 'Remaining' },
];

const LEAVE_TYPE_SORT_ORDER = ['CL', 'CO', 'EL', 'RH', 'SL', 'WFH'];

const headerMap = {
  employeename: 'employeeName',
  employeecode: 'employeeCode',
  employeeid: 'employeeCode',
  contractstartdate: 'contractStartDate',
  contractenddate: 'contractEndDate',
  balanceyear: 'balanceYear',
  leavetypecode: 'leaveTypeCode',
  leavetypename: 'leaveTypeName',
  entitled: 'entitled',
  used: 'used',
  carried: 'carried',
  remaining: 'remaining',
  fromyear: 'fromYear',
  toyear: 'toYear',
  leavetype: 'leaveType',
  carrieddays: 'carriedDays',
  carry: 'carriedDays',
  reason: 'reason',
};

const NUMERIC_FIELDS = new Set(['balanceYear', 'entitled', 'used', 'carried', 'remaining', 'fromYear', 'toYear', 'carriedDays']);

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function formatUserDate(date) {
  if (!date) return '';
  return getISTDateInputValue(new Date(date));
}

function buildCarryAuditReason(fromYear, toYear, userReason) {
  const prefix = `Carry from ${fromYear} to ${toYear}`;
  const trimmed = String(userReason ?? '').trim();
  if (!trimmed) return prefix;
  return `${prefix}: ${trimmed}`;
}

function normalizeCellValue(target, value) {
  if (NUMERIC_FIELDS.has(target)) {
    if (value === null || value === undefined || value === '') return '';
    const numeric = Number(value);
    return Number.isNaN(numeric) ? String(value).trim() : numeric;
  }
  return String(value ?? '').trim();
}

function isRowEmpty(row) {
  const carriedDays = row.data.carriedDays;
  return carriedDays === '' || carriedDays === null || carriedDays === undefined;
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  };
}

function applyTemplateHeaderStyle(row, colCount) {
  row.height = 22;
  for (let column = 1; column <= colCount; column += 1) {
    const cell = row.getCell(column);
    cell.font = { bold: true, color: { argb: WHITE }, size: 11, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_DARK } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  }
}

function styleTemplateDataRow(row, rowIndex, colCount) {
  const fill = rowIndex % 2 === 0 ? ROW_EVEN : ROW_ODD;
  for (let column = 1; column <= colCount; column += 1) {
    const cell = row.getCell(column);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.border = thinBorder();
    cell.alignment = { vertical: 'middle', wrapText: false };
    cell.font = { size: 10, name: 'Calibri' };
  }
}

function autoSizeWorksheetColumns(sheet, colCount, fromRow, toRow) {
  for (let column = 1; column <= colCount; column += 1) {
    let maxLength = 10;
    for (let rowNumber = fromRow; rowNumber <= toRow; rowNumber += 1) {
      const value = sheet.getRow(rowNumber).getCell(column).value;
      const text = value == null ? '' : String(value);
      if (text.length > maxLength) {
        maxLength = text.length;
      }
    }
    sheet.getColumn(column).width = Math.min(maxLength + 2, 42);
  }
}

function sortLeaveTypeCodes(codes) {
  return [...codes].sort((left, right) => {
    const leftIndex = LEAVE_TYPE_SORT_ORDER.indexOf(left);
    const rightIndex = LEAVE_TYPE_SORT_ORDER.indexOf(right);
    if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
    if (leftIndex !== -1) return -1;
    if (rightIndex !== -1) return 1;
    return left.localeCompare(right);
  });
}

function extractLeaveTypeCodeFromGroupHeader(value) {
  const match = String(value ?? '').match(/\(([A-Z0-9]+)\)\s*$/i);
  return match ? match[1].toUpperCase() : null;
}

function isCarrySubHeaderLabel(value) {
  const normalized = normalizeHeader(value);
  return normalized === 'carry' || normalized === 'carried';
}

function isWideFormatSubHeaderRow(row) {
  if (!Array.isArray(row)) return false;
  const normalized = row.map((cell) => normalizeHeader(cell));
  const entitledCount = normalized.filter((cell) => cell === 'entitled').length;
  const carryCount = normalized.filter((cell) => isCarrySubHeaderLabel(cell)).length;
  return entitledCount >= 1 && carryCount >= 1;
}

function resolveWideFormatGroupHeaderRowIndex(rows, headerRowIndex) {
  if (headerRowIndex < 0) return -1;

  if (isWideFormatSubHeaderRow(rows[headerRowIndex + 1])) {
    return headerRowIndex;
  }

  if (isWideFormatSubHeaderRow(rows[headerRowIndex])) {
    return headerRowIndex - 1;
  }

  const scanStart = Math.max(0, headerRowIndex - 2);
  const scanEnd = Math.min(rows.length - 2, headerRowIndex + 2);
  for (let rowIndex = scanStart; rowIndex <= scanEnd; rowIndex += 1) {
    if (isWideFormatSubHeaderRow(rows[rowIndex + 1])) {
      return rowIndex;
    }
  }

  return -1;
}

function findCarryBulkHeaderRowIndex(rows) {
  const limit = Math.min(rows.length, HEADER_SCAN_LIMIT);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const normalized = normalizeHeader(cell);
      if (normalized === 'employeename' || normalized === 'employeecode') {
        return rowIndex;
      }
    }
  }
  return -1;
}

function mapFixedColumns(groupRow, subRow = []) {
  const fixedColMap = {};
  let reasonCol = -1;
  const columnCount = Math.max(groupRow.length, subRow.length);

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    for (const headerRow of [groupRow, subRow]) {
      const mapped = headerMap[normalizeHeader(headerRow[columnIndex])];
      if (!mapped) continue;
      if (FIXED_HEADERS.includes(mapped) && fixedColMap[mapped] === undefined) {
        fixedColMap[mapped] = columnIndex;
      } else if (mapped === 'reason' && reasonCol < 0) {
        reasonCol = columnIndex;
      }
    }
  }

  return { fixedColMap, reasonCol };
}

function parseWideLeaveGroups(groupRow, subRow, reasonCol) {
  const groups = [];
  const stopCol = reasonCol >= 0 ? reasonCol : groupRow.length;
  let columnIndex = 0;

  while (columnIndex < stopCol) {
    const mapped = headerMap[normalizeHeader(groupRow[columnIndex])];
    if (mapped && FIXED_HEADERS.includes(mapped)) {
      columnIndex += 1;
      continue;
    }

    if (
      normalizeHeader(subRow[columnIndex]) === 'entitled' &&
      normalizeHeader(subRow[columnIndex + 1]) === 'used' &&
      normalizeHeader(subRow[columnIndex + 2]) === 'remaining' &&
      isCarrySubHeaderLabel(subRow[columnIndex + 3])
    ) {
      const code = extractLeaveTypeCodeFromGroupHeader(groupRow[columnIndex]);
      if (!code) {
        throw new Error(
          `Could not determine leave type code for column group starting at column ${columnIndex + 1}. Use headers like "Casual Leave (CL)".`,
        );
      }
      groups.push({
        code,
        carryCol: columnIndex + 3,
      });
      columnIndex += 4;
      continue;
    }

    columnIndex += 1;
  }

  if (groups.length === 0) {
    throw new Error(
      'Wide-format sheet is missing leave type column groups with Entitled, Used, Remaining, and Carry sub-columns.',
    );
  }

  return groups;
}

function mapWideWorksheetRows(aoa, groupHeaderRowIndex) {
  const groupRow = aoa[groupHeaderRowIndex] ?? [];
  const subRow = aoa[groupHeaderRowIndex + 1] ?? [];
  const { fixedColMap, reasonCol } = mapFixedColumns(groupRow, subRow);
  const leaveGroups = parseWideLeaveGroups(groupRow, subRow, reasonCol);
  const dataRows = aoa.slice(groupHeaderRowIndex + 2);

  if (dataRows.length > MAX_BULK_UPLOAD_ROWS) {
    throw new Error(
      `The file contains ${dataRows.length} rows. Maximum allowed is ${MAX_BULK_UPLOAD_ROWS}.`,
    );
  }

  const mappedRows = [];

  dataRows.forEach((row, index) => {
    if (!Array.isArray(row)) return;

    const rowNumber = groupHeaderRowIndex + index + 3;
    const base = {};
    for (const [field, columnIndex] of Object.entries(fixedColMap)) {
      base[field] = normalizeCellValue(field, row[columnIndex]);
    }

    const employeeCode = String(base.employeeCode ?? '').trim();
    const employeeName = String(base.employeeName ?? '').trim();
    if (!employeeCode && !employeeName) return;

    const reason =
      reasonCol >= 0 ? normalizeCellValue('reason', row[reasonCol]) : '';

    for (const group of leaveGroups) {
      const carriedDays = normalizeCellValue('carriedDays', row[group.carryCol]);
      if (carriedDays === '' || carriedDays === null || carriedDays === undefined) {
        continue;
      }

      mappedRows.push({
        rowNumber,
        data: {
          ...base,
          leaveType: group.code,
          leaveTypeCode: group.code,
          carriedDays,
          reason,
        },
      });
    }
  });

  if (mappedRows.length > MAX_BULK_UPLOAD_ROWS) {
    throw new Error(
      `The file expands to ${mappedRows.length} carry entries. Maximum allowed is ${MAX_BULK_UPLOAD_ROWS}.`,
    );
  }

  return mappedRows;
}

function mapWorksheetRows(aoa, headerRowIndex) {
  const headerCells = aoa[headerRowIndex] ?? [];
  const columnKeys = headerCells.map((cell) => headerMap[normalizeHeader(cell)] ?? null);
  const dataRows = aoa.slice(headerRowIndex + 1);

  if (dataRows.length > MAX_BULK_UPLOAD_ROWS) {
    throw new Error(
      `The file contains ${dataRows.length} rows. Maximum allowed is ${MAX_BULK_UPLOAD_ROWS}.`,
    );
  }

  return dataRows.map((row, index) => {
    const mapped = {};
    for (let columnIndex = 0; columnIndex < columnKeys.length; columnIndex += 1) {
      const target = columnKeys[columnIndex];
      if (target) {
        mapped[target] = normalizeCellValue(target, row[columnIndex]);
      }
    }
    return { rowNumber: headerRowIndex + index + 2, data: mapped };
  });
}

async function buildEmployeeDirectoryQuery() {
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  return adminRole ? { roleId: { $ne: adminRole._id } } : { role: { $ne: 'admin' } };
}

export async function resolveCarryBulkUsers({ departmentId, userIds }) {
  const baseQuery = await buildEmployeeDirectoryQuery();
  const query = {
    ...baseQuery,
    isActive: true,
    employeeCode: { $exists: true, $nin: [null, ''] },
  };

  if (userIds?.length) {
    query._id = { $in: userIds };
  } else if (departmentId) {
    query.departmentId = departmentId;
  }

  const users = await User.find(query).sort({ name: 1 }).limit(MAX_CARRY_BULK_USERS);
  if (users.length === 0) {
    throwError('No employees found for the selected filters.');
  }
  return users;
}

function applyGroupHeaderStyle(row, fromColumn, toColumn) {
  row.height = 22;
  for (let column = fromColumn; column <= toColumn; column += 1) {
    const cell = row.getCell(column);
    cell.font = { bold: true, color: { argb: WHITE }, size: 11, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ORANGE } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  }
}

function applySubHeaderStyle(row, fromColumn, toColumn) {
  row.height = 20;
  for (let column = fromColumn; column <= toColumn; column += 1) {
    const cell = row.getCell(column);
    cell.font = { bold: true, color: { argb: WHITE }, size: 10, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_DARK } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  }
}

export async function buildCarryBulkTemplate({
  year,
  fromYear,
  toYear,
  departmentId,
  userIds,
  mode = 'template',
}) {
  const isAudit = mode === 'audit';
  const subColumns = isAudit ? LEAVE_TYPE_AUDIT_SUB_COLUMNS : LEAVE_TYPE_SUB_COLUMNS;
  const users = await resolveCarryBulkUsers({ departmentId, userIds });

  if (users.length > MAX_BULK_UPLOAD_ROWS) {
    throwError(
      `Template would contain ${users.length} employees. Maximum allowed is ${MAX_BULK_UPLOAD_ROWS}. Narrow department or employee selection.`,
    );
  }

  const leaveTypeMap = new Map();
  const employeeRows = [];

  for (const user of users) {
    const balances = await getBalancesForUser(user._id, year);
    const contractStart = formatUserDate(user.salaryEffectiveFrom ?? user.joiningDate);
    const contractEnd = formatUserDate(user.endingDate);
    const balanceByCode = new Map();

    for (const balance of balances) {
      if (!balance.leaveTypeCode) continue;
      const code = balance.leaveTypeCode.toUpperCase();
      balanceByCode.set(code, balance);
      if (!leaveTypeMap.has(code)) {
        leaveTypeMap.set(code, {
          code,
          name: balance.leaveTypeName ?? code,
        });
      }
    }

    employeeRows.push({
      user,
      contractStart,
      contractEnd,
      balanceByCode,
    });
  }

  const leaveTypes = sortLeaveTypeCodes([...leaveTypeMap.keys()]).map((code) => leaveTypeMap.get(code));
  if (leaveTypes.length === 0) {
    throwError('No leave balance rows found for the selected employees and year.');
  }

  const colCount =
    FIXED_HEADERS.length + leaveTypes.length * subColumns.length + (isAudit ? 0 : 1);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = COMPANY_NAME;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('CarriedLeave', {
    views: [{ state: 'frozen', ySplit: TEMPLATE_HEADER_ROW, xSplit: FIXED_HEADERS.length }],
    properties: { defaultRowHeight: 18 },
  });

  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = COMPANY_NAME;
  titleCell.font = { bold: true, size: 16, name: 'Calibri', color: { argb: WHITE } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ORANGE } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, colCount);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = isAudit
    ? `Leave Balance Audit Report — Balance Year ${year}`
    : `Leave Carry Forward — Balance Year ${year} | Carry ${fromYear} → ${toYear}`;
  subtitleCell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: HEADER_DARK } };
  subtitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_EVEN } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(2).height = 22;

  sheet.mergeCells(3, 1, 3, colCount);
  const instructionCell = sheet.getCell(3, 1);
  instructionCell.value = isAudit
    ? 'Read-only audit snapshot. Entitled, Used, and Remaining are from live system balances. This file is not for upload.'
    : 'Fill Carry columns and reason only; do not edit pre-filled Entitled, Used, or Remaining columns.';
  instructionCell.font = { italic: true, size: 10, name: 'Calibri', color: { argb: INSTRUCTION_TEXT } };
  instructionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INSTRUCTION_FILL } };
  instructionCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  sheet.getRow(3).height = 20;

  sheet.getRow(4).height = 6;

  const groupHeaderRow = sheet.getRow(TEMPLATE_GROUP_HEADER_ROW);
  const subHeaderRow = sheet.getRow(TEMPLATE_HEADER_ROW);

  FIXED_HEADERS.forEach((header, index) => {
    const column = index + 1;
    sheet.mergeCells(TEMPLATE_GROUP_HEADER_ROW, column, TEMPLATE_HEADER_ROW, column);
    groupHeaderRow.getCell(column).value = header;
  });
  applyTemplateHeaderStyle(groupHeaderRow, FIXED_HEADERS.length);

  let columnIndex = FIXED_HEADERS.length + 1;
  for (const leaveType of leaveTypes) {
    const groupStart = columnIndex;
    const groupEnd = columnIndex + subColumns.length - 1;
    sheet.mergeCells(TEMPLATE_GROUP_HEADER_ROW, groupStart, TEMPLATE_GROUP_HEADER_ROW, groupEnd);
    groupHeaderRow.getCell(groupStart).value = `${leaveType.name} (${leaveType.code})`;
    applyGroupHeaderStyle(groupHeaderRow, groupStart, groupEnd);

    subColumns.forEach((subColumn, subIndex) => {
      subHeaderRow.getCell(groupStart + subIndex).value = subColumn.label;
    });
    applySubHeaderStyle(subHeaderRow, groupStart, groupEnd);
    columnIndex = groupEnd + 1;
  }

  if (!isAudit) {
    sheet.mergeCells(TEMPLATE_GROUP_HEADER_ROW, columnIndex, TEMPLATE_HEADER_ROW, columnIndex);
    groupHeaderRow.getCell(columnIndex).value = 'reason';
    applySubHeaderStyle(groupHeaderRow, columnIndex, columnIndex);
  }

  employeeRows.forEach((employeeRow, rowIndex) => {
    const row = sheet.getRow(TEMPLATE_DATA_START_ROW + rowIndex);
    const values = [
      employeeRow.user.name,
      employeeRow.user.employeeCode ?? '',
      employeeRow.contractStart,
      employeeRow.contractEnd,
      year,
      fromYear,
      toYear,
    ];

    for (const leaveType of leaveTypes) {
      const balance = employeeRow.balanceByCode.get(leaveType.code);
      values.push(
        balance?.entitled ?? 0,
        balance?.used ?? 0,
        balance?.available ?? 0,
      );
      if (!isAudit) {
        values.push('');
      }
    }
    if (!isAudit) {
      values.push('');
    }

    values.forEach((value, valueIndex) => {
      row.getCell(valueIndex + 1).value = value;
    });
    styleTemplateDataRow(row, rowIndex, colCount);
  });

  const lastDataRow = TEMPLATE_DATA_START_ROW + employeeRows.length - 1;
  autoSizeWorksheetColumns(sheet, colCount, TEMPLATE_HEADER_ROW, lastDataRow);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function buildCarryAuditReport(options) {
  return buildCarryBulkTemplate({ ...options, mode: 'audit' });
}

export function parseCarryBulkWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('The uploaded Excel file does not contain any sheets.');
  }

  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: '',
  });

  const headerRowIndex = findCarryBulkHeaderRowIndex(rawRows);
  if (headerRowIndex < 0) {
    throw new Error(
      'Could not find header row with employeeName or employeeCode columns. Download a fresh template and try again.',
    );
  }

  const wideGroupHeaderRowIndex = resolveWideFormatGroupHeaderRowIndex(rawRows, headerRowIndex);
  if (wideGroupHeaderRowIndex >= 0) {
    return mapWideWorksheetRows(rawRows, wideGroupHeaderRowIndex);
  }

  return mapWorksheetRows(rawRows, headerRowIndex);
}

function buildRowDuplicateKey(data) {
  const employeeCode = String(data.employeeCode ?? '').trim().toUpperCase();
  const leaveType = String(data.leaveType ?? data.leaveTypeCode ?? '')
    .trim()
    .toUpperCase();
  const toYear = String(data.toYear ?? '').trim();
  return `${employeeCode}|${leaveType}|${toYear}`;
}

function partitionRows(rows) {
  const actionable = [];
  const skipped = [];
  const duplicates = [];
  const seen = new Map();

  for (const row of rows) {
    if (isRowEmpty(row)) {
      skipped.push(row);
      continue;
    }

    const key = buildRowDuplicateKey(row.data);
    if (seen.has(key)) {
      duplicates.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        employeeCode: row.data.employeeCode ?? '',
        message: `Duplicate row within file (first seen on row ${seen.get(key)}).`,
      });
      continue;
    }

    seen.set(key, row.rowNumber);
    actionable.push(row);
  }

  return { actionable, skipped, duplicates };
}

async function resolveLeaveType(leaveTypeValue) {
  const normalized = String(leaveTypeValue ?? '').trim();
  if (!normalized) {
    throwError('Leave type is required.');
  }

  const upper = normalized.toUpperCase();
  const byCode = await LeaveType.findOne({ code: upper, isActive: true });
  if (byCode) return byCode;

  const byName = await LeaveType.findOne({
    name: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    isActive: true,
  });
  if (byName) return byName;

  throwError(`Leave type "${normalized}" not found or inactive.`);
}

function summarizeResults(results, skippedCount) {
  const summary = {
    total: results.length,
    success: results.filter((item) => item.status === 'success').length,
    duplicate: results.filter((item) => item.status === 'duplicate').length,
    validation_error: results.filter((item) => item.status === 'validation_error').length,
    error: results.filter((item) => item.status === 'error').length,
    skipped: skippedCount,
  };
  return { summary, results };
}

export async function applyCarryBulkRows(rows, adjustedBy) {
  const { actionable, skipped, duplicates } = partitionRows(rows);
  const results = [...duplicates];

  const leaveTypeCache = new Map();
  const userCache = new Map();

  for (const row of actionable) {
    const employeeCode = String(row.data.employeeCode ?? '').trim();
    const employeeName = String(row.data.employeeName ?? '').trim();

    try {
      const leaveTypeInput =
        String(row.data.leaveType ?? '').trim() ||
        String(row.data.leaveTypeCode ?? '').trim();

      const parsedRow = leaveCarryBulkRowSchema.parse({
        ...row.data,
        leaveType: leaveTypeInput,
      });

      const cacheKey = parsedRow.employeeCode.toUpperCase();
      let user = userCache.get(cacheKey);
      if (!user) {
        user = await User.findOne({
          employeeCode: new RegExp(`^${parsedRow.employeeCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
          isActive: true,
        });
        if (!user) {
          throwError(`Employee with code "${parsedRow.employeeCode}" not found.`, 404);
        }
        userCache.set(cacheKey, user);
      }

      const leaveTypeKey = parsedRow.leaveType.toUpperCase();
      let leaveType = leaveTypeCache.get(leaveTypeKey);
      if (!leaveType) {
        leaveType = await resolveLeaveType(parsedRow.leaveType);
        leaveTypeCache.set(leaveTypeKey, leaveType);
      }

      if (parsedRow.leaveTypeCode && parsedRow.leaveTypeCode.toUpperCase() !== leaveType.code) {
        throwError(
          `Leave type "${parsedRow.leaveType}" does not match template leave type code "${parsedRow.leaveTypeCode}".`,
        );
      }

      const adjustPayload = {
        leaveTypeId: leaveType._id.toString(),
        year: parsedRow.toYear,
        carried: parsedRow.carriedDays,
        reason: buildCarryAuditReason(parsedRow.fromYear, parsedRow.toYear, parsedRow.reason),
      };

      const validated = adjustLeaveBalanceSchema.parse(adjustPayload);
      await adjustBalance(user._id, validated, adjustedBy);

      results.push({
        rowNumber: row.rowNumber,
        status: 'success',
        employeeCode: user.employeeCode ?? employeeCode,
        employeeName: user.name ?? employeeName,
        message: `Credited ${validated.carried} carried day(s) to ${validated.year}.`,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        results.push({
          rowNumber: row.rowNumber,
          status: 'validation_error',
          employeeCode,
          employeeName,
          message: error.issues.map((issue) => issue.message).join(' '),
        });
        continue;
      }

      results.push({
        rowNumber: row.rowNumber,
        status: error.statusCode === 404 ? 'validation_error' : 'error',
        employeeCode,
        employeeName,
        message: error.message ?? 'Failed to apply carried days.',
      });
    }
  }

  results.sort((a, b) => a.rowNumber - b.rowNumber);
  return summarizeResults(results, skipped.length);
}
