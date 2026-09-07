import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Department } from '../models/Department.js';
import { buildEmployeeInputSchema } from '../../../shared/validation/employee.js';
import {
  MAX_BULK_UPLOAD_ROWS,
  normalizeMobile,
  passwordSchema,
} from '../../../shared/validation/common.js';
import { pinSchema } from '../../../shared/validation/auth.js';
import {
  legacyRoleFromSlug,
  prepareEmployeeReferences,
  resolveDepartment,
  resolveManagedDepartments,
  resolveReportingManager,
  resolveRole,
} from './userOrgService.js';
import {
  allocateNextEmployeeCode,
  duplicateFieldMessage,
  enrichDuplicateKeyError,
  isValidEmployeeCodeFormat,
  MAX_CREATE_ATTEMPTS,
  normalizeEmployeeCode,
  resolveEmployeeCodeForCreate,
} from './employeeCodeService.js';
import { getISTDateInputValue, parseDateInputAsISTDay } from '../utils/istDate.js';
import { COMPANY_START_DATE } from '../config/company.js';

export { normalizeMobile };

const BULK_EXPORT_HEADERS = [
  'id',
  'firstName',
  'lastName',
  'email',
  'mobile',
  'password',
  'pin4Digite',
  'employeeCode',
  'department',
  'designation',
  'reportingManagerEmail',
  'reportingManagerCode',
  'joiningDate',
  'dateOfBirth',
  'endingDate',
  'isActive',
];

const COMPANY_NAME = 'Grubpac Technologies';
const BRAND_ORANGE = 'FFE85D04';
const HEADER_DARK = 'FF1F2937';
const WHITE = 'FFFFFFFF';
const ROW_EVEN = 'FFF9FAFB';
const ROW_ODD = 'FFFFFFFF';
const BORDER_COLOR = 'FFE5E7EB';
const INSTRUCTION_FILL = 'FFFFF7ED';
const INSTRUCTION_TEXT = 'FF9A3412';
const ID_COLUMN_FILL = 'FFFEF3C7';

const TEMPLATE_COMPANY_ROW = 1;
const TEMPLATE_SUBTITLE_ROW = 2;
const TEMPLATE_INSTRUCTION_ROW = 3;
const TEMPLATE_SPACER_ROW = 4;
const TEMPLATE_HEADER_ROW = 5;
const TEMPLATE_DATA_START_ROW = 6;

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  };
}

/**
 * Pure row builder for the directory export — values must align 1:1 with
 * BULK_EXPORT_HEADERS (the caller throws otherwise).
 */
export function buildDirectoryExportRow(user) {
  const manager = user.reportingManagerId;
  return [
    user._id.toString(),
    user.firstName || '',
    user.lastName || '',
    user.email || '',
    user.mobile || '',
    // Two blanks: password + pin4Digite (leave blank — never export secrets).
    '',
    '',
    user.employeeCode || '',
    user.departmentId?.name || user.department || '',
    user.designation || '',
    manager?.email || '',
    manager?.employeeCode || '',
    user.joiningDate ? getISTDateInputValue(new Date(user.joiningDate)) : '',
    user.dateOfBirth ? getISTDateInputValue(new Date(user.dateOfBirth)) : '',
    user.endingDate ? getISTDateInputValue(new Date(user.endingDate)) : '',
    user.isActive ? 'TRUE' : 'FALSE',
  ];
}

export async function buildEmployeeDirectoryWorkbook() {
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  const directoryQuery = adminRole ? { roleId: { $ne: adminRole._id } } : { role: { $ne: 'admin' } };

  const users = await User.find(directoryQuery)
    .select(
      'firstName lastName email mobile employeeCode department designation departmentId reportingManagerId joiningDate dateOfBirth endingDate isActive',
    )
    .populate([
      { path: 'departmentId', select: 'name code isActive' },
      { path: 'reportingManagerId', select: 'name email employeeCode' },
    ])
    .sort({ employeeCode: 1, name: 1 })
    .lean();

  const colCount = BULK_EXPORT_HEADERS.length;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = COMPANY_NAME;
  workbook.created = new Date();

  const instructionsSheet = workbook.addWorksheet('Instructions');
  instructionsSheet.columns = [{ width: 80 }];
  const instructions = [
    ['Employee Directory Export — Bulk Import Template'],
    [''],
    ['IMPORTANT RULES:'],
    ['• The "id" column (column A) is the unique employee identifier. Do NOT edit or delete id values.'],
    ['• Rows with an "id" value will UPDATE the existing employee record.'],
    ['• Rows with a BLANK "id" will CREATE a new employee.'],
    ['• The "email" and "mobile" columns are IMMUTABLE via bulk import. Any changes to these fields will be IGNORED.'],
    ['• To change email or mobile, use the individual employee edit form.'],
    ['• The "password" and "pin" columns: leave BLANK to keep the existing password/pin.'],
    ['  Fill them in ONLY if you want to set a new password/pin for that employee.'],
    ['• NEW employees (blank "id") REQUIRE a typed password: 8+ characters with uppercase, lowercase, and a number.'],
    ['• NEW employees also require: firstName, email, mobile, designation, joiningDate, department, and reportingManagerEmail.'],
    ['• "pin4Digite" sets the 4-digit login PIN (new and existing employees). "pin6Digite" is ignored.'],
    ['• "isActive" must be TRUE or FALSE.'],
    ['• Dates must use YYYY-MM-DD format.'],
    ['• "reportingManagerEmail" or "reportingManagerCode" must match an active admin, HR, or reporting manager.'],
    ['• "department" must match an active department name (case-insensitive).'],
    ['• "employeeCode" format: 2–5 letters followed by 3–6 digits (e.g. EMP001, TL001).'],
    ['• Maximum rows: 500 per upload.'],
  ];
  instructions.forEach((row) => {
    instructionsSheet.addRow(row);
  });
  instructionsSheet.getRow(1).font = { bold: true, size: 14, color: { argb: BRAND_ORANGE } };
  for (let i = 3; i <= instructions.length; i++) {
    instructionsSheet.getRow(i).font = { color: { argb: INSTRUCTION_TEXT } };
  }

  const worksheet = workbook.addWorksheet('Employees', {
    views: [{ state: 'frozen', ySplit: TEMPLATE_HEADER_ROW }],
    properties: { defaultRowHeight: 18 },
  });

  worksheet.mergeCells(TEMPLATE_COMPANY_ROW, 1, TEMPLATE_COMPANY_ROW, colCount);
  const titleCell = worksheet.getCell(TEMPLATE_COMPANY_ROW, 1);
  titleCell.value = COMPANY_NAME;
  titleCell.font = { bold: true, size: 16, name: 'Calibri', color: { argb: WHITE } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ORANGE } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  worksheet.getRow(TEMPLATE_COMPANY_ROW).height = 30;

  worksheet.mergeCells(TEMPLATE_SUBTITLE_ROW, 1, TEMPLATE_SUBTITLE_ROW, colCount);
  const subtitleCell = worksheet.getCell(TEMPLATE_SUBTITLE_ROW, 1);
  subtitleCell.value = `Employee Directory Export — ${users.length} employee${users.length === 1 ? '' : 's'}`;
  subtitleCell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: HEADER_DARK } };
  subtitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_EVEN } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  worksheet.getRow(TEMPLATE_SUBTITLE_ROW).height = 22;

  worksheet.mergeCells(TEMPLATE_INSTRUCTION_ROW, 1, TEMPLATE_INSTRUCTION_ROW, colCount);
  const instructionCell = worksheet.getCell(TEMPLATE_INSTRUCTION_ROW, 1);
  instructionCell.value = 'Rows with an id will UPDATE existing records. Blank id rows will CREATE new employees. Email and mobile are immutable via bulk import.';
  instructionCell.font = { italic: true, size: 10, name: 'Calibri', color: { argb: INSTRUCTION_TEXT } };
  instructionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INSTRUCTION_FILL } };
  instructionCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  worksheet.getRow(TEMPLATE_INSTRUCTION_ROW).height = 20;

  worksheet.getRow(TEMPLATE_SPACER_ROW).height = 6;

  const headerRow = worksheet.getRow(TEMPLATE_HEADER_ROW);
  BULK_EXPORT_HEADERS.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
  });
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE }, size: 11, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_DARK } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  });

  for (let i = 0; i < users.length; i++) {
    const rowData = buildDirectoryExportRow(users[i]);
    if (rowData.length !== BULK_EXPORT_HEADERS.length) {
      throw new Error(
        `Directory export row has ${rowData.length} values for ${BULK_EXPORT_HEADERS.length} headers.`,
      );
    }

    const row = worksheet.getRow(TEMPLATE_DATA_START_ROW + i);
    rowData.forEach((value, colIndex) => {
      row.getCell(colIndex + 1).value = value;
    });

    const isEven = i % 2 === 0;
    row.eachCell((cell, colNumber) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: isEven ? ROW_EVEN : ROW_ODD },
      };
      cell.border = thinBorder();
      cell.alignment = { vertical: 'middle' };
      cell.font = { size: 10, name: 'Calibri' };
      if (colNumber === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ID_COLUMN_FILL } };
        cell.font = { color: { argb: 'FF92400E' }, size: 10, name: 'Calibri' };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }
    });
  }

  worksheet.columns = [
    { width: 28 },
    { width: 16 },
    { width: 16 },
    { width: 28 },
    { width: 14 },
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 16 },
    { width: 20 },
    { width: 22 },
    { width: 28 },
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 10 },
  ];

  const lastDataRow = TEMPLATE_DATA_START_ROW + users.length - 1;
  worksheet.autoFilter = {
    from: { row: TEMPLATE_HEADER_ROW, column: 1 },
    to: { row: TEMPLATE_HEADER_ROW, column: colCount },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function persistEmployee(
  parsed,
  passwordHash,
  pin4Hash,
  role,
  department,
  manager,
  managedDepartments,
  createdBy,
) {
  const joiningDate = parsed.joiningDate ? new Date(parsed.joiningDate) : null;
  const endingDate = parsed.endingDate ? new Date(parsed.endingDate) : null;

  if (joiningDate && joiningDate < COMPANY_START_DATE) {
    const error = new Error('Employee joining date cannot be before the company start date.');
    error.statusCode = 400;
    throw error;
  }

  if (joiningDate && endingDate && endingDate < joiningDate) {
    const error = new Error('Employee ending date cannot be before the joining date.');
    error.statusCode = 400;
    throw error;
  }

  let autoGenerated = false;
  let employeeCode = normalizeEmployeeCode(parsed.employeeCode);

  if (!employeeCode) {
    const resolved = await resolveEmployeeCodeForCreate('');
    employeeCode = resolved.code;
    autoGenerated = true;
  }

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    try {
      const user = await User.create({
        role: legacyRoleFromSlug(role.slug),
        roleId: role._id,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        name: `${parsed.firstName} ${parsed.lastName}`.trim(),
        email: parsed.email.toLowerCase(),
        mobile: parsed.mobile,
        employeeCode,
        designation: parsed.designation || undefined,
        joiningDate: parsed.joiningDate,
        dateOfBirth: parsed.dateOfBirth ? parseDateInputAsISTDay(parsed.dateOfBirth) : null,
        endingDate: parsed.endingDate ?? null,
        department: department?.name ?? parsed.department ?? undefined,
        departmentId: department?._id ?? undefined,
        reportingManagerId: manager?._id ?? undefined,
        managedDepartmentIds: managedDepartments,
        passwordHash,
        pin4Hash,
        createdBy,
        isActive: true,
      });

      await user.populate([
        { path: 'roleId', select: 'name slug permissions isSystem' },
        { path: 'departmentId', select: 'name code isActive' },
        { path: 'reportingManagerId', select: 'name email' },
      ]);

      return user.toSafeJSON();
    } catch (error) {
      const duplicate = enrichDuplicateKeyError(error);
      if (duplicate !== error) {
        if (autoGenerated && duplicate.field === 'employeeCode') {
          employeeCode = await allocateNextEmployeeCode();
          continue;
        }
        throw duplicate;
      }
      throw error;
    }
  }

  const exhausted = new Error('Unable to allocate a unique employee code. Please try again.');
  exhausted.statusCode = 409;
  throw exhausted;
}

function stripBulkReferenceFields(data) {
  const {
    reportingManagerEmail: _reportingManagerEmail,
    reportingManagerCode: _reportingManagerCode,
    ...schemaInput
  } = data;
  return schemaInput;
}

export function parseBulkCreatePin(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  return pinSchema.parse(trimmed);
}

export async function createEmployee(data, createdBy, options = {}) {
  const role = await resolveRole(data.roleId);
  const hasDepartments = (await Department.countDocuments({ isActive: true })) > 0;
  const prepared = await prepareEmployeeReferences(data, {
    roleSlug: role.slug,
    hasDepartments,
  });
  const parsed = buildEmployeeInputSchema({
    roleSlug: role.slug,
    hasDepartments,
    bulkImport: options.bulkImport === true,
  }).parse(stripBulkReferenceFields(prepared));
  const passwordHash = await bcrypt.hash(parsed.password, 12);
  // Bulk create honors the pin4 column (4-digit only). prepared.pin4 survives
  // reference stripping; the employee schema has no pin field so it is read raw.
  const rawCreatePin = parseBulkCreatePin(prepared.pin4);
  const pin4Hash = rawCreatePin ? await bcrypt.hash(rawCreatePin, 12) : null;
  const department = await resolveDepartment(parsed);
  const manager = parsed.reportingManagerId
    ? await resolveReportingManager(parsed.reportingManagerId)
    : null;
  const managedDepartments = parsed.managedDepartmentIds?.length
    ? await resolveManagedDepartments(parsed.managedDepartmentIds)
    : [];

  return persistEmployee(
    parsed,
    passwordHash,
    pin4Hash,
    role,
    department,
    manager,
    managedDepartments,
    createdBy,
  );
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

const headerMap = {
  id: 'id',
  firstname: 'firstName',
  lastname: 'lastName',
  email: 'email',
  mobile: 'mobile',
  password: 'password',
  // NOTE: keys must be lowercase — normalizeHeader() lowercases + strips spaces.
  pin4digite: 'pin4',
  employeecode: 'employeeCode',
  employeeid: 'employeeCode',
  department: 'department',
  designation: 'designation',
  reportingmanageremail: 'reportingManagerEmail',
  reportingmanagercode: 'reportingManagerCode',
  joiningdate: 'joiningDate',
  dateofbirth: 'dateOfBirth',
  dob: 'dateOfBirth',
  endingdate: 'endingDate',
  isactive: 'isActive',
};

const DATE_FIELDS = new Set(['joiningDate', 'dateOfBirth', 'endingDate']);

function formatIsoDateParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function excelSerialToIsoDate(serial) {
  if (!Number.isFinite(serial)) {
    return '';
  }

  let adjusted = serial;
  if (adjusted >= 60) {
    adjusted -= 1;
  }

  const date = new Date(Date.UTC(1899, 11, 30) + adjusted * 86400000);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return formatIsoDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function normalizeExcelDateCell(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return '';
    }
    return formatIsoDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number') {
    return excelSerialToIsoDate(value);
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const ddMmYyyy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (ddMmYyyy) {
    const day = Number(ddMmYyyy[1]);
    const month = Number(ddMmYyyy[2]);
    const year = Number(ddMmYyyy[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatIsoDateParts(year, month, day);
    }
  }

  return trimmed;
}

function normalizeCellValue(target, value) {
  if (DATE_FIELDS.has(target)) {
    return normalizeExcelDateCell(value);
  }
  return String(value ?? '').trim();
}

const EMPLOYEE_HEADER_SCAN_LIMIT = 12;

function isEmployeeHeaderCell(value) {
  const normalized = normalizeHeader(value);
  return (
    normalized === 'id' ||
    normalized === 'firstname' ||
    normalized === 'email' ||
    normalized === 'employeecode'
  );
}

function findEmployeeHeaderRowIndex(aoa) {
  const limit = Math.min(aoa.length, EMPLOYEE_HEADER_SCAN_LIMIT);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const row = aoa[rowIndex];
    if (!Array.isArray(row)) continue;
    if (row.some((cell) => isEmployeeHeaderCell(cell))) {
      return rowIndex;
    }
  }
  return -1;
}

function orderSheetsPreferringEmployees(sheetNames) {
  const preferred = sheetNames.find(
    (name) => normalizeHeader(name) === 'employees',
  );
  if (!preferred) return [...sheetNames];
  return [preferred, ...sheetNames.filter((name) => name !== preferred)];
}

export function parseEmployeeWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  if (!workbook.SheetNames.length) {
    throw new Error('The uploaded Excel file does not contain any sheets.');
  }

  for (const sheetName of orderSheetsPreferringEmployees(workbook.SheetNames)) {
    const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: '',
    });
    const headerRowIndex = findEmployeeHeaderRowIndex(aoa);
    if (headerRowIndex < 0) continue;

    const headerCells = aoa[headerRowIndex] ?? [];
    const columnKeys = headerCells.map(
      (cell) => headerMap[normalizeHeader(cell)] ?? null,
    );
    const dataRows = aoa.slice(headerRowIndex + 1);

    const mapped = [];
    dataRows.forEach((row, index) => {
      if (!Array.isArray(row)) return;
      if (row.every((cell) => String(cell ?? '').trim() === '')) return;
      const mappedRow = {};
      for (let columnIndex = 0; columnIndex < columnKeys.length; columnIndex += 1) {
        const target = columnKeys[columnIndex];
        if (target) {
          mappedRow[target] = normalizeCellValue(target, row[columnIndex]);
        }
      }
      // Skip rows that carry no identity and no editable content.
      const hasContent = Object.values(mappedRow).some(
        (value) => String(value ?? '').trim() !== '',
      );
      if (!hasContent) return;
      mapped.push({
        rowNumber: headerRowIndex + index + 2,
        data: mappedRow,
      });
    });

    if (mapped.length > MAX_BULK_UPLOAD_ROWS) {
      throw new Error(
        `The file contains ${mapped.length} rows. Maximum allowed is ${MAX_BULK_UPLOAD_ROWS}.`,
      );
    }

    return mapped;
  }

  throw new Error(
    'Could not find a header row with id, firstName, or email columns. Download a fresh employee directory export and try again.',
  );
}

function parseBooleanValue(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

function partitionRowsByFileDuplicates(rows) {
  const seenId = new Map();
  const seenEmail = new Map();
  const seenMobile = new Map();
  const seenCode = new Map();
  const duplicates = [];
  const uniqueRows = [];

  for (const row of rows) {
    const id = String(row.data.id ?? '').trim();
    const email = String(row.data.email ?? '')
      .trim()
      .toLowerCase();
    const mobile = normalizeMobile(row.data.mobile);
    const employeeCode = normalizeEmployeeCode(row.data.employeeCode);

    if (id) {
      if (seenId.has(id)) {
        duplicates.push({
          rowNumber: row.rowNumber,
          id,
          status: 'duplicate',
          email: row.data.email ?? '',
          message: `Duplicate employee id within file (first seen on row ${seenId.get(id)}).`,
        });
        continue;
      }
      seenId.set(id, row.rowNumber);
      uniqueRows.push(row);
      continue;
    }

    if (email && seenEmail.has(email)) {
      duplicates.push({
        rowNumber: row.rowNumber,
        id: '',
        status: 'duplicate',
        email: row.data.email ?? '',
        message: `Duplicate email within file (first seen on row ${seenEmail.get(email)}).`,
      });
      continue;
    }

    if (mobile && seenMobile.has(mobile)) {
      duplicates.push({
        rowNumber: row.rowNumber,
        id: '',
        status: 'duplicate',
        email: row.data.email ?? '',
        message: `Duplicate mobile within file (first seen on row ${seenMobile.get(mobile)}).`,
      });
      continue;
    }

    if (employeeCode && seenCode.has(employeeCode)) {
      duplicates.push({
        rowNumber: row.rowNumber,
        id: '',
        status: 'duplicate',
        email: row.data.email ?? '',
        message: `Duplicate employee code within file (first seen on row ${seenCode.get(employeeCode)}).`,
      });
      continue;
    }

    if (email) seenEmail.set(email, row.rowNumber);
    if (mobile) seenMobile.set(mobile, row.rowNumber);
    if (employeeCode) seenCode.set(employeeCode, row.rowNumber);
    uniqueRows.push(row);
  }

  return { duplicates, uniqueRows };
}

function stringifyDateValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    return getISTDateInputValue(value);
  }
  return String(value);
}

function compareField(current, proposed) {
  const currentStr = stringifyDateValue(current);
  const proposedStr = stringifyDateValue(proposed);
  return currentStr === proposedStr;
}

function applyFieldChange(user, field, newValue) {
  if (field === 'joiningDate' || field === 'dateOfBirth') {
    user[field] = newValue ? parseDateInputAsISTDay(newValue) : null;
  } else {
    user[field] = newValue;
  }
}

function buildUpdateMessage(changedFields, ignoredFields) {
  const parts = [];
  if (changedFields.length > 0) {
    parts.push(
      `Updated ${changedFields.length} field${changedFields.length === 1 ? '' : 's'}: ${changedFields.map((f) => f.field).join(', ')}.`,
    );
  }
  if (ignoredFields?.length > 0) {
    parts.push(
      `Ignored immutable fields: ${ignoredFields.map((f) => f.field).join(', ')}.`,
    );
  }
  return parts.join(' ') || 'No changes detected.';
}

async function upsertExistingEmployee(row, createdBy) {
  const rawId = String(row.data.id ?? '').trim();

  if (!/^[a-f\d]{24}$/i.test(rawId)) {
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: row.data.email ?? '',
      status: 'validation_error',
      message: 'Invalid employee id format.',
    };
  }

  const user = await User.findById(rawId).populate([
    { path: 'roleId', select: 'name slug permissions isSystem' },
    { path: 'departmentId', select: 'name code isActive' },
    { path: 'reportingManagerId', select: 'name email employeeCode' },
  ]);

  if (!user) {
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: row.data.email ?? '',
      status: 'validation_error',
      message: 'Employee with this id not found. It may have been deleted.',
    };
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  if (adminRole && user.roleId?.toString() === adminRole._id.toString()) {
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: user.email,
      status: 'validation_error',
      message: 'Admin accounts cannot be modified via bulk import.',
    };
  }

  const changedFields = [];
  const ignoredFields = [];

  const newEmail = String(row.data.email ?? '').trim().toLowerCase();
  if (newEmail && newEmail !== user.email) {
    ignoredFields.push({ field: 'email', from: user.email, to: newEmail });
  }

  const newMobile = normalizeMobile(row.data.mobile);
  if (newMobile && newMobile !== user.mobile) {
    ignoredFields.push({ field: 'mobile', from: user.mobile, to: newMobile });
  }

  const newFirstName = String(row.data.firstName ?? '').trim();
  if (newFirstName && newFirstName !== user.firstName) {
    if (newFirstName.length < 2 || newFirstName.length > 50) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'First name must be 2–50 characters.',
      };
    }
    changedFields.push({ field: 'firstName', from: user.firstName, to: newFirstName });
    user.firstName = newFirstName;
  }

  const newLastName = String(row.data.lastName ?? '').trim();
  if (newLastName !== (user.lastName || '')) {
    if (newLastName.length > 50) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'Last name must be at most 50 characters.',
      };
    }
    changedFields.push({ field: 'lastName', from: user.lastName || '', to: newLastName });
    user.lastName = newLastName;
  }

  const newDesignation = String(row.data.designation ?? '').trim();
  if (newDesignation && newDesignation !== (user.designation || '')) {
    if (newDesignation.length > 100) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'Designation must be at most 100 characters.',
      };
    }
    changedFields.push({ field: 'designation', from: user.designation || '', to: newDesignation });
    user.designation = newDesignation;
  }

  const newJoiningDate = String(row.data.joiningDate ?? '').trim();
  if (newJoiningDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newJoiningDate)) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'Joining date must use YYYY-MM-DD format.',
      };
    }
    const currentJoiningDate = user.joiningDate ? getISTDateInputValue(user.joiningDate) : '';
    if (newJoiningDate !== currentJoiningDate) {
      changedFields.push({
        field: 'joiningDate',
        from: currentJoiningDate,
        to: newJoiningDate,
      });
      user.joiningDate = parseDateInputAsISTDay(newJoiningDate);
    }
  }

  const newDateOfBirth = String(row.data.dateOfBirth ?? '').trim();
  const currentDateOfBirth = user.dateOfBirth ? getISTDateInputValue(user.dateOfBirth) : '';
  if (newDateOfBirth !== currentDateOfBirth) {
    if (newDateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(newDateOfBirth)) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'Date of birth must use YYYY-MM-DD format.',
      };
    }
    changedFields.push({
      field: 'dateOfBirth',
      from: currentDateOfBirth,
      to: newDateOfBirth || '',
    });
    user.dateOfBirth = newDateOfBirth ? parseDateInputAsISTDay(newDateOfBirth) : null;
  }

  const newEndingDate = String(row.data.endingDate ?? '').trim();
  const currentEndingDate = user.endingDate ? getISTDateInputValue(user.endingDate) : '';
  if (newEndingDate !== currentEndingDate) {
    if (newEndingDate && !/^\d{4}-\d{2}-\d{2}$/.test(newEndingDate)) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'Ending date must use YYYY-MM-DD format.',
      };
    }
    changedFields.push({
      field: 'endingDate',
      from: currentEndingDate,
      to: newEndingDate || '',
    });
    user.endingDate = newEndingDate ? new Date(newEndingDate) : null;
  }

  if (user.joiningDate && user.endingDate && user.endingDate < user.joiningDate) {
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: user.email,
      status: 'validation_error',
      message: 'Ending date must be on or after joining date.',
    };
  }

  const rawIsActive = String(row.data.isActive ?? '').trim().toLowerCase();
  if (rawIsActive) {
    const parsedIsActive = parseBooleanValue(rawIsActive);
    if (parsedIsActive === undefined) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'isActive must be TRUE or FALSE.',
      };
    }
    if (parsedIsActive !== user.isActive) {
      changedFields.push({
        field: 'isActive',
        from: String(user.isActive),
        to: String(parsedIsActive),
      });
      user.isActive = parsedIsActive;
    }
  }

  const newEmployeeCode = normalizeEmployeeCode(row.data.employeeCode);
  if (newEmployeeCode && newEmployeeCode !== (user.employeeCode || '')) {
    if (!isValidEmployeeCodeFormat(newEmployeeCode)) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message:
          'Employee code format is invalid. Must be 2–5 letters followed by 3–6 digits (e.g. EMP001).',
      };
    }
    const existing = await User.findOne({
      employeeCode: newEmployeeCode,
      _id: { $ne: user._id },
    }).lean();
    if (existing) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'duplicate',
        message: `Employee code "${newEmployeeCode}" is already in use by another employee.`,
      };
    }
    changedFields.push({
      field: 'employeeCode',
      from: user.employeeCode || '',
      to: newEmployeeCode,
    });
    user.employeeCode = newEmployeeCode;
  }

  const rawDepartment = String(row.data.department ?? '').trim();
  if (rawDepartment) {
    const dept = await Department.findOne({
      name: { $regex: new RegExp(`^${rawDepartment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      isActive: true,
    }).lean();
    if (!dept) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: `Department "${rawDepartment}" not found or inactive.`,
      };
    }
    const currentDeptId = user.departmentId?._id?.toString() ?? user.departmentId?.toString() ?? '';
    if (dept._id.toString() !== currentDeptId) {
      changedFields.push({
        field: 'department',
        from: user.departmentId?.name || user.department || '',
        to: dept.name,
      });
      user.departmentId = dept._id;
      user.department = dept.name;
    }
  }

  const rawManagerEmail = String(row.data.reportingManagerEmail ?? '').trim();
  const rawManagerCode = normalizeEmployeeCode(row.data.reportingManagerCode);
  if (rawManagerEmail || rawManagerCode) {
    const managerRoleIds = await Role.find({
      slug: {
        $in: [SYSTEM_ROLE_SLUGS.ADMIN, SYSTEM_ROLE_SLUGS.HR, SYSTEM_ROLE_SLUGS.REPORTING_MANAGER],
      },
    })
      .select('_id')
      .lean();
    const roleIds = managerRoleIds.map((r) => r._id);
    const baseQuery = { isActive: true, roleId: { $in: roleIds } };

    let manager = null;
    if (rawManagerEmail) {
      manager = await User.findOne({ ...baseQuery, email: rawManagerEmail.toLowerCase() })
        .select('_id email employeeCode')
        .lean();
    }
    if (!manager && rawManagerCode) {
      manager = await User.findOne({ ...baseQuery, employeeCode: rawManagerCode })
        .select('_id email employeeCode')
        .lean();
    }

    if (!manager) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: 'Reporting manager not found. Must be an active admin, HR, or reporting manager.',
      };
    }

    const currentManagerId = user.reportingManagerId?._id?.toString() ?? user.reportingManagerId?.toString() ?? '';
    if (manager._id.toString() !== currentManagerId) {
      changedFields.push({
        field: 'reportingManager',
        from: user.reportingManagerId?.email || currentManagerId || '',
        to: manager.email || manager._id.toString(),
      });
      user.reportingManagerId = manager._id;
    }
  }

  const rawPassword = String(row.data.password ?? '').trim();
  if (rawPassword) {
    try {
      passwordSchema.parse(rawPassword);
    } catch (err) {
      const msg =
        err instanceof z.ZodError
          ? err.issues.map((i) => i.message).join(' ')
          : err.message;
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: msg,
      };
    }
    const passwordHash = await bcrypt.hash(rawPassword, 12);
    user.passwordHash = passwordHash;
    user.pin4Hash = null;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    changedFields.push({ field: 'password', from: '***', to: '***' });
  }

  const rawPin4 = String(row.data.pin4 ?? '').trim();
  if (rawPin4) {
    user.pin4Hash = await bcrypt.hash(pinSchema.parse(rawPin4), 12);
    if (!rawPassword) {
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    }
    changedFields.push({ field: 'pin', from: user.pin4Hash ? '***' : '', to: '***' });
  }

  if (changedFields.length === 0 && ignoredFields.length === 0) {
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: user.email,
      status: 'unchanged',
      message: 'No changes detected.',
    };
  }

  await user.save();
  await user.populate(USER_POPULATE_FIELDS);

  return {
    rowNumber: row.rowNumber,
    id: rawId,
    email: user.email,
    status: changedFields.length > 0 ? 'updated' : 'unchanged',
    changedFields: changedFields.length > 0 ? changedFields : undefined,
    ignoredFields: ignoredFields.length > 0 ? ignoredFields : undefined,
    message: buildUpdateMessage(changedFields, ignoredFields),
  };
}

function handleCreateError(row, error) {
  if (error.code === 11000 || error.statusCode === 409) {
    const field = error.field ?? Object.keys(error.keyPattern ?? {})[0];
    return {
      rowNumber: row.rowNumber,
      id: '',
      status: 'duplicate',
      email: row.data.email ?? '',
      message: field ? duplicateFieldMessage(field) : 'Duplicate email, mobile, or employee code.',
    };
  }

  if (error instanceof z.ZodError) {
    return {
      rowNumber: row.rowNumber,
      id: '',
      status: 'validation_error',
      email: row.data.email ?? '',
      message: `New employee: ${error.issues.map((issue) => issue.message).join(' ')}`,
    };
  }

  if (error.statusCode === 400) {
    return {
      rowNumber: row.rowNumber,
      id: '',
      status: 'validation_error',
      email: row.data.email ?? '',
      message: `New employee: ${error.message ?? 'Validation failed.'}`,
    };
  }

  return {
    rowNumber: row.rowNumber,
    id: '',
    status: 'error',
    email: row.data.email ?? '',
    message: error.message ?? 'Failed to register employee.',
  };
}

export async function importEmployeesFromRowsUpsert(rows, createdBy) {
  const { duplicates: fileDuplicates, uniqueRows } = partitionRowsByFileDuplicates(rows);
  const results = [...fileDuplicates];

  for (const row of uniqueRows) {
    const rawId = String(row.data.id ?? '').trim();

    if (rawId) {
      try {
        const result = await upsertExistingEmployee(row, createdBy);
        results.push(result);
      } catch (error) {
        results.push({
          rowNumber: row.rowNumber,
          id: rawId,
          status: 'error',
          email: row.data.email ?? '',
          message: error.message ?? 'Failed to update employee.',
        });
      }
    } else {
      try {
        const employee = await createEmployee(row.data, createdBy, { bulkImport: true });
        results.push({
          rowNumber: row.rowNumber,
          id: employee.id,
          status: 'created',
          email: employee.email,
          message: 'Employee created successfully.',
        });
      } catch (error) {
        results.push(handleCreateError(row, error));
      }
    }
  }

  results.sort((a, b) => a.rowNumber - b.rowNumber);

  const summary = {
    total: results.length,
    created: results.filter((item) => item.status === 'created').length,
    updated: results.filter((item) => item.status === 'updated').length,
    unchanged: results.filter((item) => item.status === 'unchanged').length,
    duplicate: results.filter((item) => item.status === 'duplicate').length,
    validation_error: results.filter((item) => item.status === 'validation_error').length,
    error: results.filter((item) => item.status === 'error').length,
  };

  return { summary, results };
}

export async function importEmployeesFromRows(rows, createdBy) {
  const { duplicates: fileDuplicates, uniqueRows } = partitionRowsByFileDuplicates(rows);
  const results = [...fileDuplicates];

  for (const row of uniqueRows) {
    const rawId = String(row.data.id ?? '').trim();
    if (rawId) {
      results.push({
        rowNumber: row.rowNumber,
        id: rawId,
        status: 'validation_error',
        email: row.data.email ?? '',
        message: 'Legacy import mode does not support updating existing employees.',
      });
      continue;
    }

    try {
      const employee = await createEmployee(row.data, createdBy, { bulkImport: true });
      results.push({
        rowNumber: row.rowNumber,
        id: employee.id,
        status: 'success',
        email: employee.email,
        message: 'Employee registered successfully.',
      });
    } catch (error) {
      results.push(handleCreateError(row, error));
    }
  }

  results.sort((a, b) => a.rowNumber - b.rowNumber);

  const summary = {
    total: results.length,
    success: results.filter((item) => item.status === 'success').length,
    duplicate: results.filter((item) => item.status === 'duplicate').length,
    validation_error: results.filter((item) => item.status === 'validation_error').length,
    error: results.filter((item) => item.status === 'error').length,
  };

  return { summary, results };
}

export function buildEmployeeTemplateWorkbook() {
  const worksheet = XLSX.utils.aoa_to_sheet([
    [
      'firstName',
      'lastName',
      'email',
      'mobile',
      'password',
      'pin4Digite',
      'employeeCode',
      'department',
      'designation',
      'reportingManagerEmail',
      'reportingManagerCode',
      'joiningDate',
      'dateOfBirth',
      'endingDate',
    ],
    [
      'Jane',
      'Doe',
      'jane@grubpac.com',
      '9876543210',
      'Employee@123',
      '1234',
      'EMP001',
      'Development',
      'Software Engineer',
      'manager@grubpac.com',
      'TL001',
      '2026-01-15',
      '1995-06-20',
      '',
    ],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
