import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { SYSTEM_ROLE_SLUGS, PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Department } from '../models/Department.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { WeekAttendanceConfirmation } from '../models/WeekAttendanceConfirmation.js';
import {
  buildEmployeeTemplateWorkbook,
  createEmployee,
  importEmployeesFromRows,
  parseEmployeeWorkbook,
} from '../services/excelImportService.js';
import { getAdminAttendance, adminEditAttendanceRecord, adminUpsertAttendanceForDay } from '../services/attendanceService.js';
import {
  getQuarterWarningSummaryForUsers,
  resetQuarterWarningsForUsers,
} from '../services/attendancePolicyService.js';
import { officeSchema, officeUpdateSchema } from '../../../shared/validation/office.js';
import { paginationSchema, objectIdSchema } from '../../../shared/validation/common.js';
import { adminResetPasswordSchema, adminResetPinSchema } from '../../../shared/validation/auth.js';
import {
  adminAttendanceEditSchema,
  adminAttendanceUpsertSchema,
  resetQuarterWarningsSchema,
} from '../../../shared/validation/attendance.js';
import { auditLogQuerySchema } from '../../../shared/validation/audit.js';
import {
  buildEmployeeProfileUpdateSchema,
  isProfileOrgUpdate,
  updateEmployeeOrgSchema,
} from '../../../shared/validation/employee.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
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
import { auditLog, getRequestAuditContext } from '../utils/auditLog.js';
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

function applyEmployeeListFilters(query, { search, isActive, departmentId, roleId, createdAfter }) {
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
    query.$or = [
      { name: regex },
      { email: regex },
      { mobile: regex },
      { employeeCode: regex },
      { department: regex },
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
  const employee = await createEmployee(req.body, req.user._id);
  auditLog('employee_registered', {
    adminId: req.user._id.toString(),
    employeeId: employee.id,
    email: employee.email,
    roleId: employee.roleId,
    departmentId: employee.departmentId,
    reportingManagerId: employee.reportingManagerId,
  });
  res.status(201).json({ employee });
}

export async function listEmployees(req, res) {
  const { page, limit, search, isActive, departmentId, roleId, createdAfter } =
    employeeListQuerySchema.parse(req.query);
  const query = await applyTeamScopeToEmployeeQuery(
    applyEmployeeListFilters(await buildEmployeeDirectoryQuery(), {
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
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  res.json({
    employees: employees.map((employee) => ({
      ...employee.toSafeJSON(),
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
      ...employee.toSafeJSON(),
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

  if (isProfileOrgUpdate(req.body)) {
    const role = await resolveRole(req.body.roleId);
    const hasDepartments = (await Department.countDocuments({ isActive: true })) > 0;
    buildEmployeeProfileUpdateSchema({ roleSlug: role.slug, hasDepartments }).parse(req.body);
  }

  const employee = await User.findById(req.params.id).populate(USER_POPULATE_FIELDS);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
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
      employee.department = undefined;
    } else {
      const department = await Department.findById(parsed.departmentId);
      if (!department || !department.isActive) {
        return res.status(400).json({ message: 'Department not found.' });
      }
      employee.departmentId = department._id;
      employee.department = department.name;
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

  auditLog('employee_org_updated', {
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
  });

  res.json({ employee: employee.toSafeJSON() });
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
  employee.pin4Hash = null;
  employee.pin6Hash = null;
  employee.tokenVersion = (employee.tokenVersion ?? 0) + 1;
  await employee.save();

  auditLog('password_reset_by_admin', {
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
  employee.pin6Hash = await bcrypt.hash(parsed.newPin, 12);
  employee.tokenVersion = (employee.tokenVersion ?? 0) + 1;
  await employee.save();

  auditLog('pin_reset_by_admin', {
    adminId: req.user._id.toString(),
    employeeId: employee._id.toString(),
    email: employee.email,
  });

  res.json({ message: 'Employee PIN reset successfully.' });
}

export async function downloadEmployeeTemplate(req, res) {
  const buffer = buildEmployeeTemplateWorkbook();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="employee-registration-template.xlsx"',
  );
  res.setHeader('Content-Length', buffer.length);
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

  const result = await importEmployeesFromRows(rows, req.user._id);
  auditLog('employee_bulk_upload', {
    adminId: req.user._id.toString(),
    summary: result.summary,
  });
  res.status(201).json(result);
}

export async function getOfficeSettingsHandler(req, res) {
  const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 }).lean();
  res.set('Cache-Control', 'no-store');
  res.json({ settings });
}

export async function updateOfficeSettings(req, res) {
  const parsed = officeUpdateSchema.parse(req.body);
  let settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  // Merge nested autoCheckout so partial updates keep existing officeTime/wfhTime/enabled.
  if (parsed.autoCheckout) {
    const existing = (settings && settings.autoCheckout) || {
      enabled: true,
      officeTime: '23:59',
      wfhTime: '06:00',
    };
    parsed.autoCheckout = {
      enabled: parsed.autoCheckout.enabled ?? existing.enabled ?? true,
      officeTime: parsed.autoCheckout.officeTime ?? existing.officeTime ?? '23:59',
      wfhTime: parsed.autoCheckout.wfhTime ?? existing.wfhTime ?? '06:00',
    };
  }

  if (!settings) {
    settings = await OfficeSettings.create({
      ...parsed,
      updatedBy: req.user._id,
    });
  } else {
    Object.assign(settings, parsed, { updatedBy: req.user._id });
    await settings.save();
  }

  auditLog('office_settings_updated', {
    adminId: req.user._id.toString(),
    officeName: settings.name,
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
  const summary = await getQuarterWarningSummaryForUsers(result.userIds);

  auditLog('quarter_warnings_reset', {
    adminId: req.user._id.toString(),
    userIds: result.userIds,
    quarter: result.quarter?.label ?? null,
    clearedWarnings: result.clearedWarnings,
    reclassifiedLv: result.reclassifiedLv,
    ...getRequestAuditContext(req),
  });

  res.json({
    success: true,
    quarter: {
      year: result.quarter.year,
      quarter: result.quarter.quarter,
      label: result.quarter.label,
    },
    userIds: result.userIds,
    clearedWarnings: result.clearedWarnings,
    reclassifiedLv: result.reclassifiedLv,
    summary,
  });
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

  auditLog('week_attendance_confirmed', {
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

  auditLog('week_attendance_unconfirmed', {
    adminId: req.user._id.toString(),
    userId: parsed.userId,
    weekStart: parsed.weekStart,
  });

  res.json({ success: true, userId: parsed.userId, weekStart: parsed.weekStart });
}

const LOGIN_AUDIT_ACTIONS = ['login_success', 'login_failed'];
const CONFLICT_FILTER_SCAN_LIMIT = 500;

function mapAuditLogResponse(log, conflict) {
  return {
    id: log._id.toString(),
    action: log.action,
    userId: log.userId?.toString() ?? null,
    email: log.email ?? null,
    role: log.role ?? null,
    ip: log.ip ?? null,
    deviceId: log.deviceId ?? null,
    userAgent: log.userAgent ?? null,
    metadata: log.metadata ?? null,
    status: log.status ?? null,
    reason: log.reason ?? null,
    timestamp: log.timestamp,
    ipConflict: conflict.ipConflict,
    conflictWithUsers: conflict.conflictWithUsers,
  };
}

export async function listAuditLogs(req, res) {
  const { page, limit, action, search, date, conflictsOnly } = auditLogQuerySchema.parse(req.query);
  const query = {
    action: action ?? { $in: LOGIN_AUDIT_ACTIONS },
  };

  if (search) {
    query.email = { $regex: escapeRegex(search), $options: 'i' };
  }

  if (date) {
    const istDay = parseDateInputAsISTDay(date);
    if (istDay) {
      query.timestamp = {
        $gte: startOfDayIST(istDay),
        $lte: endOfDayIST(istDay),
      };
    }
  }

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
    AuditLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit),
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