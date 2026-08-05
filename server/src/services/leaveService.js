import mongoose from 'mongoose';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import {
  getISTDateInputValue,
  getISTYear,
  computeLeaveDaysIST,
  parseDateInputAsISTDay,
} from '../utils/istDate.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeaveRequest, LEAVE_REQUEST_POPULATE } from '../models/LeaveRequest.js';
import { Holiday } from '../models/Holiday.js';
import { Department } from '../models/Department.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { createNotification } from './notificationService.js';
import {
  approvePendingDays,
  ensureBalancesForUser,
  getAvailableBalance,
  getPolicyMapForYear,
  refreshAccruedEntitlements,
  releasePendingDays,
  resolveLeaveYear,
  resolvePolicyForLeaveType,
  validateCombinedAccumulation,
} from './leaveBalanceService.js';
import { auditLog } from '../utils/auditLog.js';
import {
  resolveLeaveApprovalUserIds,
  resolveTeamScopedUserIds,
} from './teamScopeService.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

/** Leave types approved immediately on submit (no manager queue). */
export const AUTO_APPROVE_LEAVE_TYPE_CODES = new Set(['SL']);

export function isAutoApproveLeaveType(leaveType) {
  return AUTO_APPROVE_LEAVE_TYPE_CODES.has(String(leaveType?.code ?? '').toUpperCase());
}

async function applyLeaveApproval(
  request,
  { userId, leaveTypeId, days, year, session, approverId = null, comment = null },
) {
  await approvePendingDays(userId, leaveTypeId, days, year, session);
  request.status = 'approved';
  request.approverId = approverId;
  request.decidedAt = new Date();
  request.decisionComment = comment;
  await request.save({ session });
}

async function notifyEmployeeLeaveApproved(request, userId) {
  await createNotification({
    userId,
    type: 'leave.approved',
    title: 'Leave approved',
    body: `Your leave request for ${request.days} day(s) was approved.`,
    link: '/employee/leave/requests',
    metadata: { requestId: request._id.toString() },
  });
}

export async function getHolidayDateSet(year) {
  const start = parseDateInputAsISTDay(`${year}-01-01`);
  const end = parseDateInputAsISTDay(`${year}-12-31`);
  const holidays = await Holiday.find({
    isActive: true,
    date: { $gte: start, $lte: end },
  });
  return new Set(holidays.map((item) => getISTDateInputValue(item.date)));
}

export async function isSandwichLeaveEnabled() {
  const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  return Boolean(settings?.sandwichLeaveEnabled);
}

export async function loadLeaveRequest(requestId) {
  if (!mongoose.isValidObjectId(requestId)) {
    throwError('Leave request not found.', 404);
  }
  const request = await LeaveRequest.findById(requestId).populate(LEAVE_REQUEST_POPULATE);
  if (!request) {
    throwError('Leave request not found.', 404);
  }
  return request;
}

async function loadRequester(userId) {
  const user = await User.findById(userId).populate(USER_POPULATE_FIELDS);
  if (!user || !user.isActive) {
    throwError('Employee not found.', 404);
  }
  return user;
}

export function canApproveLeave(actor, requester, permissions) {
  if (!hasPermission(permissions, PERMISSIONS.LEAVE_APPROVE)) {
    return false;
  }
  if (hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
    return true;
  }
  const managerId =
    requester.reportingManagerId?._id?.toString() ??
    requester.reportingManagerId?.toString?.() ??
    null;
  if (managerId === actor._id.toString()) {
    return true;
  }

  const managerDoc =
    requester.reportingManagerId && typeof requester.reportingManagerId === 'object'
      ? requester.reportingManagerId
      : null;
  const delegateId =
    managerDoc?.delegateApproverId?._id?.toString() ??
    managerDoc?.delegateApproverId?.toString?.() ??
    null;
  return delegateId === actor._id.toString();
}

export async function validateLeaveRequestInput({
  userId,
  leaveTypeId,
  startDateInput,
  endDateInput,
  halfDay = null,
  documentUrl,
  adminException = false,
}) {
  const leaveType = await LeaveType.findById(leaveTypeId);
  if (!leaveType || !leaveType.isActive) {
    throwError('Leave type not found or inactive.');
  }

  const startDate = parseDateInputAsISTDay(startDateInput);
  const endDate = parseDateInputAsISTDay(endDateInput);
  if (!startDate || !endDate || endDate < startDate) {
    throwError('Invalid leave date range.');
  }

  if (halfDay && startDateInput !== endDateInput) {
    throwError('Half-day leave must use the same start and end date.');
  }

  const year = resolveLeaveYear(startDateInput);
  const policy = await resolvePolicyForLeaveType(leaveTypeId, year);
  if (!policy) {
    throwError('Leave policy not configured for this type.');
  }

  const holidayDates = await getHolidayDateSet(year);
  const sandwichLeaveEnabled = await isSandwichLeaveEnabled();
  const dayResult = computeLeaveDaysIST(startDate, endDate, holidayDates, {
    halfDay,
    sandwichLeaveEnabled,
  });

  if (dayResult.invalidHalfDay) {
    throwError('Half-day leave must fall on a single working day.');
  }

  const { days, workingDays } = dayResult;

  if (workingDays.length === 0) {
    throwError('Leave range has no working days (weekends/holidays only).');
  }

  if (
    policy.requireDocAfterConsecutiveDays &&
    !halfDay &&
    days > policy.requireDocAfterConsecutiveDays &&
    !documentUrl
  ) {
    throwError(
      `Medical certificate required for sick leave exceeding ${policy.requireDocAfterConsecutiveDays} consecutive working day(s).`,
    );
  }

  await refreshAccruedEntitlements(userId, year);
  await ensureBalancesForUser(userId, year);
  const policyMap = await getPolicyMapForYear(year);

  const balance = await LeaveBalance.findOne({ userId, leaveTypeId, year });
  if (!balance) {
    throwError('Leave balance not found for this year.');
  }

  const available = getAvailableBalance(balance);
  if (days > available) {
    throwError(`Insufficient leave balance. Available: ${available} day(s).`);
  }

  const stockAfter =
    (balance.entitled ?? 0) + (balance.carried ?? 0) - (balance.used ?? 0) - (balance.pending ?? 0) - days;
  if (stockAfter < 0 && policy.maxAccumulation > 0 && !policy.combinedCarryGroup) {
    throwError(`Leave balance exceeds maximum accumulation of ${policy.maxAccumulation} days.`);
  }

  await validateCombinedAccumulation(userId, year, policyMap, days, leaveTypeId);
  await validateSelfOverlap(userId, startDate, endDate);
  await validateLeadDeputyConflict(userId, startDate, endDate, adminException);

  return {
    leaveType,
    policy,
    startDate,
    endDate,
    days,
    year,
    workingDays,
    balance,
    balancePendingDelta: days,
  };
}

async function reserveValidatedLeaveBalance(balance, days, session = null) {
  balance.pending += days;
  await balance.save(session ? { session } : undefined);
}

async function validateSelfOverlap(userId, startDate, endDate) {
  const overlap = await LeaveRequest.findOne({
    userId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  });

  if (overlap) {
    throwError('You already have leave overlapping this date range.');
  }
}

async function validateLeadDeputyConflict(userId, startDate, endDate, adminException) {
  if (adminException) return;

  const user = await User.findById(userId);
  if (!user?.departmentId) return;

  const department = await Department.findById(user.departmentId);
  if (!department) return;

  const leadId = department.leadUserId?.toString();
  const deputyId = department.deputyUserId?.toString();
  const requesterId = userId.toString();

  if (!leadId || !deputyId) return;
  if (requesterId !== leadId && requesterId !== deputyId) return;

  const counterpartId = requesterId === leadId ? deputyId : leadId;
  const conflict = await LeaveRequest.findOne({
    userId: counterpartId,
    status: { $in: ['pending', 'approved'] },
    adminException: false,
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  });

  if (conflict) {
    throwError(
      'Department Lead and Deputy cannot be on leave on the same day. Request admin exception if required.',
    );
  }
}

export async function createLeaveRequest(userId, payload) {
  const user = await loadRequester(userId);
  const adminException = Boolean(payload.adminException);

  const session = await mongoose.startSession();
  try {
    let createdRequest;
    let autoApproved = false;
    await session.withTransaction(async () => {
      const validated = await validateLeaveRequestInput({
        userId,
        leaveTypeId: payload.leaveTypeId,
        startDateInput: payload.startDate,
        endDateInput: payload.endDate,
        halfDay: payload.halfDay ?? null,
        documentUrl: payload.documentUrl,
        adminException,
      });

      await reserveValidatedLeaveBalance(validated.balance, validated.balancePendingDelta, session);

      const autoApprove = isAutoApproveLeaveType(validated.leaveType);
      autoApproved = autoApprove;

      const [request] = await LeaveRequest.create(
        [
          {
            userId,
            leaveTypeId: payload.leaveTypeId,
            startDate: validated.startDate,
            endDate: validated.endDate,
            days: validated.days,
            halfDay: payload.halfDay ?? null,
            reason: payload.reason,
            status: 'pending',
            documentUrl: payload.documentUrl ?? null,
            adminException,
          },
        ],
        { session },
      );

      if (autoApprove) {
        await applyLeaveApproval(request, {
          userId,
          leaveTypeId: payload.leaveTypeId,
          days: validated.days,
          year: validated.year,
          session,
        });
      }

      createdRequest = request;
    });

    if (autoApproved) {
      await notifyEmployeeLeaveApproved(createdRequest, userId);
      auditLog('leave_request_auto_approved', {
        userId: userId.toString(),
        requestId: createdRequest._id.toString(),
        leaveTypeId: payload.leaveTypeId,
        days: createdRequest.days,
        startDate: payload.startDate,
        endDate: payload.endDate,
      });
    } else {
      await notifyApproversOnSubmit(user, createdRequest);
      auditLog('leave_request_created', {
        userId: userId.toString(),
        requestId: createdRequest._id.toString(),
        leaveTypeId: payload.leaveTypeId,
        days: createdRequest.days,
        startDate: payload.startDate,
        endDate: payload.endDate,
      });
    }

    return (await LeaveRequest.findById(createdRequest._id).populate(LEAVE_REQUEST_POPULATE)).toSafeJSON();
  } finally {
    session.endSession();
  }
}

async function notifyApproversOnSubmit(requester, request) {
  const managerId =
    requester.reportingManagerId?._id?.toString() ??
    requester.reportingManagerId?.toString?.() ??
    null;

  const link = managerId ? '/admin/leave/approvals' : '/admin/leave/approvals';
  const title = 'New leave request';
  const body = `${requester.name} requested ${request.days} day(s) leave (${getISTDateInputValue(request.startDate)} – ${getISTDateInputValue(request.endDate)}).`;

  if (managerId) {
    await createNotification({
      userId: managerId,
      type: 'leave.pending',
      title,
      body,
      link,
      metadata: { requestId: request._id.toString() },
    });
    return;
  }

  const adminRole = await Role.findOne({ slug: 'admin' });
  const hrRole = await Role.findOne({ slug: 'hr' });
  const roleIds = [adminRole?._id, hrRole?._id].filter(Boolean);
  const admins = await User.find({ isActive: true, roleId: { $in: roleIds } }).select('_id');

  await Promise.all(
    admins.map((admin) =>
      createNotification({
        userId: admin._id,
        type: 'leave.pending_admin',
        title: 'Leave request (no manager)',
        body: `${requester.name} submitted leave without a reporting manager assigned.`,
        link,
        metadata: { requestId: request._id.toString() },
      }),
    ),
  );
}

export async function cancelLeaveRequest(requestId, actor) {
  const request = await loadLeaveRequest(requestId);
  if (request.userId?._id?.toString() !== actor._id.toString() && request.userId?.toString() !== actor._id.toString()) {
    throwError('You can only cancel your own leave requests.', 403);
  }
  if (request.status !== 'pending') {
    throwError('Only pending leave requests can be cancelled.');
  }

  const year = getISTYear(request.startDate);
  const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
  const userId = request.userId?._id ?? request.userId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await releasePendingDays(userId, leaveTypeId, request.days, year, session);

      request.status = 'cancelled';
      request.decidedAt = new Date();
      request.approverId = actor._id;
      await request.save({ session });
    });
  } finally {
    session.endSession();
  }

  auditLog('leave_request_cancelled', {
    userId: actor._id.toString(),
    requestId: request._id.toString(),
  });

  return request.toSafeJSON();
}

export async function decideLeaveRequest(requestId, actor, permissions, decision, payload = {}) {
  const request = await loadLeaveRequest(requestId);
  if (request.status !== 'pending') {
    throwError('Only pending requests can be approved or rejected.');
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to approve this leave request.', 403);
  }

  const year = getISTYear(request.startDate);
  const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
  const userId = request.userId?._id ?? request.userId;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (decision === 'approved') {
        if (payload.adminException) {
          request.adminException = true;
        }
        await applyLeaveApproval(request, {
          userId,
          leaveTypeId,
          days: request.days,
          year,
          session,
          approverId: actor._id,
          comment: payload.comment ?? null,
        });
      } else {
        await releasePendingDays(userId, leaveTypeId, request.days, year, session);
        request.status = 'rejected';
        request.approverId = actor._id;
        request.decidedAt = new Date();
        request.decisionComment = payload.comment ?? null;
        await request.save({ session });
      }

    });
  } finally {
    session.endSession();
  }

  if (decision === 'approved') {
    await notifyEmployeeLeaveApproved(request, userId);
  } else {
    await createNotification({
      userId,
      type: 'leave.rejected',
      title: 'Leave rejected',
      body: `Your leave request was rejected.${payload.comment ? ` Comment: ${payload.comment}` : ''}`,
      link: '/employee/leave/requests',
      metadata: { requestId: request._id.toString() },
    });
  }

  auditLog(decision === 'approved' ? 'leave_request_approved' : 'leave_request_rejected', {
    adminId: actor._id.toString(),
    userId: userId.toString(),
    requestId: request._id.toString(),
    comment: payload.comment ?? null,
  });

  return request.toSafeJSON();
}

export async function listLeaveRequests(actor, permissions, query) {
  const filter = {};
  const scope = query.scope;

  if (scope === 'mine' || (!hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL) && !hasPermission(permissions, PERMISSIONS.LEAVE_READ_TEAM) && scope !== 'approvals')) {
    filter.userId = actor._id;
  } else if (scope === 'approvals') {
    if (!hasPermission(permissions, PERMISSIONS.LEAVE_APPROVE)) {
      throwError('You do not have permission to view approval queue.', 403);
    }
    filter.status = 'pending';
    if (hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
      // Admin/HR sees all pending
    } else {
      const reportIds = await resolveLeaveApprovalUserIds(actor);
      filter.userId = { $in: reportIds };
    }
  } else if (scope === 'team') {
    if (!hasPermission(permissions, PERMISSIONS.LEAVE_READ_TEAM) && !hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
      throwError('You do not have permission to view team leave.', 403);
    }
    if (hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
      // unscoped
    } else {
      const reportIds = await resolveTeamScopedUserIds(
        actor,
        permissions,
        PERMISSIONS.LEAVE_READ_ALL,
        PERMISSIONS.LEAVE_READ_TEAM,
      );
      filter.userId = { $in: reportIds ?? [] };
    }
  } else if (scope === 'all') {
    if (!hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
      throwError('You do not have permission to view all leave requests.', 403);
    }
  }

  if (query.userId) {
    filter.userId = query.userId;
  }

  if (query.status && query.status !== 'all') {
    filter.status = query.status;
  }

  if (query.month) {
    const [yearStr, monthStr] = query.month.split('-');
    const year = Number(yearStr);
    const monthNum = Number(monthStr);
    const monthStart = parseDateInputAsISTDay(`${year}-${String(monthNum).padStart(2, '0')}-01`);
    const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    const monthEnd = parseDateInputAsISTDay(
      `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    );
    filter.startDate = { $gte: monthStart, $lte: monthEnd };
  } else if (query.year) {
    const yearStart = parseDateInputAsISTDay(`${query.year}-01-01`);
    const yearEnd = parseDateInputAsISTDay(`${query.year}-12-31`);
    filter.startDate = { $gte: yearStart, $lte: yearEnd };
  }

  const skip = (query.page - 1) * query.limit;
  const resolvedStatus = filter.status ?? query.status;
  const sort =
    resolvedStatus === 'approved' || resolvedStatus === 'rejected'
      ? { decidedAt: -1, createdAt: -1 }
      : { createdAt: -1 };
  const [requests, total] = await Promise.all([
    LeaveRequest.find(filter)
      .populate(LEAVE_REQUEST_POPULATE)
      .sort(sort)
      .skip(skip)
      .limit(query.limit),
    LeaveRequest.countDocuments(filter),
  ]);

  return {
    requests: requests.map((item) => item.toSafeJSON()),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

export async function getTeamCalendar(actor, permissions, query) {
  const canViewAllLeave =
    hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)
    || hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_ALL);
  const canViewTeamLeave =
    canViewAllLeave || hasPermission(permissions, PERMISSIONS.LEAVE_READ_TEAM);

  if (!canViewTeamLeave) {
    throwError('You do not have permission to view team calendar.', 403);
  }

  const month = query.month ?? `${getISTYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  const start = parseDateInputAsISTDay(`${year}-${String(monthNum).padStart(2, '0')}-01`);
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const end = parseDateInputAsISTDay(`${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);

  const userFilter = { isActive: true };
  if (query.departmentId) {
    userFilter.departmentId = query.departmentId;
  } else if (!canViewAllLeave) {
    const scopedIds = await resolveTeamScopedUserIds(
      actor,
      permissions,
      PERMISSIONS.LEAVE_READ_ALL,
      PERMISSIONS.LEAVE_READ_TEAM,
    );
    userFilter._id = { $in: scopedIds ?? [] };
  }

  const users = await User.find(userFilter).select('name email departmentId');
  const userIds = users.map((item) => item._id);

  // Team calendar is planning visibility: only approved leave (pending stays on Approvals).
  const requests = await LeaveRequest.find({
    userId: { $in: userIds },
    status: 'approved',
    startDate: { $lte: end },
    endDate: { $gte: start },
  })
    .populate(LEAVE_REQUEST_POPULATE)
    .sort({ startDate: 1 });

  const leaveTypeIds = [
    ...new Set(
      requests
        .map((item) => {
          const leaveTypeRef = item.leaveTypeId;
          if (!leaveTypeRef) return null;
          if (typeof leaveTypeRef === 'object' && leaveTypeRef._id) {
            return leaveTypeRef._id.toString();
          }
          return leaveTypeRef.toString?.() ?? null;
        })
        .filter((id) => id && mongoose.isValidObjectId(id)),
    ),
  ];
  const leaveTypesById = new Map();
  if (leaveTypeIds.length > 0) {
    const leaveTypes = await LeaveType.find({ _id: { $in: leaveTypeIds } }).select('code name');
    for (const leaveType of leaveTypes) {
      leaveTypesById.set(leaveType._id.toString(), leaveType);
    }
  }

  const entries = requests.map((item) => {
    const json = item.toSafeJSON();
    if (!json.leaveTypeCode && json.leaveTypeId) {
      const leaveType = leaveTypesById.get(String(json.leaveTypeId));
      if (leaveType) {
        json.leaveTypeCode = leaveType.code;
        json.leaveTypeName = json.leaveTypeName ?? leaveType.name;
      }
    }
    return json;
  });

  return {
    month,
    entries,
    users: users.map((user) => ({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      departmentId: user.departmentId?.toString() ?? null,
    })),
  };
}

export async function previewLeaveDays(startDateInput, endDateInput, halfDay = null) {
  const startDate = parseDateInputAsISTDay(startDateInput);
  const endDate = parseDateInputAsISTDay(endDateInput);
  if (!startDate || !endDate || endDate < startDate) {
    throwError('Invalid date range.');
  }

  const year = getISTYear(startDate);
  const holidayDates = await getHolidayDateSet(year);
  const sandwichLeaveEnabled = await isSandwichLeaveEnabled();
  const result = computeLeaveDaysIST(startDate, endDate, holidayDates, {
    halfDay,
    sandwichLeaveEnabled,
  });

  return {
    days: result.days,
    workingDays: result.workingDays,
    holidaysExcluded: !sandwichLeaveEnabled,
    sandwichApplied: Boolean(result.sandwichApplied),
    halfDay: halfDay ?? null,
  };
}
