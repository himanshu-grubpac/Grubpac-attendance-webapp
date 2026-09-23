import bcrypt from 'bcryptjs';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import {
  SYSTEM_ROLE_SLUGS,
  PERMISSIONS,
  canViewSalaryFields,
  hasCompanyWideScope,
  hasPermission,
} from '../../../shared/permissions.js';
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
  assertDepartmentInAccessibleSet,
  assertManagedDepartmentsAccessible,
  buildEmployeeDirectoryQuery,
  buildEmployedInCalendarYearQuery,
  isUserInTeamScope,
  resolveTeamScopedUserIds,
} from '../services/teamScopeService.js';
import {
  assertEmployeePatchAllowed,
  assertEmployeeReadable,
  buildEmployeeFieldAccess,
  maskEmployeePayload,
} from '../services/employeeFieldAccessService.js';
import {
  redactAuditExportRow,
  redactAuditLogForCaller,
} from '../services/auditLogAccessService.js';

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
import { formatDeviceFullLabel, formatDeviceOwnerLabel, getBrowserFromUserAgent, getDeviceTypeFromUserAgent, getOsFromUserAgent } from '../utils/deviceType.js';
import { AuditLog } from '../models/AuditLog.js';
import { enrichAuditLogsWithConflicts } from '../services/deviceConflictService.js';
const attendanceQuerySchema = paginationSchema
  .extend({
    userId: objectIdSchema.optional(),
    departmentId: objectIdSchema.optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
      .optional(),
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD.')
      .optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateFrom must be YYYY-MM-DD.')
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateTo must be YYYY-MM-DD.')
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
  joiningFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'joiningFrom must be YYYY-MM-DD.')
    .optional(),
  joiningTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'joiningTo must be YYYY-MM-DD.')
    .optional(),
  employedInYear: z.coerce.number().int().min(2000).max(2100).optional(),
});

/**
 * Reporting-manager team creation: Employee role only, always reporting to
 * the RM themself, department restricted to the RM's managed departments
 * (enforced again inside createEmployee via departmentScope). Privileged
 * fields are stripped so a scoped creator can never mint managers, hand out
 * team scopes, or set delegates/activity flags.
 */
async function createScopedTeamEmployee(req, body) {
  const actorSlug = req.user?.roleId?.slug
    ?? (await Role.findById(req.user?.roleId)?.select('slug').lean())?.slug;
  if (actorSlug !== SYSTEM_ROLE_SLUGS.REPORTING_MANAGER) {
    const error = new Error('Only reporting managers can add team members without full user access.');
    error.statusCode = 403;
    throw error;
  }
  const employeeRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.EMPLOYEE }).select('_id').lean();
  if (!employeeRole) {
    const error = new Error('Employee role is not configured.');
    error.statusCode = 500;
    throw error;
  }
  if (body.roleId && String(body.roleId) !== String(employeeRole._id)) {
    const error = new Error('Reporting managers can only create Employee accounts.');
    error.statusCode = 403;
    throw error;
  }
  body.roleId = employeeRole._id.toString();
  const managedIds = await getActorManagedDepartmentIds(req.user);
  if (managedIds.length === 0) {
    const error = new Error('No managed departments are assigned to your account. Ask an admin to assign one before adding team members.');
    error.statusCode = 403;
    throw error;
  }
  // Stringify: the input schema validates ObjectIds in string form (JSON
  // request bodies always arrive as strings; direct ObjectIds would fail).
  body.reportingManagerId = req.user._id.toString();
  body.managedDepartmentIds = [];
  body.delegateApproverId = null;
  body.isActive = true;
  return createEmployee(body, req.user._id, {
    departmentScope: { all: false, departmentIds: managedIds },
  });
}

/**
 * Admin-role check that works whether roleId is populated or raw: a populated
 * role document's bare toString() never equals the id, so compare _id first.
 */
function isAdminRoleHolder(userDoc, adminRole) {
  if (!adminRole) return false;
  const roleId =
    userDoc?.roleId?._id?.toString() ?? userDoc?.roleId?.toString?.() ?? null;
  return roleId !== null && roleId === adminRole._id.toString();
}

/**
 * Only role administrators may grant the Admin system role (single register
 * + profile role changes): holders of the Admin role slug or the
 * roles.manage permission. The register/edit pages show the option to the
 * same set, and this backstops direct API calls. (A roles.manage holder can
 * already craft equivalent power via custom roles, so excluding them here
 * would only produce 403-on-submit dead ends.)
 */
async function assertCanAssignRole(actor, roleId, permissions = []) {
  if (!roleId) return;
  const role = await Role.findById(roleId).select('slug').lean();
  if (role?.slug !== SYSTEM_ROLE_SLUGS.ADMIN) return;
  if (hasPermission(permissions, PERMISSIONS.ROLES_MANAGE)) return;
  const actorSlug = actor?.roleId?.slug
    ?? (await Role.findById(actor?.roleId)?.select('slug').lean())?.slug;
  if (actorSlug !== SYSTEM_ROLE_SLUGS.ADMIN) {
    const error = new Error('Only admins can assign the Admin role.');
    error.statusCode = 403;
    throw error;
  }
}

async function buildEmployeeDirectoryQueryWithRoleFilter(requestedRoleId) {
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  const adminRoleId = adminRole?._id?.toString() ?? null;
  // Admins are listed when the role filter is All — or when the Admin role
  // itself is selected (previously that combination matched nothing).
  const includeAdmins = !requestedRoleId || (adminRoleId && String(requestedRoleId) === adminRoleId);
  return buildEmployeeDirectoryQuery({ includeAdmins });
}

async function applyEmployeeListFilters(query, {
  search,
  isActive,
  departmentId,
  roleId,
  createdAfter,
  joiningFrom,
  joiningTo,
  employedInYear,
}) {
  if (employedInYear != null) {
    const yearQuery = buildEmployedInCalendarYearQuery(employedInYear);
    if (yearQuery) {
      if (!query.$and) {
        query.$and = [];
      }
      query.$and.push(...yearQuery.$and);
    }
  } else if (typeof isActive === 'boolean') {
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

  if (joiningFrom || joiningTo) {
    const range = {};
    if (joiningFrom) {
      const fromDay = parseDateInputAsISTDay(joiningFrom);
      if (fromDay) range.$gte = startOfDayIST(fromDay);
    }
    if (joiningTo) {
      const toDay = parseDateInputAsISTDay(joiningTo);
      if (toDay) range.$lte = endOfDayIST(toDay);
    }
    if (Object.keys(range).length > 0) {
      query.joiningDate = range;
    }
  }

  if (search) {
    const trimmed = search.trim();
    // Token-AND matching: every whitespace-separated token must match
    // name/email/mobile/code (partial, case-insensitive), so "Anand Abhishek"
    // finds "Abhishek Anand" and single keystrokes narrow live.
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const tokenClauses = tokens.map((token) => {
      const tokenRegex = new RegExp(escapeRegex(token), 'i');
      return {
        $or: [
          { name: tokenRegex },
          { firstName: tokenRegex },
          { lastName: tokenRegex },
          { email: tokenRegex },
          { mobile: tokenRegex },
          { employeeCode: tokenRegex },
        ],
      };
    });
    const fullRegex = new RegExp(escapeRegex(trimmed), 'i');
    const matchingDepts = await Department.find({ name: fullRegex }).select('_id').lean();
    const deptIds = matchingDepts.map((d) => d._id);
    query.$and = query.$and ?? [];
    query.$and.push({
      $or: [
        // All tokens match (single token behaves exactly like before).
        ...(tokenClauses.length > 1 ? [{ $and: tokenClauses }] : tokenClauses),
        ...(deptIds.length > 0 ? [{ departmentId: { $in: deptIds } }] : []),
      ],
    });
  }

  return query;
}

function applyTeamScopeToEmployeeQuery(query, req) {
  return applyEmployeeTeamScope(query, req.user, req.userPermissions);
}

async function assertEmployeeInTeamScope(req, employeeId) {
  return isUserInTeamScope(req.user, req.userPermissions, employeeId);
}

export async function registerEmployee(req, res) {
  if (req.body?.roleId && !hasPermission(req.userPermissions, PERMISSIONS.EMPLOYEES_REGISTER_X1)) {
    return res.status(403).json({ message: 'You do not have permission to assign roles when registering employees.' });
  }
  if (req.body?.monthlySalary != null && !hasPermission(req.userPermissions, PERMISSIONS.EMPLOYEES_REGISTER_X2)) {
    return res.status(403).json({ message: 'You do not have permission to set salary at registration.' });
  }

  // Auto-generate a temporary password and email it to the new employee.
  // The plaintext exists only in this request scope — never persisted/logged.
  const sendCredentialsEmail = req.body?.sendCredentialsEmail === true;
  if (sendCredentialsEmail && !hasPermission(req.userPermissions, PERMISSIONS.EMPLOYEES_REGISTER_X0)) {
    return res.status(403).json({ message: 'You do not have permission to auto-generate credentials.' });
  }
  const body = { ...req.body };
  let tempPassword = null;
  if (sendCredentialsEmail) {
    tempPassword = generatePassword();
    body.password = tempPassword;
  }

  try {
    if (body.departmentId) {
      await assertDepartmentInAccessibleSet(req.user, req.userPermissions, body.departmentId);
    }
    if (body.managedDepartmentIds?.length) {
      await assertManagedDepartmentsAccessible(
        req.user,
        req.userPermissions,
        body.managedDepartmentIds,
      );
    }
  } catch (scopeError) {
    return res.status(scopeError.statusCode ?? 403).json({ message: scopeError.message });
  }

  await assertCanAssignRole(req.user, body.roleId, req.userPermissions);

  const canWriteAll = hasPermission(req.userPermissions, PERMISSIONS.USERS_WRITE);
  const employee = canWriteAll
    ? await createEmployee(body, req.user._id, {
        actor: req.user,
        permissions: req.userPermissions,
      })
    : await createScopedTeamEmployee(req, body);

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
    scopedCreation: !canWriteAll,
  });
  res.status(201).json({
    employee: { ...employee, mustChangePassword: sendCredentialsEmail },
    ...(credentialsEmail ? { credentialsEmail } : {}),
  });
}

export async function listEmployees(req, res) {
  const {
    page,
    limit,
    search,
    isActive,
    departmentId,
    roleId,
    createdAfter,
    joiningFrom,
    joiningTo,
    employedInYear,
  } = employeeListQuerySchema.parse(req.query);

  if (departmentId) {
    try {
      await assertDepartmentInAccessibleSet(req.user, req.userPermissions, departmentId);
    } catch (scopeError) {
      return res.status(scopeError.statusCode ?? 403).json({ message: scopeError.message });
    }
  }

  const now = new Date();
  await User.updateMany(
    { endingDate: { $lte: now }, isActive: true },
    { $set: { isActive: false } },
  );

  const query = await applyTeamScopeToEmployeeQuery(
    await applyEmployeeListFilters(await buildEmployeeDirectoryQueryWithRoleFilter(roleId), {
      search,
      isActive,
      departmentId,
      roleId,
      createdAfter,
      joiningFrom,
      joiningTo,
      employedInYear,
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

  const fieldAccess = buildEmployeeFieldAccess(req.userPermissions);
  const canViewSalary = fieldAccess.salaryColumn && canViewSalaryFields(req.userPermissions);
  const exposeEmploymentDatesForSalaryHistory =
    employedInYear != null
    && hasPermission(req.userPermissions, PERMISSIONS.EMPLOYEES_SALARY_HISTORY_R);
  res.json({
    employees: employees.map((employee) => {
      const json = {
        ...employee.toSafeJSON({ canViewSalary }),
        lastLoginAt: employee.lastLoginAt ?? null,
      };
      const masked = maskEmployeePayload(json, req.userPermissions, { includeMeta: false });
      if (exposeEmploymentDatesForSalaryHistory) {
        masked.joiningDate = json.joiningDate ?? null;
        masked.endingDate = json.endingDate ?? null;
      }
      return masked;
    }),
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
  departmentId: objectIdSchema.optional(),
  roleId: objectIdSchema.optional(),
  userId: objectIdSchema.optional(),
});

export async function getTeamTodayStatusAdmin(req, res) {
  const parsed = teamTodayQuerySchema.parse(req.query);
  const result = await getTeamTodayStatusService(req.user, req.userPermissions, {
    paginate: true,
    page: parsed.page,
    limit: parsed.limit,
    search: parsed.search ?? '',
    departmentId: parsed.departmentId ?? undefined,
    roleId: parsed.roleId ?? undefined,
    userId: parsed.userId ?? undefined,
  });
  res.json(result);
}

export async function getEmployeeStats(req, res) {
  const baseQuery = await applyTeamScopeToEmployeeQuery(
    await buildEmployeeDirectoryQuery({ includeAdmins: true }),
    req,
  );
  const monthKey = getISTDateInputValue().slice(0, 7);
  const { start: monthStart } = parseMonthInputAsISTRange(monthKey);

  const [total, active, inactive, newThisMonth, oldestJoining, roleBreakdown] = await Promise.all([
    User.countDocuments(baseQuery),
    User.countDocuments({ ...baseQuery, isActive: true }),
    User.countDocuments({ ...baseQuery, isActive: false }),
    User.countDocuments({ ...baseQuery, createdAt: { $gte: monthStart } }),
    User.findOne({ ...baseQuery, joiningDate: { $ne: null } })
      .sort({ joiningDate: 1 })
      .select('joiningDate')
      .lean(),
    User.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$roleId', count: { $sum: 1 } } },
      {
        $lookup: {
          from: 'roles',
          localField: '_id',
          foreignField: '_id',
          as: 'role',
        },
      },
      { $unwind: { path: '$role', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          roleId: { $toString: '$_id' },
          slug: '$role.slug',
          name: '$role.name',
          count: 1,
        },
      },
      { $sort: { count: -1 } },
    ]),
  ]);

  // Lower bound for every year dropdown (dynamic §8 rule): oldest joining
  // year in scope, null when no dated employees exist.
  const oldestJoiningYear = oldestJoining?.joiningDate
    ? Number(getISTDateInputValue(new Date(oldestJoining.joiningDate)).slice(0, 4))
    : null;

  res.json({
    stats: {
      total,
      active,
      inactive,
      newThisMonth,
      monthKey,
      oldestJoiningYear: Number.isInteger(oldestJoiningYear) ? oldestJoiningYear : null,
      roleBreakdown: Array.isArray(roleBreakdown) ? roleBreakdown : [],
    },
  });
}

export async function getEmployee(req, res) {
  const idResult = objectIdSchema.safeParse(req.params.id);
  if (!idResult.success) {
    return res.status(400).json({ message: 'Invalid employee identifier.' });
  }

  // Auto-deactivate if ending date has passed.
  const now = new Date();
  await User.updateMany(
    { _id: idResult.data, endingDate: { $lte: now }, isActive: true },
    { $set: { isActive: false } },
  );

  const employee = await User.findById(idResult.data).populate(USER_POPULATE_FIELDS);

  if (!employee) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  if (isAdminRoleHolder(employee, adminRole)) {
    return res.status(404).json({ message: 'Employee not found.' });
  }

  const readable = await assertEmployeeReadable(req.user, req.userPermissions, employee._id);
  if (!readable.ok) {
    return res.status(readable.status).json({ message: readable.message });
  }

  const fieldAccess = buildEmployeeFieldAccess(req.userPermissions);
  const canViewSalary = fieldAccess.salary.read || canViewSalaryFields(req.userPermissions);

  res.json({
    employee: maskEmployeePayload(
      {
        ...employee.toSafeJSON({ canViewSalary }),
        lastLoginAt: employee.lastLoginAt ?? null,
      },
      req.userPermissions,
    ),
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
    .select('name email roleId employeeCode managedDepartmentIds')
    .populate('roleId', 'name slug')
    .populate('managedDepartmentIds', 'name code')
    .sort({ name: 1 })
    .limit(limit);

  res.json({
    managers: managers.map((manager) => ({
      id: manager._id.toString(),
      name: manager.name,
      email: manager.email,
      employeeCode: manager.employeeCode ?? null,
      roleName: manager.roleId?.name ?? null,
      managedDepartments: (manager.managedDepartmentIds || []).map((d) => ({
        id: d._id.toString(),
        name: d.name,
        code: d.code,
      })),
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
  if (isAdminRoleHolder(employee, adminRole)) {
    return res.status(400).json({ message: 'Cannot modify the system admin account here.' });
  }

  const readable = await assertEmployeeReadable(req.user, req.userPermissions, employee._id);
  if (!readable.ok) {
    return res.status(readable.status).json({ message: readable.message });
  }

  const patchAllowed = assertEmployeePatchAllowed(req.userPermissions, req.body);
  if (!patchAllowed.ok) {
    return res.status(403).json({ message: patchAllowed.message });
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
    const nextRoleId = refId(parsed.roleId);
    if (nextRoleId !== previous.roleId) {
      const canAssignRole =
        hasPermission(req.userPermissions, PERMISSIONS.RBAC_ROLE_X0) ||
        hasPermission(req.userPermissions, PERMISSIONS.RBAC_USER_U) ||
        hasPermission(req.userPermissions, PERMISSIONS.EMPLOYEES_EMPLOYMENT_U);
      if (!canAssignRole) {
        return res.status(403).json({ message: 'You do not have permission to assign roles to users.' });
      }
    }
    await assertCanAssignRole(req.user, parsed.roleId, req.userPermissions);
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
      try {
        await assertDepartmentInAccessibleSet(
          req.user,
          req.userPermissions,
          parsed.departmentId,
        );
      } catch (scopeError) {
        return res.status(scopeError.statusCode ?? 403).json({ message: scopeError.message });
      }
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
    // Clearing a planned end date resumes employment.
    if (parsed.endingDate === null && previous.endingDate) {
      employee.isActive = true;
    }
  }

  if (parsed.managedDepartmentIds !== undefined) {
    try {
      await assertManagedDepartmentsAccessible(
        req.user,
        req.userPermissions,
        parsed.managedDepartmentIds,
      );
    } catch (scopeError) {
      return res.status(scopeError.statusCode ?? 403).json({ message: scopeError.message });
    }
    employee.managedDepartmentIds = await resolveManagedDepartments(parsed.managedDepartmentIds);
  }

  // Explicit reactivation cancels a past end date so the auto-deactivate
  // guard below does not immediately revert isActive on status-only PATCHes.
  if (parsed.isActive === true && employee.endingDate && new Date(employee.endingDate) < new Date()) {
    employee.endingDate = null;
  }

  // Auto-deactivate if ending date is in the past.
  if (employee.endingDate && new Date(employee.endingDate) < new Date()) {
    employee.isActive = false;
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

  const fieldAccess = buildEmployeeFieldAccess(req.userPermissions);
  res.json({
    employee: maskEmployeePayload(
      employee.toSafeJSON({
        canViewSalary: fieldAccess.salary.read || canViewSalaryFields(req.userPermissions),
      }),
      req.userPermissions,
    ),
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
  if (isAdminRoleHolder(employee, adminRole)) {
    return res.status(400).json({ message: 'Cannot reset password for the system admin here.' });
  }

  const readable = await assertEmployeeReadable(req.user, req.userPermissions, employee._id);
  if (!readable.ok) {
    return res.status(readable.status).json({ message: readable.message });
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
  if (isAdminRoleHolder(employee, adminRole)) {
    return res.status(400).json({ message: 'Cannot reset PIN for the system admin here.' });
  }

  const readable = await assertEmployeeReadable(req.user, req.userPermissions, employee._id);
  if (!readable.ok) {
    return res.status(readable.status).json({ message: readable.message });
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

/**
 * Managed department IDs for an actor, as strings. Local fallback until
 * teamScopeService exposes this resolver — same contract the bulk scope
 * check below relies on (empty array = unrestricted).
 */
async function getActorManagedDepartmentIds(actor) {
  if (!actor?._id) return [];
  const doc = await User.findById(actor._id).select('managedDepartmentIds').lean();
  return (doc?.managedDepartmentIds ?? []).map((id) => id.toString());
}

/**
 * Validate that all departments referenced in the bulk upload rows are within
 * the actor's department scope. Returns { rejected, message, warnings }.
 */
async function validateBulkDepartmentScope(rows, actor, permissions) {
  if (hasCompanyWideScope(permissions, actor)) {
    return { rejected: false, warnings: [] };
  }

  const managedIds = await getActorManagedDepartmentIds(actor);
  if (managedIds.length === 0) {
    // No managed departments — allowed for roles without department scope (e.g. plain RM).
    return { rejected: false, warnings: [] };
  }

  const managedSet = new Set(managedIds);

  // Collect unique department codes from the file rows.
  const deptCodes = new Set();
  for (const row of rows) {
    const code = String(row.data.departmentCode ?? row.data.department ?? '').trim().toUpperCase();
    if (code) deptCodes.add(code);
  }
  if (deptCodes.size === 0) return { rejected: false, warnings: [] };

  // Look up existing departments.
  const existing = await Department.find({ code: { $in: [...deptCodes] } }).select('code _id isActive').lean();
  const deptByCode = new Map(existing.map((d) => [d.code, d]));

  const warnings = [];
  for (const code of deptCodes) {
    const dept = deptByCode.get(code);
    if (!dept) {
      return { rejected: true, message: `Department "${code}" does not exist. Create it before uploading.` };
    }
    if (!managedSet.has(dept._id.toString())) {
      return { rejected: true, message: `You do not have scope for department "${code}". Only your assigned departments are allowed.` };
    }
    if (!dept.isActive) {
      warnings.push(`Department "${code}" is inactive. Employees will be assigned but may not appear in active views.`);
    }
  }

  return { rejected: false, warnings };
}

export async function bulkUploadEmployees(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: 'Excel file is required.' });
  }

  const rows = parseEmployeeWorkbook(req.file.buffer);
  if (rows.length === 0) {
    return res.status(400).json({ message: 'No employee rows found in file.' });
  }

  // Department scope validation: ensure all departments in the file are within the actor's scope.
  const scopeCheck = await validateBulkDepartmentScope(rows, req.user, req.userPermissions);
  if (scopeCheck.rejected) {
    return res.status(403).json({ message: scopeCheck.message });
  }

  const fileWarnings = Array.isArray(rows.warnings) ? rows.warnings : [];
  const result = await importEmployeesFromRowsUpsert(rows, req.user._id, {
    actorId: req.user._id.toString(),
    actorPermissions: req.userPermissions ?? [],
  });
  if (fileWarnings.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...fileWarnings];
  }
  if (scopeCheck.warnings?.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...scopeCheck.warnings];
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

  const affectedUserIds = changes
    .filter((c) => c.id)
    .map((c) => c.id);
  if (affectedUserIds.length > 0) {
    await User.updateMany(
      { _id: { $in: affectedUserIds } },
      { $set: { lastBulkImportAt: new Date(), lastBulkImportBy: req.user._id } },
    );
  }

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

  // Department scope validation.
  const scopeCheck = await validateBulkDepartmentScope(rows, req.user, req.userPermissions);
  if (scopeCheck.rejected) {
    return res.status(403).json({ message: scopeCheck.message });
  }

  const fileWarnings = Array.isArray(rows.warnings) ? rows.warnings : [];
  const result = await importEmployeesFromRowsUpsert(rows, req.user._id, {
    dryRun: true,
    actorId: req.user._id.toString(),
    actorPermissions: req.userPermissions ?? [],
  });
  if (fileWarnings.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...fileWarnings];
  }
  if (scopeCheck.warnings?.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...scopeCheck.warnings];
  }

  res.json(result);
}

export async function getOfficeSettingsHandler(req, res) {
  const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 }).lean();
  res.set('Cache-Control', 'no-store');
  res.json({ settings });
}

const OFFICE_SETTINGS_PATCH_GROUPS = [
  {
    keys: ['latitude', 'longitude', 'radiusMeters', 'maxAccuracyMeters', 'name'],
    permission: PERMISSIONS.OPS_GEOFENCE_U,
  },
  {
    keys: ['officeStartTime', 'officeEndTime', 'graceThresholdTime', 'halfDayThresholdTime'],
    permission: PERMISSIONS.OPS_HOURS_U,
  },
  { keys: ['weekendDays'], permission: PERMISSIONS.OPS_WEEKEND_U },
  { keys: ['sandwichLeaveEnabled'], permission: PERMISSIONS.OPS_SANDWICH_U },
  { keys: ['warningsPerQuarter'], permission: PERMISSIONS.OPS_WARNING_LIMIT_U },
  { keys: ['autoCheckout'], permission: PERMISSIONS.OPS_AUTOCHECKOUT_U },
];

function assertOfficeSettingsPatchAllowed(permissions, parsed, previous) {
  for (const { keys, permission } of OFFICE_SETTINGS_PATCH_GROUPS) {
    for (const key of keys) {
      if (parsed[key] === undefined) continue;
      const before = previous?.[key] ?? null;
      const after = parsed[key];
      if (JSON.stringify(before) !== JSON.stringify(after) && !hasPermission(permissions, permission)) {
        return { ok: false, message: `You do not have permission to update ${key}.` };
      }
    }
  }
  return { ok: true };
}

export async function updateOfficeSettings(req, res) {
  const parsed = officeUpdateSchema.parse(req.body);
  let settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  const previous = settings ? settings.toObject() : null;

  const patchAllowed = assertOfficeSettingsPatchAllowed(req.userPermissions, parsed, previous);
  if (!patchAllowed.ok) {
    return res.status(403).json({ message: patchAllowed.message });
  }
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
      adminMarkedAbsent: Boolean(result.checkIn.adminMarkedAbsent),
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

  if (result.adminMarkedAbsent) {
    res.status(result.created ? 201 : 200).json({
      record: {
        id: result.checkIn._id.toString(),
        userId: result.checkIn.userId.toString(),
        type: result.checkIn.type,
        timestamp: result.checkIn.timestamp,
        attendanceMode: result.checkIn.attendanceMode,
        attendanceTag: result.checkIn.attendanceTag,
        lateNote: result.checkIn.lateNote,
        status: result.checkIn.status,
        dayKey: result.dayKey,
        checkInTime: null,
        checkOutTime: null,
        adminMarkedAbsent: true,
        lastEditedAt: result.checkIn.lastEditedAt ?? null,
        lastEditedBy: result.checkIn.lastEditedBy ?? null,
        editHistory: result.checkIn.editHistory ?? [],
        created: Boolean(result.created),
      },
      adminMarkedAbsent: true,
    });
    return;
  }

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
      adminMarkedAbsent: Boolean(result.checkIn.adminMarkedAbsent),
      created: Boolean(result.created),
    },
  });
}

export async function getQuarterWarningSummary(req, res) {
  res.set('Cache-Control', 'no-store');

  let userIds = [];
  if (hasCompanyWideScope(req.userPermissions, req.user)) {
    const employees = await User.find(await buildEmployeeDirectoryQuery())
      .select('_id')
      .lean();
    userIds = employees.map((item) => item._id);
  } else if (req.user?._id) {
    const scopedIds = await resolveTeamScopedUserIds(req.user, req.userPermissions);
    userIds = scopedIds ?? [];
  }

  const summary = await getQuarterWarningSummaryForUsers(userIds);
  res.json(summary);
}

export async function resetQuarterWarnings(req, res) {
  const { userIds, reason } = resetQuarterWarningsSchema.parse(req.body);

  const scopedIds = await resolveTeamScopedUserIds(req.user, req.userPermissions);

  if (scopedIds !== null) {
    const scopedSet = new Set(scopedIds.map((id) => id.toString()));
    const unauthorized = userIds.filter((id) => !scopedSet.has(String(id)));
    if (unauthorized.length) {
      return res.status(403).json({
        message: 'You do not have permission to reset warnings for one or more selected employees.',
      });
    }
  }

  const result = await resetQuarterWarningsForUsers(userIds);

  auditRequest(req, 'quarter_warnings_reset', {
    adminId: req.user._id.toString(),
    roleId: req.user?.roleId?._id?.toString?.() ?? req.user?.roleId?.toString?.() ?? undefined,
    userIds: result.userIds,
    quarter: result.quarter?.label ?? null,
    clearedWarnings: result.clearedWarnings,
    reclassifiedLv: result.reclassifiedLv,
    clearedRecordIds: result.clearedRecordIds ?? [],
    clearedRecordIdsTruncated: result.clearedRecordIdsTruncated ?? false,
    reclassifiedRecordIds: result.reclassifiedRecordIds,
    reason: reason || 'manual_reset',
    before: result.before,
    after: result.after,
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

  const scopedIds = await resolveTeamScopedUserIds(req.user, req.userPermissions);

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

  const allowed = await resolveTeamScopedUserIds(req.user, req.userPermissions);
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

  const allowed = await resolveTeamScopedUserIds(req.user, req.userPermissions);
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

/**
 * Batch-resolves actor display names for a page of audit logs (one query).
 * Returns a Map of userId string → name. Unknown/deleted users are absent.
 */
async function resolveAuditActorNames(logs) {
  const ids = [
    ...new Set(
      (logs ?? [])
        .map((log) => log?.userId?.toString?.() ?? null)
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  return new Map(
    users.map((user) => [user._id.toString(), user.name ?? null]),
  );
}

function mapAuditLogResponse(log, conflict, actorName = null) {
  const metadata = log.metadata ?? null;
  return {
    id: log._id.toString(),
    action: log.action,
    userId: log.userId?.toString() ?? null,
    email: log.email ?? null,
    role: log.role ?? null,
    actorName: actorName ?? null,
    deviceType: getDeviceTypeFromUserAgent(log.userAgent),
    browser: getBrowserFromUserAgent(log.userAgent),
    os: getOsFromUserAgent(log.userAgent),
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

export function auditLogExportRows(logs, actorNames = new Map()) {
  const actorNameFor = (log) => {
    const id = log?.userId?.toString?.() ?? null;
    return (id && actorNames.get(id)) || null;
  };
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
    Device:
      formatDeviceFullLabel(actorNameFor(log), {
        deviceType: getDeviceTypeFromUserAgent(log.userAgent),
        browser: getBrowserFromUserAgent(log.userAgent),
        os: getOsFromUserAgent(log.userAgent),
      }) ?? 'Not recorded',
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
  const actorNames = await resolveAuditActorNames(logs);
  const rows = auditLogExportRows(logs, actorNames).map((row) =>
    redactAuditExportRow(row, req.userPermissions),
  );
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
    const actorNames = await resolveAuditActorNames(logs);

    res.json({
      logs: logs.map((log) => {
        const conflict = conflictMapForPage.get(log._id.toString()) ?? {
          ipConflict: false,
          conflictWithUsers: [],
        };
        return redactAuditLogForCaller(
          mapAuditLogResponse(log, conflict, actorNames.get(log.userId?.toString?.() ?? '') ?? null),
          req.userPermissions,
        );
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
  const actorNames = await resolveAuditActorNames(logs);

  res.json({
    logs: logs.map((log) => {
      const conflict = conflictMap.get(log._id.toString()) ?? {
        ipConflict: false,
        conflictWithUsers: [],
      };
      return redactAuditLogForCaller(
        mapAuditLogResponse(log, conflict, actorNames.get(log.userId?.toString?.() ?? '') ?? null),
        req.userPermissions,
      );
    }),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
}