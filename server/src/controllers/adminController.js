import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { SYSTEM_ROLE_SLUGS, PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Department } from '../models/Department.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import {
  buildEmployeeTemplateWorkbook,
  createEmployee,
  importEmployeesFromRows,
  parseEmployeeWorkbook,
} from '../services/excelImportService.js';
import { getAdminAttendance } from '../services/attendanceService.js';
import { getQuarterWarningSummaryForUsers } from '../services/attendancePolicyService.js';
import { officeSchema } from '../../../shared/validation/office.js';
import { paginationSchema, objectIdSchema } from '../../../shared/validation/common.js';
import { adminResetPasswordSchema } from '../../../shared/validation/auth.js';
import { auditLogQuerySchema } from '../../../shared/validation/audit.js';
import { updateEmployeeOrgSchema } from '../../../shared/validation/employee.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
import { getISTDateInputValue, parseMonthInputAsISTRange } from '../utils/istDate.js';
import {
  legacyRoleFromSlug,
  resolveDepartment,
  resolveDelegateApprover,
  resolveReportingManager,
  resolveRole,
} from '../services/userOrgService.js';

function refId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString();
  return value.toString();
}
import { auditLog } from '../utils/auditLog.js';
import { AuditLog } from '../models/AuditLog.js';

const attendanceQuerySchema = paginationSchema.extend({
  userId: objectIdSchema.optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
    .optional(),
});

const employeeListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === 'true' ? true : value === 'false' ? false : undefined)),
  departmentId: objectIdSchema.optional(),
});

async function buildEmployeeDirectoryQuery() {
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  return adminRole ? { roleId: { $ne: adminRole._id } } : { role: { $ne: 'admin' } };
}

function applyEmployeeListFilters(query, { search, isActive, departmentId }) {
  if (typeof isActive === 'boolean') {
    query.isActive = isActive;
  }

  if (departmentId) {
    query.departmentId = departmentId;
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
  const { page, limit, search, isActive, departmentId } = employeeListQuerySchema.parse(req.query);
  const query = applyEmployeeListFilters(await buildEmployeeDirectoryQuery(), {
    search,
    isActive,
    departmentId,
  });

  const canReadAll = hasPermission(req.userPermissions, PERMISSIONS.ATTENDANCE_READ_ALL);
  const canReadTeam = hasPermission(req.userPermissions, PERMISSIONS.ATTENDANCE_READ_TEAM);

  if (!canReadAll && canReadTeam && req.user?._id) {
    query.reportingManagerId = req.user._id;
  }

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
  const baseQuery = await buildEmployeeDirectoryQuery();
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
  const employee = await User.findById(req.params.id).populate(USER_POPULATE_FIELDS);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  if (adminRole && employee.roleId?.toString?.() === adminRole._id.toString()) {
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
    100,
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
  const employee = await User.findById(req.params.id).populate(USER_POPULATE_FIELDS);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN });
  if (adminRole && employee.roleId?.toString?.() === adminRole._id.toString()) {
    return res.status(400).json({ message: 'Cannot modify the system admin account here.' });
  }

  const previous = {
    roleId: refId(employee.roleId),
    departmentId: refId(employee.departmentId),
    reportingManagerId: refId(employee.reportingManagerId),
    delegateApproverId: refId(employee.delegateApproverId),
    isActive: employee.isActive,
    firstName: employee.firstName,
    lastName: employee.lastName,
    designation: employee.designation,
    joiningDate: employee.joiningDate,
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
  if (parsed.designation !== undefined) {
    employee.designation = parsed.designation || null;
  }
  if (parsed.joiningDate !== undefined) {
    employee.joiningDate = parsed.joiningDate;
  }
  if (parsed.endingDate !== undefined) {
    employee.endingDate = parsed.endingDate;
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
      isActive: employee.isActive,
      firstName: employee.firstName,
      lastName: employee.lastName,
      designation: employee.designation,
      joiningDate: employee.joiningDate,
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
  employee.tokenVersion = (employee.tokenVersion ?? 0) + 1;
  await employee.save();

  auditLog('password_reset_by_admin', {
    adminId: req.user._id.toString(),
    employeeId: employee._id.toString(),
    email: employee.email,
  });

  res.json({ message: 'Employee password reset successfully.' });
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
  res.send(buffer);
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
  const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  res.json({ settings });
}

export async function updateOfficeSettings(req, res) {
  const parsed = officeSchema.parse(req.body);
  let settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });

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

  res.json({ settings });
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

export async function getQuarterWarningSummary(req, res) {
  const canReadAll = hasPermission(req.userPermissions, PERMISSIONS.ATTENDANCE_READ_ALL);
  const canReadTeam = hasPermission(req.userPermissions, PERMISSIONS.ATTENDANCE_READ_TEAM);

  let userIds = [];
  if (canReadAll) {
    const employees = await User.find(await buildEmployeeDirectoryQuery())
      .select('_id')
      .lean();
    userIds = employees.map((item) => item._id);
  } else if (canReadTeam && req.user?._id) {
    const reports = await User.find({
      reportingManagerId: req.user._id,
      isActive: true,
    })
      .select('_id')
      .lean();
    userIds = reports.map((item) => item._id);
  }

  const summary = await getQuarterWarningSummaryForUsers(userIds);
  res.json(summary);
}

export async function listAuditLogs(req, res) {
  const { page, limit, action } = auditLogQuerySchema.parse(req.query);
  const query = {};

  if (action) {
    query.action = action;
  }

  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    AuditLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit),
    AuditLog.countDocuments(query),
  ]);

  res.json({
    logs: logs.map((log) => ({
      id: log._id.toString(),
      action: log.action,
      userId: log.userId?.toString() ?? null,
      email: log.email ?? null,
      role: log.role ?? null,
      ip: log.ip ?? null,
      userAgent: log.userAgent ?? null,
      metadata: log.metadata ?? null,
      status: log.status ?? null,
      reason: log.reason ?? null,
      timestamp: log.timestamp,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
}
