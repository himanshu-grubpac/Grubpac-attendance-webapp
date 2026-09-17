import bcrypt from 'bcryptjs';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { SYSTEM_ROLE_SLUGS, PERMISSIONS, canViewSalaryFields, hasPermission } from '../../../shared/permissions.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Department } from '../models/Department.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { WeekAttendanceConfirmation } from '../models/WeekAttendanceConfirmation.js';
import {
  buildEmployeeDirectoryWorkbook,
  createEmployee,
  importEmployeesFromRowsUpsert,
  parseEmployeeWorkbook,
} from '../services/excelImportService.js';
import { getAdminAttendance, adminEditAttendanceRecord, adminUpsertAttendanceForDay, getTeamTodayStatusService } from '../services/attendanceService.js';
import {
  getQuarterWarningSummaryForUsers,
  resetQuarterWarningsForUsers,
} from '../services/attendancePolicyService.js';
import { officeUpdateSchema } from '../../../shared/validation/office.js';
import { paginationSchema, objectIdSchema } from '../../../shared/validation/common.js';
import { adminResetPasswordSchema, adminResetPinSchema } from '../../../shared/validation/auth.js';
import {
  adminAttendanceEditSchema,
  adminAttendanceUpsertSchema,
  resetQuarterWarningsSchema,
} from '../../../shared/validation/attendance.js';
import { AUDIT_LOG_EXPORT_MAX_ROWS, auditLogExportSchema, auditLogQuerySchema } from '../../../shared/validation/audit.js';
import {
  buildEmployeeProfileUpdateSchema,
  isProfileOrgUpdate,
  updateEmployeeOrgSchema,
} from '../../../shared/validation/employee.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
import { generatePassword } from '../../../shared/utils/generatePassword.js';
import { sendWelcomeEmail } from '../services/emailService.js';
import {
  endOfDayIST,
  getISTDateInputValue,
  parseDateInputAsISTDay,
  parseMonthInputAsISTRange,
  startOfDayIST,
} from '../utils/istDate.js';
import {
  legacyRoleFromSlug,
  resolveDepartment,
  resolveDelegateApprover,
  resolveManagedDepartments,
  resolveReportingManager,
  resolveRole,
} from '../services/userOrgService.js';
import {
  applyTeamScopeToEmployeeQuery as applyEmployeeTeamScope,
  isUserInTeamScope,
  resolveTeamScopedUserIds,
} from '../services/teamScopeService.js';

function refId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString();
  return value.toString();
}

function toEmployeeDateInputValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return getISTDateInputValue(date);
}

function assertEmployeeDateRange(joiningDate, endingDate) {
  if (!joiningDate || !endingDate || endingDate >= joiningDate) return null;
  return {
    message: 'Ending date must be on or after joining date.',
    field: 'endingDate',
  };
}
import { auditActionMatchers, auditAllActionMatchers, auditRequest, auditRequestSync, getRequestAuditContext, resolveAuditDisplayEmail, resolveAuditDisplayRole, resolveAuditModule } from '../utils/auditLog.js';
import { AuditLog } from '../models/AuditLog.js';
import { enrichAuditLogsWithConflicts } from '../services/deviceConflictService.js';
const attendanceQuerySchema = paginationSchema
  .extend({
    userId: objectIdSchema.optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
      .optional(),
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD.')
      .optional(),
    search: z.string().trim().max(100).optional(),
    type: z.enum(['check_in', 'check_out']).optional(),
    status: z.enum(['allowed', 'rejected']).optional(),
  })
  .refine((value) => !(value.date && value.weekStart), {
    message: 'Use either date or weekStart, not both.',
  });

const employeeListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === 'true' ? true : value === 'false' ? false : undefined)),
  departmentId: objectIdSchema.optional(),
  roleId: objectIdSchema.optional(),
  createdAfter: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'createdAfter must be YYYY-MM-DD.')
    .optional(),
});

async function buildEmployeeDirectoryQuery() {
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  return adminRole ? { roleId: { $ne: adminRole._id } } : { role: { $ne: 'admin' } };
}

async function applyEmployeeListFilters(query, { search, isActive, departmentId, roleId, createdAfter }) {
  if (typeof isActive === 'boolean') {
    query.isActive = isActive;
  }

  if (departmentId) {
    query.departmentId = departmentId;
  }

  if (roleId) {
    query.roleId = roleId;
  }

  if (createdAfter) {
    const dayStart = startOfDayIST(parseDateInputAsISTDay(createdAfter));
    if (dayStart) {
      query.createdAt = { $gte: dayStart };
    }
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    const matchingDepts = await Department.find({ name: regex }).select('_id').lean();
    const deptIds = matchingDepts.map((d) => d._id);
    query.$or = [
      { name: regex },
      { email: regex },
      { mobile: regex },
      { employeeCode: regex },
      ...(deptIds.length > 0 ? [{ departmentId: { $in: deptIds } }] : []),
    ];
  }

  return query;
}

function applyTeamScopeToEmployeeQuery(query, req) {
  return applyEmployeeTeamScope(
    query,
    req.user,
    req.userPermissions,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
}

async function assertEmployeeInTeamScope(req, employeeId) {
  return isUserInTeamScope(
    req.user,
    req.userPermissions,
    employeeId,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
}

export async function registerEmployee(req, res) {
  // Auto-generate a temporary password and email it to the new employee.
  // The plaintext exists only in this request scope — never persisted/logged.
  const sendCredentialsEmail = req.body?.sendCredentialsEmail === true;
  const body = { ...req.body };
  let tempPassword = null;
  if (sendCredentialsEmail) {
    tempPassword = generatePassword();
    body.password = tempPassword;
  }

  const employee = await createEmployee(body, req.user._id);

  let credentialsEmail = null;
  if (sendCredentialsEmail && tempPassword) {
    await User.updateOne({ _id: employee.id }, { $set: { mustChangePassword: true } });
    const emailResult = await sendWelcomeEmail({
      to: employee.email,
      name: employee.name,
      tempPassword,
    }).catch(() => ({ delivered: false }));
    credentialsEmail = { sent: Boolean(emailResult?.delivered) };
    // If delivery failed (e.g. SMTP unconfigured), hand the temp password to
    // the admin once so it can be shared manually — otherwise it is lost.
    if (!credentialsEmail.sent) {
      credentialsEmail.tempPassword = tempPassword;
    }
    tempPassword = null;
  }

  auditRequest(req, 'employee_registered', {
    adminId: req.user._id.toString(),
    employeeId: employee.id,
    email: employee.email,
    roleId: employee.roleId,
    departmentId: employee.departmentId,
    reportingManagerId: employee.reportingManagerId,
    mustChangePassword: sendCredentialsEmail,
    credentialsEmailSent: credentialsEmail?.sent ?? null,
  });
  res.status(201).json({
    employee: { ...employee, mustChangePassword: sendCredentialsEmail },
    ...(credentialsEmail ? { credentialsEmail } : {}),
  });
}

export async function listEmployees(req, res) {
  const { page, limit, search, isActive, departmentId, roleId, createdAfter } =
    employeeListQuerySchema.parse(req.query);
  const query = await applyTeamScopeToEmployeeQuery(
    await applyEmployeeListFilters(await buildEmployeeDirectoryQuery(), {
      search,
      isActive,
      departmentId,
      roleId,
      createdAfter,
    }),
    req,
  );

  const skip = (page - 1) * limit;
  const [employees, total] = await Promise.all([
    User.find(query)
      .populate(USER_POPULATE_FIELDS)
      // _id tiebreaker keeps offset pagination stable when names tie.
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  const canViewSalary = canViewSalaryFields(req.userPermissions);
  res.json({
    employees: employees.map((employee) => ({
      ...employee.toSafeJSON({ canViewSalary }),
      lastLoginAt: employee.lastLoginAt ?? null,
    })),
pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  }

const teamTodayQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
});

export async function getTeamTodayStatusAdmin(req, res) {
  const parsed = teamTodayQuerySchema.parse(req.query);
  const result = await getTeamTodayStatusService(req.user, req.userPermissions, {
    paginate: true,
    page: parsed.page,
    limit: parsed.limit,
    search: parsed.search ?? '',
  });
  res.json(result);
}

export async function getEmployeeStats(req, res) {
  const baseQuery = await applyTeamScopeToEmployeeQuery(await buildEmployeeDirectoryQuery(), req);
  const monthKey = getISTDateInputValue().slice(0, 7);
  const { start: monthStart } = parseMonthInputAsISTRange(monthKey);

  const [total, active, inactive, newThisMonth] = await Promise.all([
    User.countDocuments(baseQuery),
    User.countDocuments({ ...baseQuery, isActive: true }),
    User.countDocuments({ ...baseQuery, isActive: false }),
    User.countDocuments({ ...baseQuery, createdAt: { $gte: monthStart } }),
  ]);

  res.json({
    stats: {
      total,
      active,
      inactive,
      newThisMonth,
      monthKey,
    },
  });
}

export async function getEmployee(req, res) {
  const idResult = objectIdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ message: 'Invalid employee identifier.' });
  }

  const employee = await User.findById(idResult.data).populate(USER_POPULATE_FIELDS);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  if (adminRole && employee.roleId?.toString?.() === adminRole._id.toString()) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const inScope = await assertEmployeeInTeamScope(req, employee._id);
  if (!inScope) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  res.json({
    employee: {
      ...employee.toSafeJSON({ canViewSalary: canViewSalaryFields(req.userPermissions) }),
      lastLoginAt: employee.lastLoginAt ?? null,
    },
  });
}

export async function listManagers(req, res) {
  const { search } = employeeListQuerySchema.pick({ search: true }).parse(req.query);
  const limit = Math.min(
    Number(req.query.limit) || 100,
    500,
  );

  const managerRoles = await Role.find({
    slug: { $in: [SYSTEM_ROLE_SLUGS.ADMIN, SYSTEM_ROLE_SLUGS.HR, SYSTEM_ROLE_SLUGS.REPORTING_MANAGER] },
  }).select('_id');
  const roleIds = managerRoles.map((role) => role._id);

  const query = {
    isActive: true,
    roleId: { $in: roleIds },
  };

  // Hierarchy scope: Admin/HR see every manager; everyone else sees only
  // their own chain (self, direct reports, managers above, delegate-linked
  // users) so one RM can never enumerate other teams' managers.
  const callerSlug = req.user.roleId && typeof req.user.roleId === 'object'
    ? req.user.roleId.slug
    : null;
  if (callerSlug !== SYSTEM_ROLE_SLUGS.ADMIN && callerSlug !== SYSTEM_ROLE_SLUGS.HR) {
    const chainIds = new Set([req.user._id.toString()]);
    // Walk up the reporting chain (cycle-safe, bounded).
    let cursor = req.user.reportingManagerId?._id?.toString?.()
      ?? req.user.reportingManagerId?.toString?.()
      ?? null;
    for (let depth = 0; depth < 10 && cursor && !chainIds.has(cursor); depth += 1) {
      chainIds.add(cursor);
      const superior = await User.findById(cursor).select('reportingManagerId').lean();
      cursor = superior?.reportingManagerId?._id?.toString?.()
        ?? superior?.reportingManagerId?.toString?.()
        ?? null;
    }
    const [reports, delegated, delegating] = await Promise.all([
      User.find({ reportingManagerId: req.user._id, isActive: true }).select('_id').lean(),
      User.find({ delegateApproverId: req.user._id, isActive: true }).select('_id').lean(),
      User.find({ _id: { $in: [...chainIds] } }).select('delegateApproverId').lean(),
    ]);
    for (const doc of [...reports, ...delegated]) chainIds.add(doc._id.toString());
    for (const doc of delegating) {
      const delegateId = doc.delegateApproverId?._id?.toString?.() ?? doc.delegateApproverId?.toString?.();
      if (delegateId) chainIds.add(delegateId);
    }
    query._id = { $in: [...chainIds] };
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: regex }, { email: regex }, { employeeCode: regex }];
  }

  const managers = await User.find(query)
    .select('name email roleId employeeCode')
    .populate('roleId', 'name slug')
    .sort({ name: 1 })
    .limit(limit);

  res.json({
    managers: managers.map((manager) => ({
      id: manager._id.toString(),
      name: manager.name,
      email: manager.email,
      employeeCode: manager.employeeCode ?? null,
      roleName: manager.roleId?.name ?? null,
    })),
  });
}

export async function updateEmployee(req, res) {
  const parsed = updateEmployeeOrgSchema.parse(req.body);

  const employee = await User.findById(req.params.id).populate(USER_POPULATE_FIELDS);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  if (isProfileOrgUpdate(req.body)) {
    // Validate the merged profile (stored values + patch), not the raw patch:
    // PATCH may carry a subset (e.g. { departmentId, roleId }) while org rules
    // (reporting manager for employees, managed departments for leads) must be
    // evaluated against the effective record. Unknown/extra keys are stripped
    // by the schema; writes below still apply only the provided fields.
    const role = req.body.roleId
      ? await resolveRole(req.body.roleId)
      : await resolveRole(refId(employee.roleId));
    const hasDepartments = (await Department.countDocuments({ isActive: true })) > 0;
    const mergedProfile = {
      firstName: employee.firstName,
      lastName: employee.lastName ?? undefined,
      email: employee.email,
      mobile: employee.mobile,
      designation: employee.designation,
      joiningDate: employee.joiningDate
        ? toEmployeeDateInputValue(employee.joiningDate)
        : undefined,
      dateOfBirth: employee.dateOfBirth
        ? toEmployeeDateInputValue(employee.dateOfBirth)
        : undefined,
      endingDate: employee.endingDate
        ? toEmployeeDateInputValue(employee.endingDate)
        : undefined,
      roleId: refId(employee.roleId),
      departmentId: employee.departmentId ? refId(employee.departmentId) : undefined,
      reportingManagerId: employee.reportingManagerId
        ? refId(employee.reportingManagerId)
        : null,
      delegateApproverId: employee.delegateApproverId
        ? refId(employee.delegateApproverId)
        : null,
      managedDepartmentIds: (employee.managedDepartmentIds ?? []).map((id) => refId(id)),
      ...req.body,
    };
    buildEmployeeProfileUpdateSchema({ roleSlug: role.slug, hasDepartments }).parse(mergedProfile);
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN });
  if (adminRole && employee.roleId?.toString?.() === adminRole._id.toString()) {
    return res.status(400).json({ message: 'Cannot modify the system admin account here.' });
  }

  const inScope = await assertEmployeeInTeamScope(req, employee._id);
  if (!inScope) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  if (parsed.joiningDate !== undefined || parsed.endingDate !== undefined) {
    const joining = toEmployeeDateInputValue(
      parsed.joiningDate !== undefined ? parsed.joiningDate : employee.joiningDate,
    );
    const ending =
      parsed.endingDate !== undefined
        ? parsed.endingDate === null
          ? null
          : toEmployeeDateInputValue(parsed.endingDate)
        : toEmployeeDateInputValue(employee.endingDate);

    const dateRangeError = assertEmployeeDateRange(joining, ending);
    if (dateRangeError) {
      return res.status(400).json(dateRangeError);
    }
  }

  const previous = {
    roleId: refId(employee.roleId),
    departmentId: refId(employee.departmentId),
    reportingManagerId: refId(employee.reportingManagerId),
    delegateApproverId: refId(employee.delegateApproverId),
    managedDepartmentIds: (employee.managedDepartmentIds ?? []).map((id) => refId(id)),
    isActive: employee.isActive,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    mobile: employee.mobile,
    designation: employee.designation,
    joiningDate: employee.joiningDate,
    dateOfBirth: employee.dateOfBirth,
    endingDate: employee.endingDate,
  };

  if (parsed.roleId !== undefined) {
    const role = await resolveRole(parsed.roleId);
    employee.roleId = role._id;
    employee.role = legacyRoleFromSlug(role.slug);
  }

  if (parsed.departmentId !== undefined) {
    if (parsed.departmentId === null) {
      employee.departmentId = null;
      // Legacy text field is no longer written; the name resolves from the master.
      employee.department = undefined;
    } else {
      const department = await Department.findById(parsed.departmentId);
      if (!department || !department.isActive) {
        return res.status(400).json({ message: 'Department not found.' });
      }
      employee.departmentId = department._id;
      employee.department = undefined;
    }
  }

  if (parsed.reportingManagerId !== undefined) {
    if (parsed.reportingManagerId === null) {
      employee.reportingManagerId = null;
    } else {
      const manager = await resolveReportingManager(parsed.reportingManagerId, employee._id);
      employee.reportingManagerId = manager._id;
    }
  }

  if (parsed.delegateApproverId !== undefined) {
    if (parsed.delegateApproverId === null) {
      employee.delegateApproverId = null;
    } else {
      const delegate = await resolveDelegateApprover(parsed.delegateApproverId, employee._id);
      employee.delegateApproverId = delegate._id;
    }
  }

  if (parsed.isActive !== undefined) {
    employee.isActive = parsed.isActive;
  }

  if (parsed.firstName !== undefined) {
    employee.firstName = parsed.firstName;
  }
  if (parsed.lastName !== undefined) {
    employee.lastName = parsed.lastName;
  }
  if (parsed.email !== undefined) {
    employee.email = parsed.email.toLowerCase();
  }
  if (parsed.mobile !== undefined) {
    employee.mobile = parsed.mobile;
  }
  if (parsed.designation !== undefined) {
    employee.designation = parsed.designation;
  }
  if (parsed.joiningDate !== undefined) {
    employee.joiningDate = parsed.joiningDate;
  }
  if (parsed.dateOfBirth !== undefined) {
    employee.dateOfBirth =
      parsed.dateOfBirth === null ? null : parseDateInputAsISTDay(parsed.dateOfBirth);
  }
  if (parsed.endingDate !== undefined) {
    employee.endingDate = parsed.endingDate;
  }

  if (parsed.managedDepartmentIds !== undefined) {
    employee.managedDepartmentIds = await resolveManagedDepartments(parsed.managedDepartmentIds);
  }

  await employee.save();
  await employee.populate(USER_POPULATE_FIELDS);

  auditRequest(req, 'employee_org_updated', {
    adminId: req.user._id.toString(),
    employeeId: employee._id.toString(),
    previous,
    next: {
      roleId: refId(employee.roleId),
      departmentId: refId(employee.departmentId),
      reportingManagerId: refId(employee.reportingManagerId),
      delegateApproverId: refId(employee.delegateApproverId),
      managedDepartmentIds: (employee.managedDepartmentIds ?? []).map((id) => refId(id)),
      isActive: employee.isActive,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email,
      mobile: employee.mobile,
      designation: employee.designation,
      joiningDate: employee.joiningDate,
      dateOfBirth: employee.dateOfBirth,
      endingDate: employee.endingDate,
    },
    entityType: 'employee',
    entityId: employee._id.toString(),
    actionType: 'update',
  });

  res.json({
    employee: employee.toSafeJSON({ canViewSalary: canViewSalaryFields(req.userPermissions) }),
  });
}

export async function updateEmployeeStatus(req, res) {
  return updateEmployee(req, res);
}

export async function resetEmployeePassword(req, res) {
  const parsed = adminResetPasswordSchema.parse(req.body);
  const employee = await User.findById(req.params.id);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN });
  if (adminRole && employee.roleId?.toString?.() === adminRole._id.toString()) {
    return res.status(400).json({ message: 'Cannot reset password for the system admin here.' });
  }

  const sameAsCurrent = await bcrypt.compare(parsed.newPassword, employee.passwordHash);
  if (sameAsCurrent) {
    return res.status(400).json({
      message: 'New password must be different from the current password.',
    });
  }

  employee.passwordHash = await bcrypt.hash(parsed.newPassword, 12);
  // Resetting the password also revokes the employee's PIN credential.
  // NOTE: no forced-change flag — first-login gating applies to new accounts
  // only, never to existing ones (resets are already audit-logged per actor).
  employee.pin4Hash = null;
  employee.tokenVersion = (employee.tokenVersion ?? 0) + 1;
  await employee.save();

  auditRequest(req, 'password_reset_by_admin', {
    adminId: req.user._id.toString(),
    employeeId: employee._id.toString(),
    email: employee.email,
  });

  res.json({ message: 'Employee password reset successfully.' });
}

export async function resetEmployeePin(req, res) {
  const parsed = adminResetPinSchema.parse(req.body);
  const employee = await User.findById(req.params.id);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN });
  if (adminRole && employee.roleId?.toString?.() === adminRole._id.toString()) {
    return res.status(400).json({ message: 'Cannot reset PIN for the system admin here.' });
  }

  employee.pin4Hash = await bcrypt.hash(parsed.newPin, 12);
  employee.tokenVersion = (employee.tokenVersion ?? 0) + 1;
  await employee.save();

  auditRequest(req, 'pin_reset_by_admin', {
    adminId: req.user._id.toString(),
    employeeId: employee._id.toString(),
    email: employee.email,
  });

  res.json({ message: 'Employee PIN reset successfully.' });
}

export async function downloadEmployeeTemplate(req, res) {
  const buffer = await buildEmployeeDirectoryWorkbook();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="employee-directory-export.xlsx"',
  );
  res.setHeader('Content-Length', buffer.byteLength ?? buffer.length);
  res.end(buffer);
}

export async function bulkUploadEmployees(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: 'Excel file is required.' });
  }

  const rows = parseEmployeeWorkbook(req.file.buffer);
  if (rows.length === 0) {
    return res.status(400).json({ message: 'No employee rows found in file.' });
  }

  const fileWarnings = Array.isArray(rows.warnings) ? rows.warnings : [];
  const result = await importEmployeesFromRowsUpsert(rows, req.user._id);
  if (fileWarnings.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...fileWarnings];
  }

  const changes = result.results
    .filter((item) => item.status === 'updated' || item.status === 'created')
    .map((item) => ({
      rowNumber: item.rowNumber,
      id: item.id || null,
      email: item.email || null,
      status: item.status,
      emailSent: item.emailStatus === 'sent',
      emailError: item.emailStatus === 'failed',
      changedFields: item.changedFields ?? [],
      ignoredFields: item.ignoredFields ?? [],
    }));

  auditRequestSync(req, 'employee_bulk_upsert', {
    adminId: req.user._id.toString(),
    email: req.user.email,
    summary: result.summary,
    fileName: req.file.originalname,
    changes,
  });

  delete result.createdEmployees;
  res.status(201).json({ summary: result.summary, results: changes });
}

/**
 * Dry-run preview for bulk sync: parses the file and computes the exact
 * per-row diff/validation the sync would produce, without writing anything,
 * sending any email, or emitting audit logs.
 */
export async function previewBulkUploadEmployees(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: 'Excel file is required.' });
  }

  const rows = parseEmployeeWorkbook(req.file.buffer);
  if (rows.length === 0) {
    return res.status(400).json({ message: 'No employee rows found in file.' });
  }

  const fileWarnings = Array.isArray(rows.warnings) ? rows.warnings : [];
  const result = await importEmployeesFromRowsUpsert(rows, req.user._id, { dryRun: true });
  if (fileWarnings.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...fileWarnings];
  }

  res.json(result);
}

export async function getOfficeSettingsHandler(req, res) {
  const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 }).lean();
  res.set('Cache-Control', 'no-store');
  res.json({ settings });
}

export async function updateOfficeSettings(req, res) {
  const parsed = officeUpdateSchema.parse(req.body);
  let settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  const previous = settings ? settings.toObject() : null;
  // Merge nested autoCheckout so partial updates keep existing officeTime/wfhTime/enabled.
  if (parsed.autoCheckout) {
    const existing = (settings && settings.autoCheckout) || {};
    parsed.autoCheckout = {
      enabled: parsed.autoCheckout.enabled ?? existing.enabled ?? true,
      office: parsed.autoCheckout.office ?? existing.office ?? { day: 'same', time: '23:59' },
      wfh: parsed.autoCheckout.wfh ?? existing.wfh ?? { day: 'next', time: '06:00' },
    };
  }

  if (!settings) {
    settings = await OfficeSettings.create({
      ...parsed,
      updatedBy: req.user._id,
    });
  } else {
    await settings.updateOne(
      { $set: { ...parsed, updatedBy: req.user._id } },
      { runValidators: true },
    );
    settings = await OfficeSettings.findById(settings._id);
  }

  const nextSnapshot = settings.toObject();
  const diff = {};
  for (const key of Object.keys(parsed)) {
    const before = previous?.[key] ?? null;
    const after = nextSnapshot?.[key] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      diff[key] = { previous: before, next: after };
    }
  }
  auditRequest(req, 'office_settings_updated', {
    adminId: req.user._id.toString(),
    officeName: settings.name,
    previous,
    next: nextSnapshot,
    changes: diff,
  });

  res.set('Cache-Control', 'no-store');
  res.json({ settings: settings.toObject() });
}

export async function listAttendance(req, res) {
  const parsed = attendanceQuerySchema.parse(req.query);
  const result = await getAdminAttendance({
    ...parsed,
    actor: req.user,
    permissions: req.userPermissions,
  });
  res.json(result);
}

export async function editAttendanceRecord(req, res) {
  const recordId = objectIdSchema.parse(req.params.id);
  const payload = adminAttendanceEditSchema.parse(req.body);
  const auditContext = {
    ...getRequestAuditContext(req),
    email: req.user?.email,
  };
  const result = await adminEditAttendanceRecord({
    recordId,
    payload,
    actor: req.user,
    permissions: req.userPermissions,
    auditContext,
  });

  res.json({
    record: {
      id: result.checkIn._id.toString(),
      userId: result.checkIn.userId.toString(),
      type: result.checkIn.type,
      timestamp: result.checkIn.timestamp,
      attendanceMode: result.checkIn.attendanceMode,
      attendanceTag: result.checkIn.attendanceTag,
      warningIssued: result.checkIn.warningIssued,
      quarterWarningIndex: result.checkIn.quarterWarningIndex,
      lateNote: result.checkIn.lateNote,
      status: result.checkIn.status,
      dayKey: result.dayKey,
      checkInTime: result.checkInTime,
      checkOutTime: result.checkOutTime,
      checkOutRecordId: result.checkOut?._id?.toString() ?? null,
      lastEditedAt: result.checkIn.lastEditedAt ?? null,
      lastEditedBy: result.checkIn.lastEditedBy ?? null,
      editHistory: result.checkIn.editHistory ?? [],
    },
  });
}

export async function upsertAttendanceRecord(req, res) {
  const parsed = adminAttendanceUpsertSchema.parse(req.body);
  const { userId, dayKey, ...payload } = parsed;
  const auditContext = {
    ...getRequestAuditContext(req),
    email: req.user?.email,
  };
  const result = await adminUpsertAttendanceForDay({
    userId,
    dayKey,
    payload,
    actor: req.user,
    permissions: req.userPermissions,
    auditContext,
  });

  if (result.leaveOnly) {
    res.status(result.created ? 201 : 200).json({
      record: null,
      leaveOnly: true,
      dayKey: result.dayKey,
      leaveRequest: result.leaveRequest
        ? {
            id: result.leaveRequest._id.toString(),
            userId: result.leaveRequest.userId?.toString?.() ?? String(result.leaveRequest.userId),
            leaveTypeId:
              result.leaveRequest.leaveTypeId?._id?.toString?.()
              ?? result.leaveRequest.leaveTypeId?.toString?.(),
            startDate: result.leaveRequest.startDate,
            endDate: result.leaveRequest.endDate,
            status: result.leaveRequest.status,
            days: result.leaveRequest.days,
          }
        : null,
      created: Boolean(result.created),
    });
    return;
  }

  res.status(result.created ? 201 : 200).json({
    record: {
      id: result.checkIn._id.toString(),
      userId: result.checkIn.userId.toString(),
      type: result.checkIn.type,
      timestamp: result.checkIn.timestamp,
      attendanceMode: result.checkIn.attendanceMode,
      attendanceTag: result.checkIn.attendanceTag,
      warningIssued: result.checkIn.warningIssued,
      quarterWarningIndex: result.checkIn.quarterWarningIndex,
      lateNote: result.checkIn.lateNote,
      status: result.checkIn.status,
      dayKey: result.dayKey,
      checkInTime: result.checkInTime,
      checkOutTime: result.checkOutTime,
      checkOutRecordId: result.checkOut?._id?.toString() ?? null,
      lastEditedAt: result.checkIn.lastEditedAt ?? null,
      lastEditedBy: result.checkIn.lastEditedBy ?? null,
      editHistory: result.checkIn.editHistory ?? [],
      created: Boolean(result.created),
    },
  });
}

export async function getQuarterWarningSummary(req, res) {
  res.set('Cache-Control', 'no-store');
  const canReadAll = hasPermission(req.userPermissions, PERMISSIONS.ATTENDANCE_READ_ALL);
  const canReadTeam = hasPermission(req.userPermissions, PERMISSIONS.ATTENDANCE_READ_TEAM);

  let userIds = [];
  if (canReadAll) {
    const employees = await User.find(await buildEmployeeDirectoryQuery())
      .select('_id')
      .lean();
    userIds = employees.map((item) => item._id);
  } else if (canReadTeam && req.user?._id) {
    const scopedIds = await resolveTeamScopedUserIds(
      req.user,
      req.userPermissions,
      PERMISSIONS.ATTENDANCE_READ_ALL,
      PERMISSIONS.ATTENDANCE_READ_TEAM,
    );
    userIds = scopedIds ?? [];
  }

  const summary = await getQuarterWarningSummaryForUsers(userIds);
  res.json(summary);
}

export async function resetQuarterWarnings(req, res) {
  const { userIds } = resetQuarterWarningsSchema.parse(req.body);

  const scopedIds = await resolveTeamScopedUserIds(
    req.user,
    req.userPermissions,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );

  if (scopedIds !== null) {
    const scopedSet = new Set(scopedIds.map((id) => id.toString()));
    const unauthorized = userIds.filter((id) => !scopedSet.has(id));
    if (unauthorized.length) {
      return res.status(403).json({
        message: 'You do not have permission to reset warnings for one or more selected employees.',
      });
    }
  }

  const result = await resetQuarterWarningsForUsers(userIds);

  auditRequest(req, 'quarter_warnings_reset', {
    adminId: req.user._id.toString(),
    userIds: result.userIds,
    quarter: result.quarter?.label ?? null,
    clearedWarnings: result.clearedWarnings,
    reclassifiedLv: result.reclassifiedLv,
  });

  res.json(result);
}

const weekConfirmationSchema = z.object({
  userId: objectIdSchema,
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD.'),
  notes: z.string().trim().max(500).optional(),
});

export async function listWeekConfirmations(req, res) {
  const weekStart = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .parse(req.query.weekStart);

  const scopedIds = await resolveTeamScopedUserIds(
    req.user,
    req.userPermissions,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );

  const query = { weekStart };
  if (scopedIds !== null) {
    query.userId = { $in: scopedIds };
  }

  const rows = await WeekAttendanceConfirmation.find(query)
    .populate('confirmedBy', 'name email')
    .sort({ userId: 1 });

  res.json({
    weekStart,
    confirmations: rows.map((row) => row.toSafeJSON()),
  });
}

export async function confirmWeekAttendance(req, res) {
  const parsed = weekConfirmationSchema.parse(req.body);

  const allowed = await resolveTeamScopedUserIds(
    req.user,
    req.userPermissions,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  if (
    allowed !== null &&
    !allowed.some((id) => id.toString() === parsed.userId)
  ) {
    return res.status(403).json({ message: 'You do not have permission to confirm this employee.' });
  }

  const employee = await User.findById(parsed.userId).select('_id isActive');
  if (!employee?.isActive) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const confirmation = await WeekAttendanceConfirmation.findOneAndUpdate(
    { userId: parsed.userId, weekStart: parsed.weekStart },
    {
      userId: parsed.userId,
      weekStart: parsed.weekStart,
      confirmedBy: req.user._id,
      confirmedAt: new Date(),
      notes: parsed.notes ?? null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).populate('confirmedBy', 'name email');

  auditRequest(req, 'week_attendance_confirmed', {
    adminId: req.user._id.toString(),
    userId: parsed.userId,
    weekStart: parsed.weekStart,
  });

  res.json({ confirmation: confirmation.toSafeJSON() });
}

const weekConfirmationQuerySchema = z.object({
  userId: objectIdSchema,
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD.'),
});

export async function unconfirmWeekAttendance(req, res) {
  const parsed = weekConfirmationQuerySchema.parse(req.query);

  const allowed = await resolveTeamScopedUserIds(
    req.user,
    req.userPermissions,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  if (
    allowed !== null &&
    !allowed.some((id) => id.toString() === parsed.userId)
  ) {
    return res.status(403).json({ message: 'You do not have permission to unconfirm this employee.' });
  }

  const deleted = await WeekAttendanceConfirmation.findOneAndDelete({
    userId: parsed.userId,
    weekStart: parsed.weekStart,
  });

  if (!deleted) {
    return res.status(404).json({ message: 'Week confirmation not found.' });
  }

  auditRequest(req, 'week_attendance_unconfirmed', {
    adminId: req.user._id.toString(),
    userId: parsed.userId,
    weekStart: parsed.weekStart,
  });

  res.json({ success: true, userId: parsed.userId, weekStart: parsed.weekStart });
}

const LOGIN_AUDIT_ACTIONS = ['login_success', 'login_failed'];
const BULK_UPLOAD_AUDIT_ACTIONS = ['employee_bulk_upsert', 'employee_bulk_upload'];
const ALL_AUDIT_ACTIONS = [...LOGIN_AUDIT_ACTIONS, ...BULK_UPLOAD_AUDIT_ACTIONS];
const CONFLICT_FILTER_SCAN_LIMIT = 500;

const AUDIT_RECORD_ID_KEYS = [
  'entityId',
  'employeeId',
  'requestId',
  'ticketId',
  'commentId',
  'policyId',
  'leaveTypeId',
  'departmentId',
  'transferId',
  'holidayId',
  'roleId',
  'userId',
];

export function resolveAuditRecordId(log) {
  // entityId persists TOP-LEVEL (AuditLog schema), not in metadata — check it
  // first, then the legacy metadata id family.
  const top = log?.entityId;
  if (top !== undefined && top !== null && String(top).trim() !== '') {
    return String(top);
  }
  const metadata = log?.metadata;
  if (metadata == null || typeof metadata !== 'object') return null;
  for (const key of AUDIT_RECORD_ID_KEYS) {
    const value = metadata[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  }
  return null;
}

function mapAuditLogResponse(log, conflict) {
  const metadata = log.metadata ?? null;
  return {
    id: log._id.toString(),
    action: log.action,
    userId: log.userId?.toString() ?? null,
    email: log.email ?? null,
    role: log.role ?? null,
    ip: log.ip ?? null,
    deviceId: log.deviceId ?? null,
    userAgent: log.userAgent ?? null,
    metadata,
    module: metadata?.module ?? resolveAuditModule(log.action),
    recordId: resolveAuditRecordId(log),
    status: log.status ?? null,
    reason: log.reason ?? null,
    timestamp: log.timestamp,
    entityType: log.entityType ?? null,
    entityId: log.entityId?.toString() ?? null,
    fieldChanged: log.fieldChanged ?? null,
    oldValue: log.oldValue ?? null,
    newValue: log.newValue ?? null,
    actionType: log.actionType ?? null,
    ipConflict: conflict.ipConflict,
    conflictWithUsers: conflict.conflictWithUsers,
  };
}

function buildAuditLogQuery({ action, search, date, entityType, actionType, userId, fieldChanged, dateFrom, dateTo, module, employee, entityId, q } = {}) {
  const query = {};
  if (action) {
    query.action = action;
  }
  if (entityType) {
    query.entityType = entityType;
  }
  if (actionType) {
    query.actionType = actionType;
  }
  if (userId) {
    query.userId = userId;
  }
  if (fieldChanged) {
    query.fieldChanged = fieldChanged;
  }

  if (module) {
    // The untaxonomied `other` bucket is never stored — match actions that
    // carry none of the taxonomy prefixes (mirrors resolveAuditModule).
    if (module === 'other') {
      const all = auditAllActionMatchers();
      query.$and = query.$and ?? [];
      query.$and.push({
        action: { $not: new RegExp(`^(${all.map((prefix) => escapeRegex(prefix)).join('|')})`) },
      });
    } else {
      const matchers = auditActionMatchers(module);
      if (matchers.length > 0) {
        query.$and = query.$and ?? [];
        query.$and.push({
          $or: [
            { 'metadata.module': module },
            ...matchers.map((prefix) => ({ action: new RegExp(`^${escapeRegex(prefix)}`) })),
          ],
        });
      } else {
        query['metadata.module'] = module;
      }
    }
  }

  if (search) {
    query.email = { $regex: escapeRegex(search), $options: 'i' };
  }

  if (employee) {
    const trimmed = employee.trim();
    const clauses = [{ email: { $regex: escapeRegex(trimmed), $options: 'i' } }];
    if (/^[a-f\d]{24}$/i.test(trimmed)) {
      clauses.push({ userId: trimmed });
    }
    query.$and = query.$and ?? [];
    query.$and.push({ $or: clauses });
  }

  if (entityId) {
    const trimmed = entityId.trim();
    const clauses = AUDIT_RECORD_ID_KEYS.map((key) => ({ [`metadata.${key}`]: trimmed }));
    // Top-level entityId is an ObjectId path — only match it for valid ids
    // (anything else would throw a CastError out of the query).
    if (/^[a-f\d]{24}$/i.test(trimmed)) {
      clauses.unshift({ entityId: trimmed });
    }
    query.$and = query.$and ?? [];
    query.$and.push({ $or: clauses });
  }

  if (q) {
    // Unified search box: one input matched with OR semantics across actor
    // email (partial, case-insensitive), user ObjectId, record ids
    // (top-level entityId + metadata id family, exact), action text and
    // stored module text (partial, case-insensitive), and IST date fragments
    // (YYYY-MM-DD for a day, YYYY-MM for a month). ObjectId-typed paths
    // are only queried for 24-hex input so other strings can never throw a
    // CastError out of the query.
    const trimmed = q.trim();
    const clauses = [
      { email: { $regex: escapeRegex(trimmed), $options: 'i' } },
      { action: { $regex: escapeRegex(trimmed), $options: 'i' } },
      { 'metadata.module': { $regex: escapeRegex(trimmed), $options: 'i' } },
    ];
    if (/^[a-f\d]{24}$/i.test(trimmed)) {
      clauses.push({ userId: trimmed });
      clauses.push({ entityId: trimmed });
    }
    for (const key of AUDIT_RECORD_ID_KEYS) {
      clauses.push({ [`metadata.${key}`]: trimmed });
    }
    const dateRange = auditSearchDateRange(trimmed);
    if (dateRange) {
      clauses.push({ timestamp: dateRange });
    }
    query.$and = query.$and ?? [];
    query.$and.push({ $or: clauses });
  }

  const fromDay = dateFrom ? parseDateInputAsISTDay(dateFrom) : null;
  const toDay = dateTo ? parseDateInputAsISTDay(dateTo) : null;
  if (fromDay || toDay) {
    query.timestamp = {};
    if (fromDay) query.timestamp.$gte = startOfDayIST(fromDay);
    if (toDay) query.timestamp.$lte = endOfDayIST(toDay);
  } else if (date) {
    const istDay = parseDateInputAsISTDay(date);
    if (istDay) {
      query.timestamp = {
        $gte: startOfDayIST(istDay),
        $lte: endOfDayIST(istDay),
      };
    }
  }

  return query;
}

/**
 * IST date fragments typed into the unified search box: `YYYY-MM-DD` matches
 * that calendar day, `YYYY-MM` matches the whole month. Returns null for
 * anything else (including impossible dates like month 13) so the fragment
 * falls through to plain text matching.
 */
function auditSearchDateRange(trimmed) {
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dayMatch) {
    const year = Number(dayMatch[1]);
    const month = Number(dayMatch[2]);
    const day = Number(dayMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
      return null;
    }
    const istDay = parseDateInputAsISTDay(trimmed);
    if (!istDay) return null;
    return { $gte: startOfDayIST(istDay), $lte: endOfDayIST(istDay) };
  }
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return null;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const start = parseDateInputAsISTDay(`${monthMatch[1]}-${monthMatch[2]}-01`);
    const end = parseDateInputAsISTDay(`${monthMatch[1]}-${monthMatch[2]}-${String(lastDay).padStart(2, '0')}`);
    if (!start || !end) return null;
    return { $gte: startOfDayIST(start), $lte: endOfDayIST(end) };
  }
  return null;
}

function flattenAuditMetadata(metadata) {
  if (metadata == null) return '';
  if (typeof metadata !== 'object') return String(metadata);
  try {
    return JSON.stringify(metadata);
  } catch {
    return '';
  }
}

export function auditLogExportRows(logs) {
  return logs.map((log) => ({
    Timestamp: log.timestamp ? new Date(log.timestamp).toISOString() : '',
    Action: log.action ?? '',
    Email: resolveAuditDisplayEmail(log),
    Role: resolveAuditDisplayRole(log),
    Status: log.status ?? log.metadata?.status ?? 'UNKNOWN',
    Reason: log.reason ?? 'Not recorded',
    Module: log.metadata?.module ?? resolveAuditModule(log.action),
    Entity: log.metadata?.entity ?? '',
    EntityId: resolveAuditRecordId(log) ?? 'n/a',
    EntityAction: log.metadata?.entityAction ?? '',
    Previous: flattenAuditMetadata(log.metadata?.previous),
    Next: flattenAuditMetadata(
      log.metadata?.next ?? log.metadata?.changes ?? log.metadata?.after,
    ),
    IP: log.ip ?? 'Not recorded',
    DeviceId: log.deviceId ?? 'Not recorded',
  }));
}

export async function exportAuditLogs(req, res) {
  const parsed = auditLogExportSchema.parse(req.query);
  const query = buildAuditLogQuery(parsed);
  let logs = await AuditLog.find(query)
    .sort({ timestamp: -1, _id: -1 })
    .limit(AUDIT_LOG_EXPORT_MAX_ROWS)
    .lean();
  if (parsed.conflictsOnly) {
    const conflictMap = await enrichAuditLogsWithConflicts(logs);
    logs = logs.filter((log) => conflictMap.get(log._id.toString())?.ipConflict);
  }
  const rows = auditLogExportRows(logs);
  const stamp = getISTDateInputValue().slice(0, 10);

  auditRequest(req, 'audit_logs_exported', {
    adminId: req.user._id.toString(),
    format: parsed.format,
    rows: rows.length,
    filters: {
      action: parsed.action ?? null,
      search: parsed.search ?? null,
      q: parsed.q ?? null,
      date: parsed.date ?? null,
      dateFrom: parsed.dateFrom ?? null,
      dateTo: parsed.dateTo ?? null,
      module: parsed.module ?? null,
      employee: parsed.employee ?? null,
      entityId: parsed.entityId ?? null,
      conflictsOnly: parsed.conflictsOnly ?? false,
    },
  });

  if (parsed.format === 'csv') {
    const headers = Object.keys(rows[0] ?? { Timestamp: '' });
    const escapeCell = (value) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
      headers.map(escapeCell).join(','),
      ...rows.map((row) => headers.map((key) => escapeCell(row[key])).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-logs-${stamp}.csv"`,
    );
    return res.end(`\uFEFF${csv}`);
  }

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Audit logs');
  const headers = Object.keys(rows[0] ?? { Timestamp: '' });
  sheet.columns = headers.map((header) => ({ header, key: header, width: 24 }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    sheet.addRow(row);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="audit-logs-${stamp}.xlsx"`,
  );
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

export async function runAuditArchiveHandler(req, res) {
  const dryRun = req.body?.dryRun === true;
  const { runAuditArchiveJob } = await import('../services/auditArchiveService.js');
  const result = await runAuditArchiveJob({ dryRun, actorId: req.user._id });
  res.json(result);
}

export async function getAuditArchiveStatusHandler(req, res) {
  const { getAuditArchiveStatus } = await import('../services/auditArchiveService.js');
  res.json(await getAuditArchiveStatus());
}

export async function listAuditLogs(req, res) {
  const { page, limit, action, search, date, dateFrom, dateTo, module, employee, entityId, q, conflictsOnly } =
    auditLogQuerySchema.parse(req.query);
  const query = buildAuditLogQuery({ action, search, date, dateFrom, dateTo, module, employee, entityId, q });

  const skip = (page - 1) * limit;
  let logs;
  let total;

  if (conflictsOnly) {
    const candidates = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(CONFLICT_FILTER_SCAN_LIMIT);
    const conflictMap = await enrichAuditLogsWithConflicts(candidates);
    const conflictLogs = candidates.filter(
      (log) => conflictMap.get(log._id.toString())?.ipConflict,
    );
    total = conflictLogs.length;
    logs = conflictLogs.slice(skip, skip + limit);
    const conflictMapForPage = await enrichAuditLogsWithConflicts(logs);

    res.json({
      logs: logs.map((log) => {
        const conflict = conflictMapForPage.get(log._id.toString()) ?? {
          ipConflict: false,
          conflictWithUsers: [],
        };
        return mapAuditLogResponse(log, conflict);
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
    return;
  }

  [logs, total] = await Promise.all([
      // _id tiebreaker keeps offset pagination stable when timestamps tie.
      AuditLog.find(query).sort({ timestamp: -1, _id: -1 }).skip(skip).limit(limit),
    AuditLog.countDocuments(query),
  ]);

  const conflictMap = await enrichAuditLogsWithConflicts(logs);

  res.json({
    logs: logs.map((log) => {
      const conflict = conflictMap.get(log._id.toString()) ?? {
        ipConflict: false,
        conflictWithUsers: [],
      };
      return mapAuditLogResponse(log, conflict);
    }),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
}