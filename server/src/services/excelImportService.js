import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import { generatePassword } from '../../../shared/utils/generatePassword.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Department } from '../models/Department.js';
import { buildEmployeeInputSchema } from '../../../shared/validation/employee.js';
import {
  indianMobileSchema,
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
  MAX_CREATE_ATTEMPTS,
  normalizeEmployeeCode,
  resolveEmployeeCodeForCreate,
} from './employeeCodeService.js';
import { getISTDateInputValue, parseDateInputAsISTDay } from '../utils/istDate.js';
import { COMPANY_START_DATE } from '../config/company.js';
import { sendWelcomeEmail } from './emailService.js';

export { normalizeMobile };

const ID_COLUMN_FILL = 'FFFFFBF0';
const BULK_EXPORT_HEADERS = [
  'firstName',
  'lastName',
  'email',
  'mobile',
  'employeeCode',
  'role',
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
/**
 * Best-effort dot-free display of a stored mobile number: strips every
 * non-digit (dots, spaces, +) so the export never shows values like
 * "96909.8452". Prefers the plain digit string; falls back to the
 * +91-tolerant normalization when that yields a valid number.
 */
export function displayMobileForExport(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (/^[6-9]\d{9}$/.test(digits)) return digits;
  const normalized = normalizeMobile(raw);
  if (/^[6-9]\d{9}$/.test(normalized)) return normalized;
  return digits;
}

export function buildDirectoryExportRow(user) {
  const manager = user.reportingManagerId;
  return [
    user.firstName || '',
    user.lastName || '',
    user.email || '',
    displayMobileForExport(user.mobile),
    user.employeeCode || '',
    user.roleId?.name || user.role || '',
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
      'firstName lastName email mobile employeeCode roleId department designation departmentId reportingManagerId joiningDate dateOfBirth endingDate isActive',
    )
    .populate([
      { path: 'roleId', select: 'name slug' },
      { path: 'departmentId', select: 'name code isActive' },
      { path: 'reportingManagerId', select: 'name email employeeCode' },
    ])
    .sort({ employeeCode: 1, name: 1 })
    .lean();

  const roleOptions = await Role.find({}).select('name slug').sort({ name: 1 }).lean();
  const roleNames = [...new Set(roleOptions.map((role) => String(role.name || '').trim()).filter(Boolean))];

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
    ['• The "email" column is the unique employee identifier. Do NOT edit email values.'],
    ['• Rows whose email matches an existing employee will UPDATE that record.'],
    ['• Rows with a NEW email will CREATE a new employee.'],
    ['• The "email", "mobile", and "employeeCode" columns are IMMUTABLE via bulk import. Any change to mobile or employeeCode fails that row with a validation error naming the employee.'],
    ['• Exception: a malformed stored mobile (not a valid 10-digit number) can be healed by entering a valid 10-digit mobile in the file.'],
    ['• To change email or mobile, use the individual employee edit form.'],
    ['• There are NO password or PIN columns. New employees get an auto-generated password (Firstname@EmpCode, e.g. Kenny@EMP108), are emailed their login credentials individually, and must change the temporary password on first sign-in.'],
    ['• NEW employees REQUIRE: firstName, lastName, email, mobile, joiningDate, designation, role, department, and reportingManagerEmail.'],
    ['• Pick "role" from the dropdown list in the role column.'],
    ['• "role" changes apply to existing employees too (admin accounts excluded). Reporting-manager works on direct-reports scope; assign managed departments from the user edit page for wider team visibility.'],
    ['• Leave "employeeCode" BLANK to auto-generate it (EMP001, EMP002, ...). A filled code is kept if valid and unused.'],
    ['• "isActive" must be TRUE or FALSE.'],
    ['• Dates must use YYYY-MM-DD format.'],
    ['• "reportingManagerEmail" or "reportingManagerCode" must match an active admin, HR, or reporting manager.'],
    ['• "department" must match an active department name (case-insensitive).'],
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
  instructionCell.value = 'Rows whose email matches an existing employee will UPDATE that record. New emails will CREATE employees. Email, mobile, and employee code are immutable via bulk import.';
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
      if (colNumber === 4) {
        // Mobile column (D): force text format so Excel never reinterprets
        // digit strings as floats (which is how "96909.8452"-style values
        // are born on re-import).
        cell.numFmt = '@';
      }
      if (colNumber === 3) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ID_COLUMN_FILL } };
        cell.font = { color: { argb: 'FF92400E' }, size: 10, name: 'Calibri' };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }
    });
  }

  worksheet.columns = [
    { width: 16 },
    { width: 16 },
    { width: 30 },
    { width: 14 },
    { width: 14 },
    { width: 20 },
    { width: 20 },
    { width: 22 },
    { width: 28 },
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 10 },
  ];

  // Role dropdown on the role column (F) for every possible data row, so new
  // employee rows added below the export also get the pick list.
  const roleColumnLetter = 'F';
  const roleValidationLastRow = TEMPLATE_DATA_START_ROW + MAX_BULK_UPLOAD_ROWS - 1;
  const roleFormula = `"${roleNames.map((name) => name.replace(/"/g, '""')).join(',')}"`;
  if (roleNames.length > 0 && roleFormula.length <= 255) {
    worksheet.dataValidations.add(
      `${roleColumnLetter}${TEMPLATE_DATA_START_ROW}:${roleColumnLetter}${roleValidationLastRow}`,
      {
        type: 'list',
        allowBlank: true,
        formulae: [roleFormula],
        showErrorMessage: true,
        errorTitle: 'Invalid role',
        error: 'Pick a role from the dropdown list.',
        promptTitle: 'Role',
        prompt: 'Pick the employee role from the list.',
        showInputMessage: true,
      },
    );
  }

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
  retryOnCodeConflict = false,
  passwordBox = null,
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
        // Legacy `department` text is no longer stored; the name resolves
        // from the Department master via departmentId.
        department: undefined,
        departmentId: department?._id ?? undefined,
        reportingManagerId: manager?._id ?? undefined,
        managedDepartmentIds: managedDepartments,
        passwordHash,
        pin4Hash,
        createdBy,
        isActive: true,
        forcePasswordChange: true,
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
        if ((autoGenerated || retryOnCodeConflict) && duplicate.field === 'employeeCode') {
          employeeCode = await allocateNextEmployeeCode();
          // Bulk auto passwords embed the code — regenerate so First@Code stays true.
          if (passwordBox) {
            passwordBox.current = generateBulkPassword(passwordBox.firstName, employeeCode);
            passwordHash = await bcrypt.hash(passwordBox.current, 12);
          }
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

function escapeRegexLiteral(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the bulk `role` column (role name or slug, case-insensitive) to a
 * Role document. Any role — including admin — may be assigned via bulk.
 */
export async function resolveRoleByNameOrSlug(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    const error = new Error('Role is required for new employees. Pick a role from the dropdown list.');
    error.statusCode = 400;
    throw error;
  }
  const slugKey = raw.toLowerCase().replace(/\s+/g, '-');
  const role =
    (await Role.findOne({ slug: slugKey }).lean()) ??
    (await Role.findOne({ name: { $regex: new RegExp(`^${escapeRegexLiteral(raw)}$`, 'i') } }).lean());
  if (!role) {
    const error = new Error(`Role "${raw}" not found. Pick a role from the dropdown list.`);
    error.statusCode = 400;
    throw error;
  }
  return role;
}

/**
 * Auto password for bulk-created employees: first name (first token, first
 * letter capitalized) + '@' + employee code, e.g. Kenny@EMP108. Pads with
 * 'a1' until the shared password policy passes (covers short/all-caps names).
 */
export function generateBulkPassword(firstName, employeeCode) {
  const token = String(firstName ?? '').split(/\s+/).filter(Boolean)[0] ?? '';
  const capitalized = token ? token.charAt(0).toUpperCase() + token.slice(1) : 'User';
  let candidate = `${capitalized}@${employeeCode}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      passwordSchema.parse(candidate);
      return candidate;
    } catch {
      candidate += 'a1';
    }
  }
  const error = new Error('Unable to generate a valid password for this employee.');
  error.statusCode = 400;
  throw error;
}

export async function createEmployee(data, createdBy, options = {}) {
  const isBulkImport = options.bulkImport === true;
  let bulkAutoCode = false;
  let bulkPasswordPlaintext = null;
  if (isBulkImport) {
    data = { ...data };
    // Removed template columns (id/password/PIN) are dropped by the parser;
    // defense-in-depth in case callers bypass parsing. Identity is email,
    // passwords auto-generate, PINs are not set via bulk.
    delete data.id;
    delete data.password;
    delete data.pin4;
    // Role is mandatory on bulk create; accepts name or slug (any role allowed).
    const bulkRole = await resolveRoleByNameOrSlug(data.role);
    data.roleId = bulkRole._id.toString();
    delete data.role;
    // Employee code: blank auto-generates; a filled code is kept when valid.
    const givenCode = normalizeEmployeeCode(data.employeeCode);
    if (!givenCode) {
      const resolved = await resolveEmployeeCodeForCreate('');
      data.employeeCode = resolved.code;
      bulkAutoCode = true;
    }
    bulkPasswordPlaintext = generateBulkPassword(data.firstName, normalizeEmployeeCode(data.employeeCode));
    data.password = bulkPasswordPlaintext;
  }
  let passwordBox = options.passwordBox ?? null;
  if (isBulkImport && !passwordBox) {
    passwordBox = { firstName: '', current: null };
  }
  if (passwordBox) {
    passwordBox.firstName = String(data.firstName ?? '');
    passwordBox.current = bulkPasswordPlaintext;
  }
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
  // No PIN via bulk import: new employees set it up afterwards.
  const pin4Hash = null;
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
    bulkAutoCode,
    passwordBox,
  );
}

/**
 * Bulk create that also hands back the auto-generated plaintext password.
 * The password is returned ONLY here (shown once in upload results) — it is
 * never persisted or logged anywhere.
 */
export async function createEmployeeAndPassword(data, createdBy) {
  const box = { firstName: String(data.firstName ?? ''), current: null };
  const employee = await createEmployee(data, createdBy, { bulkImport: true, passwordBox: box });
  return { employee, generatedPassword: box.current };
}

/**
 * Read-only mirror of the bulk-create validation inside createEmployee().
 * Resolves role/code/department/manager, runs the same input schema, and
 * checks uniqueness — but never hashes, never writes, never emails. Used by
 * the preview (dry-run) step so the review table matches what sync will do.
 * Returns `{ name, employeeCode }` for the preview row; throws on invalid.
 */
export async function validateNewEmployeeForPreview(data) {
  const input = { ...data };
  const bulkRole = await resolveRoleByNameOrSlug(input.role);
  const role = await resolveRole(bulkRole._id.toString());
  // Mirror the sync path: blank codes preview as auto-allocated, and the
  // auto password (required by schema) is generated from the final code.
  const previewGivenCode = normalizeEmployeeCode(input.employeeCode);
  const previewCode = previewGivenCode || (await resolveEmployeeCodeForCreate('')).code;
  input.employeeCode = previewCode;
  input.password = generateBulkPassword(input.firstName, previewCode);
  const hasDepartments = (await Department.countDocuments({ isActive: true })) > 0;
  const prepared = await prepareEmployeeReferences(
    { ...input, roleId: bulkRole._id.toString() },
    { roleSlug: role.slug, hasDepartments },
  );
  const parsed = buildEmployeeInputSchema({
    roleSlug: role.slug,
    hasDepartments,
    bulkImport: true,
  }).parse(stripBulkReferenceFields(prepared));

  const department = await resolveDepartment(parsed);
  if (parsed.reportingManagerId) {
    await resolveReportingManager(parsed.reportingManagerId);
  }
  if (parsed.managedDepartmentIds?.length) {
    await resolveManagedDepartments(parsed.managedDepartmentIds);
  }

  // persistEmployee date guards (mirrored so preview agrees with sync).
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

  // Uniqueness checks (sync surfaces these as duplicate-key errors at create).
  const email = String(parsed.email).toLowerCase();
  const mobile = normalizeMobile(parsed.mobile);
  const givenCode = normalizeEmployeeCode(parsed.employeeCode);
  const { code: employeeCode } = await resolveEmployeeCodeForCreate(parsed.employeeCode);
  if (await User.exists({ email })) {
    const error = new Error(duplicateFieldMessage('email'));
    error.statusCode = 409;
    error.field = 'email';
    error.code = 11000;
    throw error;
  }
  if (mobile && (await User.exists({ mobile }))) {
    const error = new Error(duplicateFieldMessage('mobile'));
    error.statusCode = 409;
    error.field = 'mobile';
    error.code = 11000;
    throw error;
  }
  if (givenCode && (await User.exists({ employeeCode: givenCode }))) {
    const error = new Error(duplicateFieldMessage('employeeCode'));
    error.statusCode = 409;
    error.field = 'employeeCode';
    error.code = 11000;
    throw error;
  }

  return {
    name: `${parsed.firstName} ${parsed.lastName ?? ''}`.trim(),
    employeeCode,
  };
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

// Columns removed from the bulk template. If present in an uploaded file
// they are ignored and reported as warnings (never applied).
// NOTE: keys must be lowercase — normalizeHeader() lowercases + strips spaces.
const REMOVED_COLUMNS = {
  id: 'ID',
  password: 'Password',
  pin4digite: 'PIN',
};

const headerMap = {
  firstname: 'firstName',
  lastname: 'lastName',
  email: 'email',
  mobile: 'mobile',
  // NOTE: keys must be lowercase — normalizeHeader() lowercases + strips spaces.
  employeecode: 'employeeCode',
  employeeid: 'employeeCode',
  role: 'role',
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
    const removedPresent = [];
    const columnKeys = headerCells.map((cell) => {
      const normalized = normalizeHeader(cell);
      if (Object.hasOwn(REMOVED_COLUMNS, normalized) && !removedPresent.includes(normalized)) {
        removedPresent.push(normalized);
      }
      return headerMap[normalized] ?? null;
    });
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

    // Non-fatal file-level warnings (attached, not thrown, so the rows array
    // shape stays compatible with existing callers).
    mapped.warnings = removedPresent.map(
      (key) =>
        `Column '${REMOVED_COLUMNS[key]}' is no longer supported and was ignored. ` +
        `IDs are system-managed; passwords and PINs are set by the employee via Change Password.`,
    );
    return mapped;
  }

  throw new Error(
    'Could not find a header row with firstName, email, or employeeCode columns. Download a fresh employee directory export and try again.',
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
  const seenEmail = new Map();
  const seenMobile = new Map();
  const seenCode = new Map();
  const duplicates = [];
  const uniqueRows = [];

  for (const row of rows) {
    const email = String(row.data.email ?? '')
      .trim()
      .toLowerCase();
    const mobile = normalizeMobile(row.data.mobile);
    const employeeCode = normalizeEmployeeCode(row.data.employeeCode);

    if (email && seenEmail.has(email)) {
      duplicates.push({
        rowNumber: row.rowNumber,
        id: '',
        status: 'duplicate',
        email: row.data.email ?? '',
        message: `Duplicate email within file (first seen on row ${seenEmail.get(email)}). Only the first occurrence is applied.`,
      });
      continue;
    }

    if (mobile && seenMobile.has(mobile)) {
      duplicates.push({
        rowNumber: row.rowNumber,
        id: '',
        status: 'duplicate',
        email: row.data.email ?? '',
        message: `Duplicate mobile within file (first seen on row ${seenMobile.get(mobile)}). Only the first occurrence is applied.`,
      });
      continue;
    }

    if (employeeCode && seenCode.has(employeeCode)) {
      duplicates.push({
        rowNumber: row.rowNumber,
        id: '',
        status: 'duplicate',
        email: row.data.email ?? '',
        message: `Duplicate employee code within file (first seen on row ${seenCode.get(employeeCode)}). Only the first occurrence is applied.`,
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

async function upsertExistingEmployee(row, user, options = {}) {
  // The dispatcher already matched this row to `user` by email (the bulk
  // identity). Email therefore cannot differ. A mismatch on a VALID stored
  // mobile/employeeCode is a per-row validation error. A malformed stored
  // mobile may be healed by supplying a valid 10-digit replacement.
  const rawId = user._id.toString();

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  const userRoleId = user.roleId?._id?.toString() ?? user.roleId?.toString() ?? '';
  if (adminRole && userRoleId === adminRole._id.toString()) {
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

  const newMobile = normalizeMobile(row.data.mobile);
  const storedMobileDigits = normalizeMobile(user.mobile);
  const currentMobileValid = indianMobileSchema.safeParse(user.mobile ?? '').success;
  if (!newMobile || newMobile === storedMobileDigits) {
    // No change: empty cell, or re-upload of the same stored digits (valid or
    // not). Corrupt stored values are fixed via the edit form or by entering
    // a valid 10-digit replacement in the file — re-uploading never errors.
  } else if (!currentMobileValid) {
    // Stored number is malformed and the file proposes a different value:
    // only a valid 10-digit replacement is accepted (heal path).
    if (!indianMobileSchema.safeParse(newMobile).success) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: `Mobile number on file for ${user.email} is invalid (existing ${user.mobile || '—'}). Enter a valid 10-digit mobile in the file or update it from the employee profile.`,
      };
    }
    const taken = await User.findOne({ mobile: newMobile, _id: { $ne: user._id } })
      .select('_id')
      .lean();
    if (taken) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: `Mobile number ${newMobile} is already in use by another employee.`,
      };
    }
    changedFields.push({ field: 'mobile', from: user.mobile || '', to: newMobile });
    user.mobile = newMobile;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  } else {
    // Stored number is valid and the file proposes a different value: blocked.
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: user.email,
      status: 'validation_error',
      message: `Mobile number cannot be changed via bulk upload for ${user.email} (existing ${user.mobile}, file has ${newMobile}). Update it from the employee profile instead.`,
    };
  }

  const newFileCode = normalizeEmployeeCode(row.data.employeeCode);
  if (newFileCode && newFileCode !== (user.employeeCode || '')) {
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: user.email,
      status: 'validation_error',
      message: `Employee ID cannot be changed via bulk upload for ${user.email} (existing ${user.employeeCode || '—'}, file has ${newFileCode}).`,
    };
  }

  const rawRole = String(row.data.role ?? '').trim();
  let updatedRole = null;
  if (rawRole) {
    try {
      updatedRole = await resolveRoleByNameOrSlug(rawRole);
    } catch {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message: `Role "${rawRole}" not found. Pick a role from the dropdown list.`,
      };
    }
    const currentRoleId = user.roleId?._id?.toString() ?? user.roleId?.toString() ?? '';
    if (updatedRole._id.toString() !== currentRoleId) {
      changedFields.push({
        field: 'role',
        from: user.roleId?.name || user.role || '',
        to: updatedRole.name,
      });
      user.roleId = updatedRole._id;
      user.role = legacyRoleFromSlug(updatedRole.slug);
    } else {
      updatedRole = null;
    }
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
      // Legacy text no longer written; resolves from the Department master.
      user.department = undefined;
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

  // Role changes must leave the record in a valid org state (mirrors the
  // create-time rules: employees need a manager. Promoting to
  // reporting-manager is allowed without managed departments — the RM works
  // on direct-reports scope until departments are assigned from the edit
  // page for wider team visibility.
  if (updatedRole) {
    if (updatedRole.slug === SYSTEM_ROLE_SLUGS.EMPLOYEE && !user.reportingManagerId) {
      return {
        rowNumber: row.rowNumber,
        id: rawId,
        email: user.email,
        status: 'validation_error',
        message:
          'Reporting manager is required for the employee role. Provide reportingManagerEmail in the same row or set it individually.',
      };
    }
  }

  // Passwords and PINs are never changed via bulk import (no such columns).
  // Use the employee edit page or reset flows for credential changes.

  if (changedFields.length === 0 && ignoredFields.length === 0) {
    return {
      rowNumber: row.rowNumber,
      id: rawId,
      email: user.email,
      status: 'unchanged',
      message: 'No changes detected.',
    };
  }

  // Dry-run (preview) computes the identical diff/validation but persists nothing.
  if (!options.dryRun) {
    await user.save();
    await user.populate(USER_POPULATE_FIELDS);
  }

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

export async function importEmployeesFromRowsUpsert(rows, createdBy, options = {}) {
  const dryRun = options.dryRun === true;
  const { duplicates: fileDuplicates, uniqueRows } = partitionRowsByFileDuplicates(rows);
  const results = [...fileDuplicates];
  const createdEmployees = [];

  for (const row of uniqueRows) {
    const email = String(row.data.email ?? '').trim().toLowerCase();

    if (!email) {
      results.push({
        rowNumber: row.rowNumber,
        id: '',
        status: 'validation_error',
        email: row.data.email ?? '',
        message: 'Email is required — it identifies the employee. Rows without an email are skipped.',
      });
      continue;
    }

    try {
      const existing = await User.findOne({ email }).populate([
        { path: 'roleId', select: 'name slug permissions isSystem' },
        { path: 'departmentId', select: 'name code isActive' },
        { path: 'reportingManagerId', select: 'name email employeeCode' },
      ]);

      if (existing) {
        const result = await upsertExistingEmployee(row, existing, { dryRun });
        results.push(result);
      } else if (dryRun) {
        const preview = await validateNewEmployeeForPreview(row.data);
        results.push({
          rowNumber: row.rowNumber,
          id: '',
          status: 'created',
          email,
          name: preview.name,
          employeeCode: preview.employeeCode,
          generatedPassword: null,
          emailStatus: null,
          preview: true,
          message:
            'Will create this employee on sync. Login credentials will be emailed and the temporary password must be changed on first sign-in.',
        });
      } else {
        const created = await createEmployeeAndPassword(row.data, createdBy);
        results.push({
          rowNumber: row.rowNumber,
          id: created.employee.id,
          status: 'created',
          email: created.employee.email,
          name: created.employee.name,
          employeeCode: created.employee.employeeCode,
          generatedPassword: created.generatedPassword,
          message: 'Employee created successfully. Share the generated password securely — it is shown only here.',
        });
      }
    } catch (error) {
      results.push(handleCreateError(row, error));
    }
  }

  // Welcome emails for newly created employees (Req 7). Flag them for a
  // forced password change first, then send one email each with a capped
  // concurrency. Email failures are recorded per row — they never fail the
  // import, and the generated password remains visible in the results.
  // Skipped entirely for dry-run previews (nothing is created or sent).
  const createdRows = dryRun
    ? []
    : results.filter((item) => item.status === 'created' && item.generatedPassword);
  if (createdRows.length > 0) {
    await User.updateMany(
      { _id: { $in: createdRows.map((item) => item.id) } },
      { $set: { mustChangePassword: true } },
    );
    const EMAIL_CONCURRENCY = 5;
    for (let index = 0; index < createdRows.length; index += EMAIL_CONCURRENCY) {
      const batch = createdRows.slice(index, index + EMAIL_CONCURRENCY);
      const outcomes = await Promise.all(
        batch.map(async (item) => {
          try {
            const sent = await sendWelcomeEmail({
              to: item.email,
              name: item.name,
              tempPassword: item.generatedPassword,
            });
            return Boolean(sent?.delivered);
          } catch {
            return false;
          }
        }),
      );
      batch.forEach((item, batchIndex) => {
        item.emailStatus = outcomes[batchIndex] ? 'sent' : 'failed';
        item.message =
          item.emailStatus === 'sent'
            ? 'Employee created successfully. Login credentials emailed to the employee.'
            : 'Employee created successfully. Credentials email could not be delivered — share the generated password securely, it is shown only here.';
      });
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
    emailsSent: results.filter((item) => item.emailStatus === 'sent').length,
    emailsFailed: results.filter((item) => item.emailStatus === 'failed').length,
  };

  return { summary, results, ...(dryRun ? { preview: true } : {}) };
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
  const workbook = XLSX.utils.book_new();

  const instructionsData = [
    ['New Employee Bulk Upload Template'],
    [''],
    ['IMPORTANT RULES:'],
    ['• Each row will CREATE a new employee.'],
    ['• The "email", "mobile", and "employeeCode" columns are IMMUTABLE. Any changes will be rejected.'],
    ['• To change email, mobile, or employeeCode later, use the individual employee edit form.'],
    ['• A temporary password will be automatically generated and emailed to the new employee.'],
    ['• Required fields: firstName, email, mobile, designation, joiningDate, department, reportingManagerEmail.'],
    ['• "employeeCode" format: 2–5 letters followed by 3–6 digits (e.g. EMP001, TL001). Leave blank to auto-generate.'],
    ['• "isActive" must be TRUE or FALSE.'],
    ['• Dates must use YYYY-MM-DD format.'],
    ['• "reportingManagerEmail" or "reportingManagerCode" must match an active admin, HR, or reporting manager.'],
    ['• "department" must match an active department name (case-insensitive).'],
    ['• Maximum rows: 500 per upload.'],
  ];
  const instructionsSheet = XLSX.utils.aoa_to_sheet(instructionsData);
  instructionsSheet['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, 'Instructions');

  const worksheet = XLSX.utils.aoa_to_sheet([
    [
      'firstName',
      'lastName',
      'email',
      'mobile',
      'role',
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
      'Employee',
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
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
