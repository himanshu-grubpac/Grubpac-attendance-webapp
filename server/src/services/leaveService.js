import mongoose from 'mongoose';
import crypto from 'crypto';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import {
  getISTDateInputValue,
  getISTYear,
  computeLeaveDaysIST,
  parseDateInputAsISTDay,
  endOfDayIST,
  startOfDayIST,
} from '../utils/istDate.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeaveRequest, LEAVE_REQUEST_POPULATE } from '../models/LeaveRequest.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
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
  reclaimApprovedDays,
  releaseApprovedDays,
  releasePendingDays,
  reservePendingDays,
  resolveLeaveYear,
  resolvePolicyForLeaveType,
  reverseApproval,
  validateCombinedAccumulation,
} from './leaveBalanceService.js';
import { auditLog } from '../utils/auditLog.js';
import {
  resolveLeaveApprovalUserIds,
  resolveTeamScopedUserIds,
} from './teamScopeService.js';
import { validateLeaveApplyDeadline } from './wfhPolicyService.js';
import { WFH_LEAVE_TYPE_CODE } from '../../../shared/utils/wfhPolicy.js';
import {
  sendEmail,
  renderLeaveManagerEmail,
  renderLeaveApplicantEmail,
  renderLeaveCancelledEmail,
  renderLeaveCancelledForApproverEmail,
} from './emailService.js';
import { sendSms } from './smsService.js';
// WhatsApp disabled for now (whatsappService is a no-op stub — no provider
// wired). Re-enable the import + call sites below when product enables it.
// import { sendWhatsAppText } from './whatsappService.js';
import { env } from '../config/env.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

// Manager notification (in-app + email + SMS) is deferred: when a request is submitted it is
// scheduled to notify the manager after LEAVE_SUBMIT_UNDO_WINDOW_MS. If the employee "undoes" the
// submission within that window, the scheduled send is cancelled and the request is withdrawn — so the
// manager is only notified when the employee does NOT undo. See dispatchSubmitNotifications /
// undoSubmittedLeaveRequest.
const LEAVE_SUBMIT_UNDO_WINDOW_MS = Number(
  process.env.LEAVE_SUBMIT_UNDO_WINDOW_MS ?? 10000,
);

const pendingSubmitTimers = new Map();

function scheduleSubmitNotification(requestId) {
  if (process.env.NODE_ENV === 'test') return;
  if (pendingSubmitTimers.has(requestId)) return;
  const timer = setTimeout(() => {
    pendingSubmitTimers.delete(requestId);
    dispatchSubmitNotifications(requestId).catch((err) =>
      console.error('[leave] deferred submit notification failed', requestId, err?.message),
    );
  }, LEAVE_SUBMIT_UNDO_WINDOW_MS);
  if (timer.unref) timer.unref();
  pendingSubmitTimers.set(requestId, timer);
}

export async function recoverPendingSubmitNotifications() {
  const stale = await LeaveRequest.find({
    status: 'pending',
    notificationsSent: false,
    submitNotificationsSent: { $ne: true },
  }).select('_id createdAt');

  let recovered = 0;
  for (const req of stale) {
    const age = Date.now() - new Date(req.createdAt).getTime();
    if (age >= LEAVE_SUBMIT_UNDO_WINDOW_MS) {
      pendingSubmitTimers.delete(req._id.toString());
      await dispatchSubmitNotifications(req._id).catch((err) =>
        console.error('[leave] recovered submit notification failed', req._id?.toString(), err?.message),
      );
      recovered += 1;
    } else {
      scheduleSubmitNotification(req._id.toString());
    }
  }
  return { recovered };
}

async function loadManagerNotifyContext(requestId) {
  const request = await LeaveRequest.findById(requestId).populate(LEAVE_REQUEST_POPULATE);
  if (!request) return null;
  const user = request.userId;
  const managerIds = collectManagerIds(user);
  const managers = managerIds.length
    ? await User.find({ _id: { $in: managerIds }, isActive: true }).select('name email mobile whatsappOptIn')
    : [];
  const leaveType = request.leaveTypeId ? await LeaveType.findById(request.leaveTypeId) : null;
  return { request, managers, leaveType };
}

export async function sendLeaveManagerEmail(requestId) {
  try {
    const ctx = await loadManagerNotifyContext(requestId);
    if (!ctx || ctx.managers.length === 0) return;
    const withActions = ctx.request.status === 'pending';
    await notifyManagerChannels(ctx.managers, ctx.request, ctx.leaveType, { withActions });
  } catch (err) {
    console.error('[leave] notify email failed', requestId, err?.message);
  }
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

export function formatLeaveDateText(request) {
  const start = getISTDateInputValue(request.startDate);
  const end = getISTDateInputValue(request.endDate);
  return start === end ? start : `${start} to ${end}`;
}

function formatLeaveTimeText(request) {
  if (request.halfDay === 'am') return 'First half (AM)';
  if (request.halfDay === 'pm') return 'Second half (PM)';
  return 'Full day';
}

function collectManagerIds(user) {
  const ids = [];
  for (const field of ['reportingManagerId', 'delegateApproverId']) {
    const value = user?.[field];
    if (value) ids.push(value._id ?? value);
  }
  return ids;
}

async function notifyManagerChannels(managers, request, leaveType, { withActions }) {
  const requesterName = request.userId?.name ?? 'An employee';
  const leaveTypeName = leaveType?.name || leaveType?.code || 'leave';
  const dateText = formatLeaveDateText(request);
  const timeText = formatLeaveTimeText(request);
  const decisionLoginBaseUrl = `${env.apiOrigin}/api/leave/decision-login`;

  await Promise.allSettled(
    managers.map(async (m) => {
      let actionUrl = `${env.clientOrigin}/admin/leave/approvals?request=${request._id}`;
      if (withActions) {
        const token = await issueLeaveDecisionToken(request._id, m._id, 'decide');
        actionUrl = `${decisionLoginBaseUrl}?request=${request._id}&action=decide&token=${token}`;
      }
      const { subject, html, text } = renderLeaveManagerEmail({
        requesterName,
        leaveTypeName,
        reason: request.reason,
        dateText,
        timeText,
        withActions,
        actionUrl,
      });
      const smsText = withActions
        ? `${requesterName} applied for ${leaveTypeName} (${dateText}). Take action: ${actionUrl}`
        : `${requesterName} applied for ${leaveTypeName} (${dateText}) (auto-approved).`;
      if (m.email) await sendEmail({ to: m.email, subject, html, text, tag: 'leave-manager' });
      if (m.mobile) await sendSms({ to: m.mobile, message: smsText });
      // WhatsApp disabled — see import note above.
      // if (m.whatsappOptIn && m.mobile) await sendWhatsAppText({ to: m.mobile, message: smsText });
    }),
  );
}

const LEAVE_DECISION_TOKEN_TTL_MS = Number(process.env.LEAVE_DECISION_TOKEN_TTL_MS ?? 48 * 60 * 60 * 1000);

export function hashDecisionToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function issueLeaveDecisionToken(requestId, managerId, action) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashDecisionToken(raw);
  // The action link must stay valid until the applied leave date passes (IST).
  // Use end-of-day of the leave's last day; if that is already in the past
  // (backdated leave or same-day edge), cap to the minimum TTL so the link
  // is still usable instead of dead on arrival.
  const request = await LeaveRequest.findById(requestId).select('endDate');
  let expiresAt = request?.endDate ? endOfDayIST(request.endDate) : null;
  const minExpiresAt = new Date(Date.now() + LEAVE_DECISION_TOKEN_TTL_MS);
  if (!expiresAt || expiresAt < minExpiresAt) expiresAt = minExpiresAt;
  await LeaveRequest.updateOne(
    { _id: requestId },
    { $push: { decisionTokens: { tokenHash, action, managerId, expiresAt, used: false, usedAt: null } } },
  );
  return raw;
}

export async function consumeLeaveDecisionToken(requestId, action, rawToken) {
  const request = await LeaveRequest.findById(requestId).select('decisionTokens');
  if (!request || !request.decisionTokens || request.decisionTokens.length === 0) return null;
  const candidate = hashDecisionToken(rawToken);
  const now = new Date();
  let matched = null;
  for (const t of request.decisionTokens) {
    if (t.action !== action || t.used || t.expiresAt <= now) continue;
    const a = Buffer.from(t.tokenHash, 'hex');
    const b = Buffer.from(candidate, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      matched = t;
      break;
    }
  }
  if (!matched) return null;
  const claimed = await LeaveRequest.findOneAndUpdate(
    {
      _id: requestId,
      decisionTokens: {
        $elemMatch: {
          _id: matched._id,
          action,
          tokenHash: candidate,
          used: false,
          expiresAt: { $gt: now },
        },
      },
    },
    { $set: { 'decisionTokens.$.used': true, 'decisionTokens.$.usedAt': now } },
  );
  return claimed ? matched.managerId : null;
}

export async function peekLeaveDecisionToken(requestId, action, rawToken) {
  const request = await LeaveRequest.findById(requestId).select('decisionTokens status');
  if (!request) return null;
  const candidate = hashDecisionToken(rawToken);
  for (const t of request.decisionTokens || []) {
    if (t.action !== action || t.used || t.expiresAt <= new Date()) continue;
    const a = Buffer.from(t.tokenHash, 'hex');
    const b = Buffer.from(candidate, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { managerId: t.managerId, status: request.status };
    }
  }
  return null;
}


// Window during which an approve/reject decision can be undone. Applicant
// email/SMS is deferred until this window passes, so a reverted decision never
// mails the applicant. Shared with the client popup via LEAVE_DECISION_UNDO_MS.
const LEAVE_DECISION_UNDO_MS = env.leaveDecisionUndoMs;

export async function processLeaveDecision(request, actor, decision, decisionComment = null, { adminException = false } = {}) {
  if (decision !== 'approve' && decision !== 'approved' && decision !== 'reject' && decision !== 'rejected') {
    throwError('Invalid leave decision.', 400);
  }
  const isApproved = decision === 'approve' || decision === 'approved';
  const pendingDecision = isApproved ? 'approved' : 'rejected';
  const userId = request.userId?._id ?? request.userId;

  // Nothing changes until the undo window expires. The status, balance, and
  // WFH markers all stay frozen while the admin can still undo.
  request.pendingDecision = pendingDecision;
  request.approverId = actor._id;
  request.decidedAt = new Date();
  request.decisionComment = decisionComment;
  if (adminException) request.adminException = true;
  request.notifyAfter = new Date(Date.now() + LEAVE_DECISION_UNDO_MS);
  request.notificationsSent = false;
  request.submitNotificationsSent = true;
  request.decisionTokens = [];
  await request.save();

  auditLog(isApproved ? 'leave_request_approved' : 'leave_request_rejected', {
    adminId: actor._id.toString(),
    userId: userId.toString(),
    requestId: request._id.toString(),
    comment: decisionComment,
  });

  return request.toSafeJSON();
}
async function notifyApplicantDecision({ applicant, request, leaveType, status, decisionComment, sendChannels = true }) {
  const userId = applicant._id?.toString?.() ?? applicant._id ?? request.userId;
  let applicantDoc = applicant;
  if (!applicantDoc?.email || !applicantDoc?.mobile) {
    const fetched = await User.findById(userId).select('name email mobile whatsappOptIn');
    if (fetched) applicantDoc = fetched;
  }
  const leaveTypeName =
    leaveType?.name || leaveType?.code || request.leaveTypeId?.name || request.leaveTypeId?.code || 'leave';
  const dateText = formatLeaveDateText(request);
  const timeText = formatLeaveTimeText(request);
  const remarks = decisionComment || '';
  await createNotification({
    userId,
    type: status === 'approved' ? 'leave.approved' : 'leave.rejected',
    title: status === 'approved' ? 'Leave approved' : 'Leave rejected',
    body: `Your ${leaveTypeName} leave request was ${status}.${remarks ? ` Remarks: ${remarks}` : ''}`,
    link: '/employee/leave/requests',
    metadata: { requestId: request._id.toString() },
  });
  if (sendChannels) {
    const { subject, html, text } = renderLeaveApplicantEmail({ leaveTypeName, status, remarks, dateText, timeText });
    const smsText = `Your ${leaveTypeName} leave (${dateText}) was ${status}.${remarks ? ' Remarks: ' + remarks : ''}`;
    if (applicantDoc.email) await sendEmail({ to: applicantDoc.email, subject, html, text, tag: 'leave-status' });
    if (applicantDoc.mobile) await sendSms({ to: applicantDoc.mobile, message: smsText });
    // WhatsApp disabled — see import note above.
    // if (applicantDoc.whatsappOptIn && applicantDoc.mobile) await sendWhatsAppText({ to: applicantDoc.mobile, message: smsText });
  }
}

export async function getHolidayMapForYear(year) {
  const start = parseDateInputAsISTDay(`${year}-01-01`);
  const end = parseDateInputAsISTDay(`${year}-12-31`);
  const holidays = await Holiday.find({
    isActive: true,
    date: { $gte: start, $lte: end },
  }).select('date name type');
  const map = new Map();
  for (const item of holidays) {
    const dayKey = getISTDateInputValue(item.date);
    map.set(dayKey, {
      name: item.name,
      type: item.type ?? 'public',
    });
  }
  return map;
}

export async function getHolidayDateSet(year) {
  const map = await getHolidayMapForYear(year);
  return new Set(map.keys());
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

function leaveTypeCodeFor(leaveType) {
  return String(leaveType?.code ?? leaveType?.name ?? '').trim().toUpperCase();
}

function isWfhLeaveType(leaveType) {
  return leaveTypeCodeFor(leaveType) === WFH_LEAVE_TYPE_CODE;
}

function wfhAttendanceRange(request) {
  return {
    $gte: startOfDayIST(request.startDate),
    $lte: endOfDayIST(request.endDate),
  };
}

function buildWfhAttendanceFilter(
  request,
  { fromStatuses, legacyAnyMode = false, linkedOnly = false } = {},
) {
  const userId = request.userId?._id ?? request.userId;
  const statusFilter = fromStatuses?.length
    ? { leaveStatus: { $in: fromStatuses } }
    : {};
  const base = {
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: wfhAttendanceRange(request),
    ...statusFilter,
  };

  const linked = { ...base, leaveRequestId: request._id };
  if (linkedOnly) return linked;

  return {
    $or: [
      linked,
      {
        ...base,
        leaveRequestId: { $in: [null] },
        ...(legacyAnyMode ? {} : { attendanceMode: 'wfh' }),
      },
    ],
  };
}

async function updateWfhAttendanceForRequest(
  request,
  { fromStatuses, toStatus, legacyAnyMode = false, leaveType, session } = {},
) {
  if (!isWfhLeaveType(leaveType ?? request.leaveTypeId)) return;

  const update = toStatus
    ? { $set: { leaveStatus: toStatus, leaveRequestId: request._id } }
    : { $unset: { leaveStatus: 1, leaveRequestId: 1 } };
  const options = session ? { session } : undefined;
  const linkedIdentityFilter = buildWfhAttendanceFilter(request, { linkedOnly: true });
  const linkedQuery = AttendanceRecord.findOne(linkedIdentityFilter).select('_id');
  if (session) linkedQuery.session(session);
  const linkedRecord = await linkedQuery.lean();
  const filter = linkedRecord
    ? buildWfhAttendanceFilter(request, { fromStatuses, linkedOnly: true })
    : buildWfhAttendanceFilter(request, { fromStatuses, legacyAnyMode });
  return AttendanceRecord.updateMany(
    filter,
    update,
    options,
  );
}

async function clearWfhAttendanceMarkers(request, { legacyStatuses = ['pending'], session } = {}) {
  if (!isWfhLeaveType(request.leaveType ?? request.leaveTypeId)) return;

  const userId = request.userId?._id ?? request.userId;
  const options = session ? { session } : undefined;
  const linkedFilter = {
    userId,
    type: 'check_in',
    status: 'allowed',
    leaveRequestId: request._id,
  };
  const linkedQuery = AttendanceRecord.findOne(linkedFilter).select('_id');
  if (session) linkedQuery.session(session);
  const linkedRecord = await linkedQuery.lean();
  const filter = linkedRecord
    ? linkedFilter
    : {
        userId,
        type: 'check_in',
        status: 'allowed',
        leaveRequestId: { $in: [null] },
        leaveStatus: { $in: legacyStatuses },
        timestamp: wfhAttendanceRange(request),
      };
  await AttendanceRecord.updateMany(
    filter,
    { $unset: { leaveStatus: 1, leaveRequestId: 1 } },
    options,
  );
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
  excludeRequestId = null,
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

  if (!adminException) {
    const deadlineError = validateLeaveApplyDeadline(
      startDateInput,
      endDateInput,
      leaveType.code,
    );
    if (deadlineError) {
      throwError(deadlineError);
    }
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

  // Overdrawn leave is allowed: available may be 0 or negative; used/pending can exceed entitled.
  const available = getAvailableBalance(balance);

  // Combined CL+EL accumulation only applies when this apply stays within remaining stock.
  if (available >= days) {
    await validateCombinedAccumulation(userId, year, policyMap, days, leaveTypeId);
  }

  await validateSelfOverlap(userId, startDate, endDate, excludeRequestId);
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

async function validateSelfOverlap(userId, startDate, endDate, excludeRequestId = null) {
  const overlap = await LeaveRequest.findOne({
    userId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
    ...(excludeRequestId ? { _id: { $ne: excludeRequestId } } : {}),
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
    let leaveTypeForNotify = null;
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

      leaveTypeForNotify = validated.leaveType;
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

      if (!autoApprove && isWfhLeaveType(validated.leaveType)) {
        // A request can be submitted after the employee has already checked in.
        // Link that check-in now so later decisions update the exact record.
        await updateWfhAttendanceForRequest(request, {
          toStatus: 'pending',
          legacyAnyMode: true,
          leaveType: validated.leaveType,
          session,
        });
      }

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
      await notifyApplicantDecision({
        applicant: user,
        request: createdRequest,
        leaveType: leaveTypeForNotify,
        status: 'approved',
        decisionComment: null,
      });
      auditLog('leave_request_auto_approved', {
        userId: userId.toString(),
        requestId: createdRequest._id.toString(),
        leaveTypeId: payload.leaveTypeId,
        days: createdRequest.days,
        startDate: payload.startDate,
        endDate: payload.endDate,
      });
    } else {
      scheduleSubmitNotification(createdRequest._id.toString());
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

async function notifyApproversOnSubmit(requester, request, leaveType = null) {
  const managerId =
    requester.reportingManagerId?._id?.toString() ??
    requester.reportingManagerId?.toString?.() ??
    null;

  const link = managerId ? '/admin/leave/approvals' : '/admin/leave/approvals';
  const typeLabel = leaveType?.name || leaveType?.code || 'leave';
  const isWfh = String(leaveType?.code ?? '').toUpperCase() === 'WFH';
  const title = isWfh ? 'New WFH request' : 'New leave request';
  const body = `${requester.name} requested ${typeLabel} for ${request.days} day(s) (${getISTDateInputValue(request.startDate)} – ${getISTDateInputValue(request.endDate)}).`;

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
        title: isWfh ? 'WFH request (no manager)' : 'Leave request (no manager)',
        body: `${requester.name} submitted ${typeLabel} without a reporting manager assigned.`,
        link,
        metadata: { requestId: request._id.toString() },
      }),
    ),
  );
}

export async function dispatchSubmitNotifications(requestId) {
  const request = await LeaveRequest.findById(requestId).populate(LEAVE_REQUEST_POPULATE);
  if (!request) return;
  if (
    request.status !== 'pending'
    || request.notificationsSent
    || request.submitNotificationsSent
  ) return;
  await notifyApproversOnSubmit(request.userId, request, request.leaveTypeId);
  await sendLeaveManagerEmail(requestId);
  request.notificationsSent = true;
  request.submitNotificationsSent = true;
  await request.save();
}

export async function undoSubmittedLeaveRequest(requestId, actor) {
  const request = await loadLeaveRequest(requestId);
  const requesterId = request.userId?._id?.toString() ?? request.userId?.toString();
  if (requesterId !== actor._id.toString()) {
    throwError('You can only undo your own leave requests.', 403);
  }
  if (request.status !== 'pending') {
    throwError('This request can no longer be undone.', 409);
  }
  if (request.notificationsSent) {
    throwError('This request was already sent to your manager.', 409);
  }

  const result = await cancelLeaveRequest(requestId, actor);

  const existing = pendingSubmitTimers.get(requestId);
  if (existing) {
    clearTimeout(existing);
    pendingSubmitTimers.delete(requestId);
  }

  return result;
}

export async function cancelLeaveRequest(requestId, actor) {
  const request = await loadLeaveRequest(requestId);
  if (request.userId?._id?.toString() !== actor._id.toString() && request.userId?.toString() !== actor._id.toString()) {
    throwError('You can only cancel your own leave requests.', 403);
  }
  if (request.status !== 'pending' && request.status !== 'approved') {
    throwError('Only pending or approved leave requests can be cancelled.');
  }
  if (request.pendingDecision) {
    throwError('A decision is already pending. Undo it first before cancelling.');
  }
  // Once the applied leave date has passed, the leave can no longer be cancelled.
  if (request.endDate && new Date(endOfDayIST(request.endDate)).getTime() < Date.now()) {
    throwError('This leave request can no longer be cancelled because the leave dates have passed.');
  }

  const wasApproved = request.status === 'approved' || request.pendingDecision === 'approved';
  await applyLeaveCancellation(request, actor, { undoable: wasApproved });

  return request.toSafeJSON();
}

/** Approver (or delegate) cancels an approved leave on behalf of the employee. */
export async function cancelApprovedLeaveByApprover(requestId, actor, permissions, { decisionComment = null } = {}) {
  const request = await loadLeaveRequest(requestId);
  const isApproved = request.status === 'approved' || request.pendingDecision === 'approved';
  if (!isApproved) {
    throwError('Only approved leave requests can be cancelled.', 400);
  }
  if (request.endDate && new Date(endOfDayIST(request.endDate)).getTime() < Date.now()) {
    throwError('This leave request can no longer be cancelled because the leave dates have passed.');
  }
  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to cancel this leave request.', 403);
  }

  await applyLeaveCancellation(request, actor, { undoable: true, approverId: actor._id, decisionComment });
  return request.toSafeJSON();
}

/**
 * Shared cancellation: frees the balance, clears WFH attendance markers, and
 * marks the request cancelled. Approved cancellations are undoable for the
 * deferral window — the applicant/approver email is only sent after the window
 * expires (via the decision-notify job).
 */
async function applyLeaveCancellation(request, actor, { undoable = false, approverId: cancelActorId = null, decisionComment = null } = {}) {
  const wasApproved = request.status === 'approved' || request.pendingDecision === 'approved';
  const userId = request.userId?._id ?? request.userId;

  if (undoable) {
    // Approved-leave cancellation: nothing changes until the undo window
    // expires. Status, balance and WFH markers all stay frozen. Preserve the
    // original approval metadata (approverId/decidedAt) so an undo restores it.
    if (request.pendingDecision) {
      throwError('Another decision is already pending. Undo it first before cancelling.');
    }
    request.pendingDecision = 'cancelled';
    request.notifyAfter = new Date(Date.now() + LEAVE_DECISION_UNDO_MS);
    request.notificationsSent = false;
    request.submitNotificationsSent = true;
    request.decisionTokens = [];
    if (decisionComment) request.decisionComment = decisionComment;
    await request.save();
  } else {
    // Pending-leave cancellation: immediate, no undo needed.
    const year = getISTYear(request.startDate);
    const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
    const originalApproverId = request.approverId?._id?.toString?.() ?? request.approverId?.toString?.() ?? null;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await releasePendingDays(userId, leaveTypeId, request.days, year, session);
        await updateWfhAttendanceForRequest(request, {
          fromStatuses: ['pending', 'rejected'],
          legacyAnyMode: true,
          session,
        });
        request.status = 'cancelled';
        request.decidedAt = new Date();
        request.approverId = null;
        request.decisionTokens = [];
        request.notifyAfter = null;
        request.notificationsSent = true;
        request.submitNotificationsSent = true;
        await request.save({ session });
      });
    } finally {
      session.endSession();
    }

    await notifyLeaveCancelled(request, false, originalApproverId, { sendChannels: true });
  }

  auditLog('leave_request_cancelled', {
    userId: actor._id.toString(),
    requestId: request._id.toString(),
    wasApproved,
    undoable,
  });
}

/** Undoes an approved-leave cancellation, restoring the request to approved. */
export async function undoLeaveCancellation(requestId, actor, permissions) {
  const request = await loadLeaveRequest(requestId);
  if (request.pendingDecision !== 'cancelled') {
    throwError('No pending cancellation to undo.', 400);
  }

  if (request.notifyAfter && Date.now() > new Date(request.notifyAfter).getTime()) {
    throwError('The undo window has expired. The cancellation is now final.', 410);
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  const isOwner = request.userId?._id?.toString() === actor._id.toString()
    || request.userId?.toString?.() === actor._id.toString();
  if (!isOwner && !canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to undo this cancellation.', 403);
  }

  const userId = request.userId?._id ?? request.userId;

  // Nothing changed during the undo window — status, balance and WFH markers
  // are all untouched. Just clear the pending decision fields. Keep the
  // original approval metadata (approverId/decidedAt) intact.
  request.pendingDecision = null;
  request.notifyAfter = null;
  request.notificationsSent = false;
  request.submitNotificationsSent = true;
  request.decisionTokens = [];
  await request.save();

  await createNotification({
    userId,
    type: 'leave.cancel_undone',
    title: 'Leave cancellation undone',
    body: 'Your approved leave was restored.',
    link: '/employee/leave/requests',
    metadata: { requestId: request._id.toString() },
  });

  auditLog('leave_request_cancellation_undone', {
    adminId: actor._id.toString(),
    userId: userId.toString(),
    requestId: request._id.toString(),
  });

  return request.toSafeJSON();
}

/**
 * Notifies the applicant (and original approver) that an approved leave was
 * cancelled. The in-app notification is always sent immediately; email/SMS can
 * be deferred (sendChannels=false) until the cancellation's undo window expires.
 */
async function notifyLeaveCancelled(request, wasApproved, approverId, { sendChannels = true } = {}) {
  const userId = request.userId?._id?.toString?.() ?? request.userId?.toString?.();
  const applicant = await User.findById(userId).select('name email mobile whatsappOptIn');
  const leaveTypeName =
    request.leaveTypeId?.name || request.leaveTypeId?.code || 'leave';
  const dateText = formatLeaveDateText(request);
  const timeText = formatLeaveTimeText(request);

  try {
    if (wasApproved) {
      await createNotification({
        userId,
        type: 'leave.cancelled',
        title: 'Leave cancelled',
        body: `Your ${leaveTypeName} leave (${dateText}) was cancelled. The leave days have been returned to your balance.`,
        link: '/employee/leave/requests',
        metadata: { requestId: request._id.toString() },
      });
    }

    if (!sendChannels) return;

    if (applicant?.email) {
      const { subject, html, text } = renderLeaveCancelledEmail({
        leaveTypeName,
        dateText,
        timeText,
        wasApproved,
      });
      await sendEmail({ to: applicant.email, subject, html, text, tag: 'leave-cancelled' });
    }
    if (applicant?.mobile) {
      const smsText = `Your ${leaveTypeName} leave (${dateText}) was cancelled.`;
      await sendSms({ to: applicant.mobile, message: smsText });
    }
    // WhatsApp disabled — see import note above.
    // if (applicant?.whatsappOptIn && applicant?.mobile) {
    //   await sendWhatsAppText({ to: applicant.mobile, message: `Your ${leaveTypeName} leave (${dateText}) was cancelled.` });
    // }
  } catch (err) {
    console.error('[leave] cancelled notification failed', request._id?.toString(), err?.message);
  }

  // Notify the original approver that the approved leave was cancelled.
  if (!sendChannels) return;
  if (wasApproved && approverId) {
    try {
      const approver = await User.findById(approverId).select('name email mobile whatsappOptIn');
      if (!approver) return;
      const applicantName = applicant?.name || 'An employee';
      if (approver.email) {
        const { subject, html, text } = renderLeaveCancelledForApproverEmail({
          applicantName,
          leaveTypeName,
          dateText,
          timeText,
        });
        await sendEmail({ to: approver.email, subject, html, text, tag: 'leave-cancelled-approver' });
      }
      await createNotification({
        userId: approverId,
        type: 'leave.cancelled',
        title: 'Leave cancelled by employee',
        body: `${applicantName} cancelled their approved ${leaveTypeName} leave (${dateText}).`,
        link: '/admin/leave/approvals',
        metadata: { requestId: request._id.toString() },
      });
    } catch (err) {
      console.error('[leave] approver cancellation notice failed', request._id?.toString(), err?.message);
    }
  }
}

export async function editLeaveRequest(requestId, actor, payload) {
  const request = await loadLeaveRequest(requestId);
  const requesterId = request.userId?._id?.toString() ?? request.userId?.toString();
  if (requesterId !== actor._id.toString()) {
    throwError('You can only edit your own leave requests.', 403);
  }
  if (request.status !== 'pending') {
    throwError('Only pending leave requests can be edited.');
  }

  const userId = request.userId?._id ?? request.userId;
  const oldLeaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
  const oldYear = getISTYear(request.startDate);
  const oldRequestSnapshot = {
    _id: request._id,
    userId,
    leaveTypeId: request.leaveTypeId,
    startDate: request.startDate,
    endDate: request.endDate,
  };
  const adminException = false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Release the previously reserved pending days before reserving the new ones.
      await releasePendingDays(userId, oldLeaveTypeId, request.days, oldYear, session);

      await clearWfhAttendanceMarkers(oldRequestSnapshot, { session });

      const validated = await validateLeaveRequestInput({
        userId,
        leaveTypeId: payload.leaveTypeId,
        startDateInput: payload.startDate,
        endDateInput: payload.endDate,
        halfDay: payload.halfDay ?? null,
        documentUrl: payload.documentUrl,
        adminException,
        excludeRequestId: request._id,
      });

      await reservePendingDays(userId, payload.leaveTypeId, validated.days, validated.year, session);

      request.leaveTypeId = payload.leaveTypeId;
      request.startDate = validated.startDate;
      request.endDate = validated.endDate;
      request.days = validated.days;
      request.halfDay = payload.halfDay ?? null;
      request.reason = payload.reason;
      request.documentUrl = payload.documentUrl ?? null;
      request.adminException = adminException;
      request.status = 'pending';
      request.notificationsSent = false;
      request.submitNotificationsSent = false;
      await request.save({ session });

      if (isWfhLeaveType(validated.leaveType)) {
        await updateWfhAttendanceForRequest(request, {
          toStatus: 'pending',
          legacyAnyMode: true,
          leaveType: validated.leaveType,
          session,
        });
      }
    });
  } finally {
    session.endSession();
  }

  auditLog('leave_request_edited', {
    userId: actor._id.toString(),
    requestId: request._id.toString(),
  });

  scheduleSubmitNotification(request._id.toString());

  return (await LeaveRequest.findById(request._id).populate(LEAVE_REQUEST_POPULATE)).toSafeJSON();
}

export async function decideLeaveRequestByToken(requestId, action, rawToken, decisionComment = null) {
  const comment = typeof decisionComment === 'string' ? decisionComment.trim() : null;
  if (!comment) {
    const err = new Error('A remark is required for this action.');
    err.statusCode = 400;
    throw err;
  }
  // Email links carry generic 'decide' tokens (usable for either outcome);
  // per-action tokens are accepted too. consume() only marks on match, so the
  // fallback attempt is safe.
  const managerId = (await consumeLeaveDecisionToken(requestId, action, rawToken))
    ?? (action === 'decide'
      ? null
      : await consumeLeaveDecisionToken(requestId, 'decide', rawToken));
  if (!managerId) {
    const err = new Error('This action link is invalid, has already been used, or has expired.');
    err.statusCode = 410;
    throw err;
  }
  const request = await loadLeaveRequest(requestId);
  if (request.status !== 'pending') {
    const err = new Error('This leave request has already been decided.');
    err.statusCode = 409;
    throw err;
  }
  const manager = await User.findById(managerId).select('name email role roleId tokenVersion isActive');
  if (!manager || !manager.isActive) {
    const err = new Error('Your account is no longer active.');
    err.statusCode = 403;
    throw err;
  }
  await processLeaveDecision(request, manager, action, comment);
  return { request, manager };
}

export async function autoLoginByDecisionToken(requestId, action, rawToken) {
  // Peek, don't consume: the link stays usable for login until the request is
  // decided or the token expires. Single-use is enforced at decision time
  // (consume + processLeaveDecision clears decisionTokens).
  const peeked = await peekLeaveDecisionToken(requestId, action, rawToken);
  const managerId = peeked?.managerId ?? null;
  if (!managerId) {
    const err = new Error('This link is invalid, has already been used, or has expired.');
    err.statusCode = 410;
    throw err;
  }
  const request = await loadLeaveRequest(requestId);
  if (request.status !== 'pending') {
    const err = new Error('This leave request has already been decided.');
    err.statusCode = 409;
    throw err;
  }
  const manager = await User.findById(managerId).select('name email role roleId tokenVersion isActive');
  if (!manager || !manager.isActive) {
    const err = new Error('Your account is no longer active.');
    err.statusCode = 403;
    throw err;
  }
  return { manager, requestId };
}
export async function decideLeaveRequest(requestId, actor, permissions, decision, payload = {}) {
  const request = await loadLeaveRequest(requestId);
  if (request.status !== 'pending') {
    throwError('Only pending requests can be approved or rejected.');
  }

  const isReject = decision === 'reject' || decision === 'rejected';
  const comment = (payload.comment ?? '').trim() || null;
  if (!comment) {
    throwError('A remark is required for this action.');
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to approve this leave request.', 403);
  }

  return processLeaveDecision(request, actor, decision, comment, {
    adminException: !!payload.adminException,
  });
}

export async function undoLeaveDecision(requestId, actor, permissions) {
  const request = await loadLeaveRequest(requestId);
  if (!request.pendingDecision) {
    throwError('No pending decision to undo.', 400);
  }

  if (request.decidedAt) {
    const elapsed = Date.now() - new Date(request.decidedAt).getTime();
    if (elapsed > LEAVE_DECISION_UNDO_MS) {
      throwError('The undo window has expired. The decision is now final.', 410);
    }
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to undo this leave decision.', 403);
  }

  const userId = request.userId?._id ?? request.userId;

  // Nothing changed during the undo window — status, balance and WFH markers
  // are all untouched. Just clear the pending decision fields.
  request.pendingDecision = null;
  request.approverId = null;
  request.decidedAt = null;
  request.decisionComment = null;
  request.adminException = false;
  request.notifyAfter = null;
  request.notificationsSent = false;
  request.submitNotificationsSent = true;
  request.decisionTokens = [];
  await request.save();

  await createNotification({
    userId,
    type: 'leave.decision_undone',
    title: 'Leave decision undone',
    body: 'Your leave request was moved back to pending for review.',
    link: '/employee/leave/requests',
    metadata: { requestId: request._id.toString() },
  });

  auditLog('leave_request_decision_undone', {
    adminId: actor._id.toString(),
    userId: userId.toString(),
    requestId: request._id.toString(),
  });

  return request.toSafeJSON();
}

async function expirePendingWfhAttendance(now) {
  const wfhType = await LeaveType.findOne({ code: WFH_LEAVE_TYPE_CODE }).select('_id code');
  if (!wfhType) return 0;

  const staleRequests = await LeaveRequest.find({
    userId: { $exists: true },
    leaveTypeId: wfhType._id,
    status: 'pending',
    endDate: { $lt: startOfDayIST(now) },
  }).select('_id userId startDate endDate leaveTypeId');

  let expired = 0;
  for (const request of staleRequests) {
    const result = await updateWfhAttendanceForRequest(request, {
      fromStatuses: ['pending'],
      toStatus: 'rejected',
      legacyAnyMode: true,
      leaveType: wfhType,
    });
    expired += result.modifiedCount ?? 0;
  }
  return expired;
}

export async function runLeaveDecisionNotifyJob(now = new Date()) {
  const expiredPendingWfh = await expirePendingWfhAttendance(now);
  const due = await LeaveRequest.find({
    pendingDecision: { $ne: null },
    notifyAfter: { $ne: null, $lte: now },
    notificationsSent: false,
  }).populate(LEAVE_REQUEST_POPULATE);

  let processed = 0;
  for (const request of due) {
    const decision = request.pendingDecision;
    const userId = request.userId?._id ?? request.userId;
    const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
    const year = getISTYear(request.startDate);

    if (decision === 'approved') {
      // Finalise approval: consume the reserved pending days, mark WFH approved.
      await approvePendingDays(userId, leaveTypeId, request.days, year);
      await updateWfhAttendanceForRequest(request, {
        fromStatuses: ['pending', 'rejected'],
        toStatus: 'approved',
        legacyAnyMode: true,
      });
      request.status = 'approved';
    } else if (decision === 'rejected') {
      // Finalise rejection: release the reserved pending days, mark WFH rejected.
      await releasePendingDays(userId, leaveTypeId, request.days, year);
      await updateWfhAttendanceForRequest(request, {
        fromStatuses: ['pending'],
        toStatus: 'rejected',
        legacyAnyMode: true,
      });
      request.status = 'rejected';
    } else if (decision === 'cancelled') {
      // Finalise cancellation: release consumed days, unset WFH markers.
      await releaseApprovedDays(userId, leaveTypeId, request.days, year);
      await updateWfhAttendanceForRequest(request, {
        fromStatuses: ['approved', 'pending'],
        legacyAnyMode: true,
      });
      request.status = 'cancelled';
    }

    // Send the deferred email / SMS / WhatsApp notification.
    if (decision === 'cancelled') {
      const approverId = request.approverId?._id?.toString?.()
        ?? request.approverId?.toString?.()
        ?? null;
      await notifyLeaveCancelled(request, true, approverId, { sendChannels: true });
    } else {
      const requester = await loadRequester(userId);
      await notifyApplicantDecision({
        applicant: requester,
        request,
        leaveType: request.leaveTypeId,
        status: decision === 'approved' ? 'approved' : 'rejected',
        decisionComment: request.decisionComment,
        sendChannels: true,
      });
    }

    request.pendingDecision = null;
    request.notifyAfter = null;
    request.notificationsSent = true;
    await request.save();
    processed += 1;
  }

  return { processed, expiredPendingWfh, runAt: now.toISOString() };
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
  const calendarStart = startOfDayIST(start);
  const calendarEnd = endOfDayIST(end);

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
    startDate: { $lte: calendarEnd },
    endDate: { $gte: calendarStart },
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
