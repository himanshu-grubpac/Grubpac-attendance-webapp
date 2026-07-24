import bcrypt from 'bcryptjs';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { User } from '../models/User.js';
import { employeeInputSchema } from '../../../shared/validation/employee.js';
import {
  MAX_BULK_UPLOAD_ROWS,
  normalizeMobile,
} from '../../../shared/validation/common.js';
import {
  legacyRoleFromSlug,
  resolveDepartment,
  resolveReportingManager,
  resolveRole,
} from './userOrgService.js';

export { normalizeMobile };

export async function createEmployee(data, createdBy) {
  const parsed = employeeInputSchema.parse(data);
  const passwordHash = await bcrypt.hash(parsed.password, 12);
  const role = await resolveRole(parsed.roleId);
  const department = await resolveDepartment(parsed);
  const manager = parsed.reportingManagerId
    ? await resolveReportingManager(parsed.reportingManagerId)
    : null;

  const user = await User.create({
    role: legacyRoleFromSlug(role.slug),
    roleId: role._id,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    name: `${parsed.firstName} ${parsed.lastName}`.trim(),
    email: parsed.email.toLowerCase(),
    mobile: parsed.mobile,
    employeeCode: parsed.employeeCode || undefined,
    designation: parsed.designation || undefined,
    joiningDate: parsed.joiningDate,
    endingDate: parsed.endingDate ?? null,
    department: department?.name ?? parsed.department ?? undefined,
    departmentId: department?._id ?? undefined,
    reportingManagerId: manager?._id ?? undefined,
    passwordHash,
    createdBy,
    isActive: true,
  });

  await user.populate([
    { path: 'roleId', select: 'name slug permissions isSystem' },
    { path: 'departmentId', select: 'name code isActive' },
    { path: 'reportingManagerId', select: 'name email' },
  ]);

  return user.toSafeJSON();
}

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

const headerMap = {
  firstname: 'firstName',
  lastname: 'lastName',
  email: 'email',
  mobile: 'mobile',
  password: 'password',
  employeecode: 'employeeCode',
  employeeid: 'employeeCode',
  department: 'department',
  designation: 'designation',
  joiningdate: 'joiningDate',
  endingdate: 'endingDate',
};

export function parseEmployeeWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('The uploaded Excel file does not contain any sheets.');
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: '',
  });

  if (rows.length > MAX_BULK_UPLOAD_ROWS) {
    throw new Error(
      `The file contains ${rows.length} rows. Maximum allowed is ${MAX_BULK_UPLOAD_ROWS}.`,
    );
  }

  return rows.map((row, index) => {
    const mapped = {};
    for (const [key, value] of Object.entries(row)) {
      const normalized = normalizeHeader(key);
      const target = headerMap[normalized];
      if (target) {
        mapped[target] = String(value ?? '').trim();
      }
    }
    return { rowNumber: index + 2, data: mapped };
  });
}

export async function importEmployeesFromRows(rows, createdBy) {
  const results = [];

  for (const row of rows) {
    try {
      const employee = await createEmployee(row.data, createdBy);
      results.push({
        rowNumber: row.rowNumber,
        status: 'success',
        email: employee.email,
        message: 'Employee registered successfully.',
      });
    } catch (error) {
      if (error.code === 11000) {
        results.push({
          rowNumber: row.rowNumber,
          status: 'duplicate',
          email: row.data.email ?? '',
          message: 'Duplicate email, mobile, or employee code.',
        });
        continue;
      }

      if (error instanceof z.ZodError) {
        results.push({
          rowNumber: row.rowNumber,
          status: 'validation_error',
          email: row.data.email ?? '',
          message: error.issues.map((issue) => issue.message).join(' '),
        });
        continue;
      }

      results.push({
        rowNumber: row.rowNumber,
        status: 'error',
        email: row.data.email ?? '',
        message: error.message ?? 'Failed to register employee.',
      });
    }
  }

  const summary = {
    total: results.length,
    success: results.filter((item) => item.status === 'success').length,
    duplicate: results.filter((item) => item.status === 'duplicate').length,
    validation_error: results.filter(
      (item) => item.status === 'validation_error',
    ).length,
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
      'employeeCode',
      'department',
      'designation',
      'joiningDate',
      'endingDate',
    ],
    [
      'Jane',
      'Doe',
      'jane@grubpac.com',
      '9876543210',
      'Employee@123',
      'EMP001',
      'Development',
      'Software Engineer',
      '2026-01-15',
      '',
    ],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
