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
import { scheduleLeaveFinalize } from './leaveFinalizeQueue.js';
import {
  isUserInTeamScope,
  resolveLeaveApprovalUserIds,
  resolveTeamScopedUserIds,
} from './teamScopeService.js';
import { validateLeaveApplyDeadline } from './wfhPolicyService.js';
import { WFH_LEAVE_TYPE_CODE } from '../../../shared/utils/wfhPolicy.js';
import {
  sendEmail,
  renderLeaveManagerEmail,
  renderLeaveApplicantEmail,
  renderLeaveApplicantSubmittedEmail,
  renderLeaveCancelledEmail,
  renderLeaveCancelledForApproverEmail,
  renderLeaveCancelledForManagerEmail,
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

// Provisional → undoable → finalized lifecycle.
//
// Every undoable action (submit, edit, approve/reject stage, approved-cancel
// stage) records an explicit undo deadline (`undoExpiresAt`) and a finalize
// time (`notifyAfter = undoExpiresAt + LEAVE_NOTIFICATION_DELAY_MS`). Only the
// background finalizer may send notifications, and only after `notifyAfter`
// has passed for the CURRENT revision (`pendingRevision`). Undo clears the
// pending state and never sends email. See dispatchSubmitNotifications /
// undoSubmittedLeaveRequest / processLeaveDecision / runLeaveDecisionNotifyJob.
const LEAVE_SUBMIT_UNDO_WINDOW_MS = env.leaveSubmitUndoMs;
const LEAVE_NOTIFICATION_DELAY_MS = env.leaveNotificationDelayMs;

/**
 * Computes the two timestamps for a new provisional action.
 * @returns {{ undoExpiresAt: Date, notifyAfter: Date }}
 */
function provisionalTiming(windowMs, fromTime = Date.now()) {
  const undoExpiresAt = new Date(fromTime + windowMs);
  const notifyAfter = new Date(undoExpiresAt.getTime() + LEAVE_NOTIFICATION_DELAY_MS);
  return { undoExpiresAt, notifyAfter };
}

const pendingSubmitTimers = new Map();

/** Single-flight guard so the in-memory timer and the sweeper job never dispatch the same request concurrently. */
const pendingSubmitDispatch = new Set();

function scheduleSubmitNotification(requestId, dueAt = null) {
  if (process.env.NODE_ENV === 'test') return;
  if (pendingSubmitTimers.has(requestId)) return;
  // Fire at notifyAfter (undo window + notification delay): dispatch bails
  // while notifyAfter is in the future, so scheduling at the bare window
  // would always no-op and leave delivery to the sweeper.
  const delayMs = dueAt
    ? Math.max(0, new Date(dueAt).getTime() - Date.now())
    : LEAVE_SUBMIT_UNDO_WINDOW_MS + LEAVE_NOTIFICATION_DELAY_MS;
  const timer = setTimeout(() => {
    pendingSubmitTimers.delete(requestId);
    dispatchSubmitNotifications(requestId).catch((err) =>
      console.error('[leave] deferred submit notification failed', requestId, err?.message),
    );
  }, delayMs);
  if (timer.unref) timer.unref();
  pendingSubmitTimers.set(requestId, timer);
}

export async function recoverPendingSubmitNotifications() {
  const stale = await LeaveRequest.find({
    status: 'pending',
    pendingDecision: null,
    notificationsSent: false,
    submitNotificationsSent: { $ne: true },
  }).select('_id createdAt notifyAfter');

  let recovered = 0;
  for (const req of stale) {
    // New documents carry an explicit finalize time; legacy ones fall back
    // to createdAt + window (pre-lifecycle semantics).
    const dueAt = req.notifyAfter
      ? new Date(req.notifyAfter).getTime()
      : new Date(req.createdAt).getTime() + LEAVE_SUBMIT_UNDO_WINDOW_MS;
    if (Date.now() >= dueAt) {
      pendingSubmitTimers.delete(req._id.toString());
      await dispatchSubmitNotifications(req._id).catch((err) =>
        console.error('[leave] recovered submit notification failed', req._id?.toString(), err?.message),
      );
      recovered += 1;
    } else {
      scheduleSubmitNotification(req._id.toString(), req.notifyAfter ?? null);
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
  //
  // Atomic claim: concurrent approves (double-click, two admins, email link
  // vs portal) resolve to exactly one staged decision; losers get a 409.
  // The staged outcome is bound to the new revision so a stale finalizer can
  // never apply it to later state.
  const stagedAt = new Date();
  const stageTiming = provisionalTiming(LEAVE_DECISION_UNDO_MS, stagedAt.getTime());
  const setUpdate = {
    pendingDecision,
    approverId: actor._id,
    decidedAt: stagedAt,
    decisionComment,
    undoExpiresAt: stageTiming.undoExpiresAt,
    notifyAfter: stageTiming.notifyAfter,
    notificationsSent: false,
    submitNotificationsSent: true,
    decisionTokens: [],
    finalizedAt: null,
  };
  if (adminException) setUpdate.adminException = true;

  // Atomic pipeline claim: revision and pendingRevision derive from the LIVE
  // document inside the update itself, so a stale in-memory `request` can
  // never bind the staged outcome to the wrong revision. (`updatePipeline`
  // is Mongoose's required opt-in for aggregation-pipeline updates.)
  const claimed = await LeaveRequest.findOneAndUpdate(
    { _id: request._id, status: 'pending', pendingDecision: null },
    [
      {
        $set: {
          ...setUpdate,
          revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
          pendingRevision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  );

  if (!claimed) {
    const current = await LeaveRequest.findById(request._id).select('status pendingDecision');
    if (!current || current.status !== 'pending') {
      throwError('Only pending requests can be approved or rejected.', 409);
    }
    throwError('A decision is already pending. Undo it first before acting again.', 409);
  }

  // Sync in-memory state from the atomically staged document.
  for (const [key, value] of Object.entries(setUpdate)) {
    request[key] = value;
  }
  request.revision = claimed.revision;
  request.pendingRevision = claimed.pendingRevision;

  // Lambda precision: wake the finalizer at this decision's finalize time.
  await scheduleLeaveFinalize({
    requestId: request._id.toString(),
    kind: 'decision',
    notifyAfter: setUpdate.notifyAfter,
    revision: request.revision,
  });

  auditLog(isApproved ? 'leave_request_approved' : 'leave_request_rejected', {
    adminId: actor._id.toString(),
    userId: userId.toString(),
    requestId: request._id.toString(),
    comment: decisionComment,
    revision: request.revision,
  });

  return (await LeaveRequest.findById(request._id).populate(LEAVE_REQUEST_POPULATE)).toSafeJSON();
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

const ADMIN_LEAVE_CORRECTION_REASON = 'Admin attendance correction';

async function adminForceApproveExistingLeave(request, actor, session) {
  if (request.status === 'approved') return;
  const userId = request.userId?._id ?? request.userId;
  const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
  const year = getISTYear(request.startDate);
  await applyLeaveApproval(request, {
    userId,
    leaveTypeId,
    days: request.days,
    year,
    session,
    approverId: actor._id,
    comment: ADMIN_LEAVE_CORRECTION_REASON,
  });
}

async function adminCreateSingleDayApprovedLeave({
  userId,
  dayKey,
  leaveTypeId,
  actor,
  auditContext,
  reason = ADMIN_LEAVE_CORRECTION_REASON,
}) {
  const session = await mongoose.startSession();
  try {
    let createdRequest;
    await session.withTransaction(async () => {
      const validated = await validateLeaveRequestInput({
        userId,
        leaveTypeId,
        startDateInput: dayKey,
        endDateInput: dayKey,
        adminException: true,
      });
      await reserveValidatedLeaveBalance(validated.balance, validated.balancePendingDelta, session);

      const [request] = await LeaveRequest.create(
        [
          {
            userId,
            leaveTypeId,
            startDate: validated.startDate,
            endDate: validated.endDate,
            days: validated.days,
            halfDay: null,
            reason,
            status: 'pending',
            adminException: true,
          },
        ],
        { session },
      );

      await applyLeaveApproval(request, {
        userId,
        leaveTypeId,
        days: validated.days,
        year: validated.year,
        session,
        approverId: actor._id,
        comment: reason,
      });

      if (isWfhLeaveType(validated.leaveType)) {
        await updateWfhAttendanceForRequest(request, {
          toStatus: 'approved',
          leaveType: validated.leaveType,
          session,
        });
      }

      createdRequest = request;
    });

    auditLog('leave_admin_apply_day', {
      adminId: actor._id.toString(),
      email: auditContext.email,
      userId: userId.toString(),
      dayKey,
      leaveTypeId: leaveTypeId.toString(),
      requestId: createdRequest._id.toString(),
      created: true,
      ip: auditContext.ip,
      userAgent: auditContext.userAgent,
    });

    return { leaveRequest: createdRequest, created: true, updated: false };
  } finally {
    session.endSession();
  }
}

async function adminChangeSingleDayLeaveType(existing, leaveTypeId, actor, auditContext, reason) {
  const session = await mongoose.startSession();
  try {
    let oldLeaveType = null;
    await session.withTransaction(async () => {
      const userId = existing.userId?._id ?? existing.userId;
      const oldLeaveTypeId = existing.leaveTypeId?._id ?? existing.leaveTypeId;
      const dayKey = getISTDateInputValue(existing.startDate);
      const year = getISTYear(existing.startDate);
      const days = existing.days;

      oldLeaveType = await LeaveType.findById(oldLeaveTypeId).session(session);

      if (existing.status === 'approved') {
        await releaseApprovedDays(userId, oldLeaveTypeId, days, year, session);
      } else if (existing.status === 'pending') {
        await releasePendingDays(userId, oldLeaveTypeId, days, year, session);
      }

      const validated = await validateLeaveRequestInput({
        userId,
        leaveTypeId,
        startDateInput: dayKey,
        endDateInput: dayKey,
        adminException: true,
        excludeRequestId: existing._id,
      });

      existing.leaveTypeId = leaveTypeId;
      existing.reason = reason;
      existing.adminException = true;
      existing.days = validated.days;
      existing.status = 'pending';

      await reserveValidatedLeaveBalance(validated.balance, validated.balancePendingDelta, session);
      await applyLeaveApproval(existing, {
        userId,
        leaveTypeId,
        days: validated.days,
        year: validated.year,
        session,
        approverId: actor._id,
        comment: reason,
      });

      if (isWfhLeaveType(validated.leaveType)) {
        await updateWfhAttendanceForRequest(existing, {
          toStatus: 'approved',
          leaveType: validated.leaveType,
          session,
        });
      } else if (isWfhLeaveType(oldLeaveType)) {
        await clearWfhAttendanceMarkers(existing, { session });
      }

      await existing.save({ session });
    });

    auditLog('leave_admin_apply_day', {
      adminId: actor._id.toString(),
      email: auditContext.email,
      userId: (existing.userId?._id ?? existing.userId).toString(),
      dayKey: getISTDateInputValue(existing.startDate),
      leaveTypeId: leaveTypeId.toString(),
      requestId: existing._id.toString(),
      created: false,
      updated: true,
      ip: auditContext.ip,
      userAgent: auditContext.userAgent,
    });

    return { leaveRequest: existing, created: false, updated: true };
  } finally {
    session.endSession();
  }
}

/**
 * Admin / reporting-manager single-day leave correction for attendance grid edits.
 * Same RBAC scope as admin attendance edit (ATTENDANCE_READ_ALL / ATTENDANCE_READ_TEAM).
 */
export async function adminApplyLeaveForEmployeeDay({
  userId,
  dayKey,
  leaveTypeId,
  actor,
  permissions,
  auditContext = {},
  reason = ADMIN_LEAVE_CORRECTION_REASON,
}) {
  if (!mongoose.isValidObjectId(userId)) {
    throwError('Employee not found.', 404);
  }
  if (!mongoose.isValidObjectId(leaveTypeId)) {
    throwError('Leave type not found or inactive.');
  }

  const allowed = await isUserInTeamScope(
    actor,
    permissions,
    userId,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  if (!allowed) {
    throwError('You do not have permission to edit this attendance record.', 403);
  }

  const employee = await User.findById(userId).select('_id isActive');
  if (!employee?.isActive) {
    throwError('Employee not found.', 404);
  }

  const istDay = parseDateInputAsISTDay(dayKey);
  if (!istDay) {
    throwError('Invalid attendance day.');
  }

  const leaveType = await LeaveType.findById(leaveTypeId);
  if (!leaveType?.isActive) {
    throwError('Leave type not found or inactive.');
  }

  const dayStart = startOfDayIST(istDay);
  const dayEnd = endOfDayIST(istDay);

  const existing = await LeaveRequest.findOne({
    userId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: dayEnd },
    endDate: { $gte: dayStart },
  });

  if (existing) {
    const existingStartKey = getISTDateInputValue(existing.startDate);
    const existingEndKey = getISTDateInputValue(existing.endDate);
    const existingTypeId = (existing.leaveTypeId?._id ?? existing.leaveTypeId).toString();

    if (existingTypeId === leaveTypeId.toString()) {
      if (existing.status === 'approved') {
        return { leaveRequest: existing, created: false, updated: false };
      }
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await adminForceApproveExistingLeave(existing, actor, session);
          if (isWfhLeaveType(leaveType)) {
            await updateWfhAttendanceForRequest(existing, {
              toStatus: 'approved',
              leaveType,
              session,
            });
          }
          await existing.save({ session });
        });
      } finally {
        session.endSession();
      }
      return { leaveRequest: existing, created: false, updated: true };
    }

    if (existingStartKey !== dayKey || existingEndKey !== dayKey) {
      throwError(
        'This employee has multi-day leave covering this date. Adjust it from the Leave module first.',
      );
    }

    return adminChangeSingleDayLeaveType(existing, leaveTypeId, actor, auditContext, reason);
  }

  return adminCreateSingleDayApprovedLeave({
    userId,
    dayKey,
    leaveTypeId,
    actor,
    auditContext,
    reason,
  });
}

export async function createLeaveRequest(userId, payload) {
  // Validates the requester exists and is active; the applicant record for
  // notifications is loaded at finalize time, not submit time.
  await loadRequester(userId);
  const adminException = Boolean(payload.adminException);

  const session = await mongoose.startSession();
  try {
    let createdRequest;
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

      // EVERY request type — including auto-approved ones (SL) — enters the
      // provisional (undoable) state: no notification may be sent and no
      // approval is recorded until the undo window expires and the finalizer
      // runs. Timing is stored on the document so the backend — not browser
      // memory — is authoritative (refresh/close safe). Auto-approved types
      // are approved by the finalizer (finalizeAutoApprovedSubmit) instead of
      // waiting for a manager decision.
      const submitTiming = provisionalTiming(LEAVE_SUBMIT_UNDO_WINDOW_MS);

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
            revision: 0,
            pendingRevision: null,
            undoExpiresAt: submitTiming?.undoExpiresAt ?? null,
            notifyAfter: submitTiming?.notifyAfter ?? null,
            finalizedAt: null,
          },
        ],
        { session },
      );

      if (isWfhLeaveType(validated.leaveType)) {
        // A request can be submitted after the employee has already checked in.
        // Link that check-in now so later decisions update the exact record.
        await updateWfhAttendanceForRequest(request, {
          toStatus: 'pending',
          legacyAnyMode: true,
          leaveType: validated.leaveType,
          session,
        });
      }

      createdRequest = request;
    });

    scheduleSubmitNotification(createdRequest._id.toString());
    // Lambda precision: one SQS wake-up targeted at this request's
    // finalize time (fail-open; the sweep remains the safety net).
    await scheduleLeaveFinalize({
      requestId: createdRequest._id.toString(),
      kind: 'submit',
      notifyAfter: createdRequest.notifyAfter,
      revision: createdRequest.revision ?? 0,
    });
    auditLog('leave_request_created', {
      userId: userId.toString(),
      requestId: createdRequest._id.toString(),
      leaveTypeId: payload.leaveTypeId,
      days: createdRequest.days,
      startDate: payload.startDate,
      endDate: payload.endDate,
    });

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

/**
 * Final submit notification (applicant + reporting manager). Runs ONLY from
 * the finalizer path (in-memory fast-path timer or the sweep job) after the
 * submit undo window has expired — never for withdrawn or superseded
 * submissions. Single-flight per process; the flag claim below makes a
 * concurrent dispatcher a no-op.
 */
async function notifyApplicantOnSubmit(request) {
  const userId = request.userId?._id?.toString?.() ?? request.userId?.toString?.();
  const applicant = await User.findById(userId).select('name email mobile whatsappOptIn');
  if (!applicant) return;
  const leaveTypeName =
    request.leaveTypeId?.name || request.leaveTypeId?.code || 'leave';
  const dateText = formatLeaveDateText(request);
  const timeText = formatLeaveTimeText(request);
  try {
    if (applicant.email) {
      const { subject, html, text } = renderLeaveApplicantSubmittedEmail({
        leaveTypeName,
        reason: request.reason,
        dateText,
        timeText,
      });
      await sendEmail({ to: applicant.email, subject, html, text, tag: 'leave-submitted' });
    }
    if (applicant.mobile) {
      await sendSms({
        to: applicant.mobile,
        message: `Your ${leaveTypeName} leave request (${dateText}) was submitted.`,
      });
    }
  } catch (err) {
    console.error('[leave] applicant submit notification failed', request._id?.toString(), err?.message);
  }
}

export async function dispatchSubmitNotifications(requestId, now = new Date()) {
  const key = String(requestId);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (pendingSubmitDispatch.has(key)) return;
  pendingSubmitDispatch.add(key);
  try {
    const request = await LeaveRequest.findById(requestId).populate(LEAVE_REQUEST_POPULATE);
    if (!request) return;
    if (
      request.status !== 'pending'
      || request.pendingDecision
      || request.notificationsSent
      || request.submitNotificationsSent
    ) return;
    // Final-state check: only the surviving revision may notify. A withdraw
    // cancels the request (status != pending); an edit bumps revision and
    // pushes notifyAfter out, so stale timers/sweeps for older revisions
    // arrive either too early (notifyAfter in future → skip) or for a
    // revision whose flags were already consumed.
    if (request.notifyAfter && new Date(request.notifyAfter).getTime() > nowMs) return;
    // Auto-approved types (SL) skip the submit notification entirely: at
    // finalize time the request is approved outright (applicant + manager
    // info notification), never parked for a manager decision.
    if (isAutoApproveLeaveType(request.leaveTypeId)) {
      await finalizeAutoApprovedSubmit(request);
      return;
    }
    // Atomic claim FIRST so concurrent dispatchers (timer vs sweep, retries,
    // double-fires) deliver exactly once. The loser returns without sending.
    const claimed = await LeaveRequest.findOneAndUpdate(
      {
        _id: request._id,
        status: 'pending',
        pendingDecision: null,
        notificationsSent: false,
        submitNotificationsSent: { $ne: true },
      },
      { $set: { notificationsSent: true, submitNotificationsSent: true } },
    );
    if (!claimed) return;
    try {
      await notifyApproversOnSubmit(request.userId, request, request.leaveTypeId);
      await sendLeaveManagerEmail(requestId);
      await notifyApplicantOnSubmit(request);
    } catch (err) {
      // Sending failed after the claim: release the claim so a later sweep
      // can retry instead of dropping the notification silently.
      await LeaveRequest.updateOne(
        { _id: request._id },
        { $set: { notificationsSent: false, submitNotificationsSent: false } },
      ).catch(() => {});
      console.error('[leave] submit notification send failed', key, err?.message);
      return;
    }
    auditLog('leave_submit_finalized', {
      userId: (request.userId?._id ?? request.userId)?.toString?.(),
      requestId: request._id.toString(),
    });
  } finally {
    pendingSubmitDispatch.delete(key);
  }
}

/**
 * Finalizes an auto-approved-type submission (SL) once its undo window has
 * expired: the request is approved outright inside ONE transaction (guard
 * re-check + balance move + status + flags commit atomically, so concurrent
 * dispatchers and crash-recovery retries can neither double-apply nor stall),
 * then the applicant "approved" notification and the manager info
 * notification (existing withActions=false path: no token, no Take Action
 * button) go out post-commit. A withdraw/edit/decision that lands first flips
 * the guarded fields, turning this into a no-op for the superseded revision.
 */
async function finalizeAutoApprovedSubmit(request) {
  const userId = request.userId?._id ?? request.userId;
  const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
  const year = getISTYear(request.startDate);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const live = await LeaveRequest.findOne({
        _id: request._id,
        status: 'pending',
        pendingDecision: null,
        notificationsSent: false,
        submitNotificationsSent: { $ne: true },
      }).session(session);
      if (!live) {
        throw Object.assign(new Error('Auto-approval superseded before finalize.'), { code: 'STALE_PROVISIONAL' });
      }
      await approvePendingDays(userId, leaveTypeId, request.days, year, session);
      await updateWfhAttendanceForRequest(request, {
        fromStatuses: ['pending', 'rejected'],
        toStatus: 'approved',
        legacyAnyMode: true,
        session,
      });
      live.status = 'approved';
      live.decidedAt = new Date();
      live.decisionComment = null;
      live.pendingDecision = null;
      live.pendingRevision = null;
      live.notifyAfter = null;
      live.undoExpiresAt = null;
      live.notificationsSent = true;
      live.submitNotificationsSent = true;
      live.finalizedAt = new Date();
      live.revision = (live.revision ?? 0) + 1;
      await live.save({ session });
    });
  } catch (err) {
    if (err?.code === 'STALE_PROVISIONAL') return { finalized: false, stale: true };
    throw err;
  } finally {
    session.endSession();
  }

  try {
    const requester = await loadRequester(userId);
    await notifyApplicantDecision({
      applicant: requester,
      request,
      leaveType: request.leaveTypeId,
      status: 'approved',
      decisionComment: null,
      sendChannels: true,
    });
    await sendLeaveManagerEmail(request._id.toString());
  } catch (notifyErr) {
    // Final state stands; delivery failure is logged for ops follow-up.
    console.error('[leave] auto-approval notification failed', request._id.toString(), notifyErr?.message);
  }

  auditLog('leave_request_auto_approved', {
    userId: userId?.toString?.(),
    requestId: request._id.toString(),
  });
  return { finalized: true };
}

/**
 * Withdraws a freshly submitted request inside its undo window.
 * CRITICAL: this path is SILENT — it must never send any email/SMS. The old
 * implementation reused cancelLeaveRequest, which fired a cancellation email
 * on every Undo. Withdrawal releases the reserved balance and clears WFH
 * markers, cancels the pending submit timer, and returns the request to the
 * employee for editing + resubmission (which starts a brand-new undo window).
 */
export async function undoSubmittedLeaveRequest(requestId, actor) {
  const request = await loadLeaveRequest(requestId);
  const requesterId = request.userId?._id?.toString() ?? request.userId?.toString();
  if (requesterId !== actor._id.toString()) {
    throwError('You can only undo your own leave requests.', 403);
  }

  // Atomic claim: exactly one of {withdraw, submit-dispatch, edit} wins.
  // If notifications already went out, the request is finalized and the
  // undo is rejected so the UI can reflect the final state.
  // The undo window is enforced in the claim: an expired window loses the
  // race the same way a dispatched notification does.
  const now = new Date();
  const claimed = await LeaveRequest.findOneAndUpdate(
    {
      _id: request._id,
      status: 'pending',
      pendingDecision: null,
      notificationsSent: false,
      submitNotificationsSent: { $ne: true },
      undoExpiresAt: { $gt: now },
    },
    {
      $set: {
        status: 'cancelled',
        decidedAt: new Date(),
        approverId: null,
        decisionTokens: [],
        notifyAfter: null,
        undoExpiresAt: null,
        pendingRevision: null,
        finalizedAt: new Date(),
        notificationsSent: true,
        submitNotificationsSent: true,
      },
      $inc: { revision: 1 },
    },
  );

  if (!claimed) {
    const current = await LeaveRequest.findById(request._id).select('status notificationsSent submitNotificationsSent undoExpiresAt');
    if (!current || current.status !== 'pending') {
      throwError('This request can no longer be undone.', 409);
    }
    if (current.undoExpiresAt && new Date(current.undoExpiresAt).getTime() <= now.getTime()) {
      throwError('The undo window for this request has expired.', 410);
    }
    throwError('This request was already sent to your manager.', 409);
  }

  const existing = pendingSubmitTimers.get(String(requestId));
  if (existing) {
    clearTimeout(existing);
    pendingSubmitTimers.delete(String(requestId));
  }

  // Release the reserved balance + WFH markers. No notification of any kind.
  // NB: use the populated pre-claim `request` (not the bare `claimed` doc)
  // so WFH leave-type detection works.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const userId = request.userId?._id ?? request.userId;
      const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
      const year = getISTYear(request.startDate);
      await releasePendingDays(userId, leaveTypeId, request.days, year, session);
      await updateWfhAttendanceForRequest(request, {
        fromStatuses: ['pending', 'rejected'],
        legacyAnyMode: true,
        session,
      });
    });
  } finally {
    session.endSession();
  }

  auditLog('leave_request_withdrawn', {
    userId: actor._id.toString(),
    requestId: request._id.toString(),
  });

  return (await LeaveRequest.findById(request._id).populate(LEAVE_REQUEST_POPULATE)).toSafeJSON();
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
    // Atomic claim so concurrent cancels resolve to exactly one staged action.
    const cancelTiming = provisionalTiming(LEAVE_DECISION_UNDO_MS);
    const setUpdate = {
      pendingDecision: 'cancelled',
      undoExpiresAt: cancelTiming.undoExpiresAt,
      notifyAfter: cancelTiming.notifyAfter,
      notificationsSent: false,
      submitNotificationsSent: true,
      decisionTokens: [],
      finalizedAt: null,
    };
    if (decisionComment) setUpdate.decisionComment = decisionComment;

    // Atomic pipeline claim (see processLeaveDecision): revision binding
    // derives from the live document. The status guard prevents staging a
    // cancellation on a request that concurrently left the approved state.
    const claimed = await LeaveRequest.findOneAndUpdate(
      { _id: request._id, status: 'approved', pendingDecision: null },
      [
        {
          $set: {
            ...setUpdate,
            revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
            pendingRevision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
          },
        },
      ],
      { returnDocument: 'after', updatePipeline: true },
    );
    if (!claimed) {
      throwError('This leave is no longer in a cancellable state. Refresh and try again.', 409);
    }
    // Keep the caller's in-memory document consistent (callers serialize it).
    for (const [key, value] of Object.entries(setUpdate)) {
      request[key] = value;
    }
    request.revision = claimed.revision;
    request.pendingRevision = claimed.pendingRevision;
    await scheduleLeaveFinalize({
      requestId: request._id.toString(),
      kind: 'cancel',
      notifyAfter: setUpdate.notifyAfter,
      revision: request.revision,
    });
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
        // Fully terminal: clear every provisional-lifecycle field so no
        // stale undo expiry / staged revision survives on the cancelled doc.
        request.notifyAfter = null;
        request.undoExpiresAt = null;
        request.pendingDecision = null;
        request.pendingRevision = null;
        request.finalizedAt = new Date();
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
    // A finalized cancellation (status already cancelled) reports finality;
    // anything else simply has no staged cancellation to undo.
    if (request.status === 'cancelled') {
      throwError('The cancellation is now final and can no longer be undone.', 410);
    }
    throwError('No pending cancellation to undo.', 400);
  }

  // Undo deadline is undoExpiresAt (notifyAfter includes the deliberate
  // post-expiry notification delay and must not extend the undo window).
  // Legacy documents fall back to decidedAt + window; the atomic claim below
  // is authoritative either way.
  const undoDeadline = request.undoExpiresAt
    ? new Date(request.undoExpiresAt).getTime()
    : new Date(request.decidedAt).getTime() + LEAVE_DECISION_UNDO_MS;
  if (Number.isFinite(undoDeadline) && Date.now() > undoDeadline) {
    throwError('The undo window has expired. The cancellation is now final.', 410);
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  const isOwner = request.userId?._id?.toString() === actor._id.toString()
    || request.userId?.toString?.() === actor._id.toString();
  if (!isOwner && !canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to undo this cancellation.', 403);
  }

  const userId = request.userId?._id ?? request.userId;
  const now = new Date();
  const stagedRevision = request.revision ?? 0;

  // Atomic claim, same expiry-boundary semantics as undoLeaveDecision.
  const undoCutoff = request.undoExpiresAt
    ? new Date(request.undoExpiresAt)
    : new Date(new Date(request.decidedAt).getTime() + LEAVE_DECISION_UNDO_MS);
  const claimed = await LeaveRequest.findOneAndUpdate(
    {
      _id: request._id,
      pendingDecision: 'cancelled',
      revision: stagedRevision,
      $or: [
        { undoExpiresAt: { $gt: now } },
        { undoExpiresAt: null, decidedAt: { $gt: new Date(now.getTime() - LEAVE_DECISION_UNDO_MS) } },
      ],
    },
    {
      // Nothing changed during the undo window — status, balance and WFH
      // markers are all untouched. Just clear the pending decision fields.
      // Keep the original approval metadata (approverId/decidedAt) intact.
      $set: {
        pendingDecision: null,
        notifyAfter: null,
        undoExpiresAt: null,
        pendingRevision: null,
        notificationsSent: false,
        submitNotificationsSent: true,
        decisionTokens: [],
      },
      $inc: { revision: 1 },
    },
  );

  if (!claimed) {
    const current = await LeaveRequest.findById(request._id).select('pendingDecision revision undoExpiresAt decidedAt status');
    if (!current || current.pendingDecision !== 'cancelled' || (current.revision ?? 0) !== stagedRevision) {
      throwError('The cancellation is now final and can no longer be undone.', 410);
    }
    if (now >= undoCutoff) {
      throwError('The undo window has expired. The cancellation is now final.', 410);
    }
    throwError('This cancellation was already updated. Refresh and try again.', 409);
  }

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

  // Refetch: the pre-claim `request` still carries the cleared pendingDecision.
  return (await LeaveRequest.findById(request._id).populate(LEAVE_REQUEST_POPULATE)).toSafeJSON();
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
    await createNotification({
      userId,
      type: 'leave.cancelled',
      title: wasApproved ? 'Leave cancelled' : 'Leave request cancelled',
      body: wasApproved
        ? `Your ${leaveTypeName} leave (${dateText}) was cancelled. The leave days have been returned to your balance.`
        : `Your ${leaveTypeName} leave request (${dateText}) was cancelled.`,
      link: '/employee/leave/requests',
      metadata: { requestId: request._id.toString() },
    });

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

  // Notify the reporting chain that the leave was cancelled. The original
  // approver (if any) gets the approver-specific template; the reporting
  // manager / delegate get a neutral cancellation notice unless they are the
  // approver (no duplicate mails to the same person).
  if (!sendChannels) return;
  const notifiedUserIds = new Set();
  if (approverId) notifiedUserIds.add(String(approverId));
  try {
    const requesterDoc = await User.findById(userId).select('name reportingManagerId delegateApproverId');
    const managerIds = collectManagerIds(requesterDoc).map((id) => String(id)).filter((id) => !notifiedUserIds.has(id));
    const managers = managerIds.length
      ? await User.find({ _id: { $in: managerIds }, isActive: true }).select('name email mobile')
      : [];
    const applicantName = applicant?.name || requesterDoc?.name || 'An employee';
    for (const manager of managers) {
      notifiedUserIds.add(String(manager._id));
      if (manager.email) {
        const { subject, html, text } = renderLeaveCancelledForManagerEmail({
          applicantName,
          leaveTypeName,
          dateText,
          timeText,
          wasApproved,
        });
        await sendEmail({ to: manager.email, subject, html, text, tag: 'leave-cancelled-manager' });
      }
      if (manager.mobile) {
        await sendSms({
          to: manager.mobile,
          message: `${applicantName} cancelled ${wasApproved ? 'approved ' : ''}${leaveTypeName} leave (${dateText}).`,
        });
      }
      await createNotification({
        userId: manager._id,
        type: 'leave.cancelled',
        title: wasApproved ? 'Approved leave cancelled' : 'Leave request cancelled',
        body: `${applicantName} cancelled ${wasApproved ? 'approved ' : ''}${leaveTypeName} leave (${dateText}).`,
        link: '/admin/leave/approvals',
        metadata: { requestId: request._id.toString() },
      });
    }
  } catch (err) {
    console.error('[leave] manager cancellation notice failed', request._id?.toString(), err?.message);
  }

  // Notify the original approver that the approved leave was cancelled.
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
      if (approver.mobile) {
        await sendSms({
          to: approver.mobile,
          message: `${applicantName} cancelled their approved ${leaveTypeName} leave (${dateText}).`,
        });
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
  if (request.pendingDecision) {
    throwError('A decision is already pending. Undo it first before editing.');
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
      // A resubmission starts a brand-new undo window bound to a new
      // revision; any stale timer/sweep for the previous revision notifies
      // nothing (flags + timing no longer match it).
      const editTiming = provisionalTiming(LEAVE_SUBMIT_UNDO_WINDOW_MS);
      request.undoExpiresAt = editTiming.undoExpiresAt;
      request.notifyAfter = editTiming.notifyAfter;
      request.pendingDecision = null;
      request.pendingRevision = null;
      request.finalizedAt = null;
      // Old submit email links must not be able to decide the edited dates.
      request.decisionTokens = [];
      request.revision = (request.revision ?? 0) + 1;
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

  scheduleSubmitNotification(request._id.toString(), request.notifyAfter);
  await scheduleLeaveFinalize({
    requestId: request._id.toString(),
    kind: 'submit',
    notifyAfter: request.notifyAfter,
    revision: request.revision ?? 0,
  });

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
  if (request.pendingDecision) {
    throwError('A decision is already pending. Undo it first before acting again.', 409);
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
    // A decided (finalized) request reports finality so the UI can settle on
    // the outcome; a plain pending request simply has nothing to undo.
    if (request.status !== 'pending' || request.finalizedAt) {
      throwError('The decision is now final and can no longer be undone.', 410);
    }
    throwError('No pending decision to undo.', 400);
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to undo this leave decision.', 403);
  }

  const userId = request.userId?._id ?? request.userId;
  const now = new Date();
  const stagedDecision = request.pendingDecision;
  const stagedRevision = request.revision ?? 0;

  // Atomic claim against the exact staged revision inside its undo window.
  // Exactly one of {undo, finalizer} wins at the expiry boundary — the
  // loser observes the winner's state and reports it deterministically.
  // Legacy documents without undoExpiresAt fall back to decidedAt + window.
  const undoCutoff = request.undoExpiresAt
    ? new Date(request.undoExpiresAt)
    : new Date(new Date(request.decidedAt).getTime() + LEAVE_DECISION_UNDO_MS);
  const claimed = await LeaveRequest.findOneAndUpdate(
    {
      _id: request._id,
      pendingDecision: stagedDecision,
      revision: stagedRevision,
      $or: [
        { undoExpiresAt: { $gt: now } },
        { undoExpiresAt: null, decidedAt: { $gt: new Date(now.getTime() - LEAVE_DECISION_UNDO_MS) } },
      ],
    },
    {
      // Nothing changed during the undo window — status, balance and WFH
      // markers are all untouched. Just clear the pending decision fields.
      $set: {
        pendingDecision: null,
        approverId: null,
        decidedAt: null,
        decisionComment: null,
        adminException: false,
        notifyAfter: null,
        undoExpiresAt: null,
        pendingRevision: null,
        notificationsSent: false,
        submitNotificationsSent: true,
        decisionTokens: [],
      },
      $inc: { revision: 1 },
    },
  );

  if (!claimed) {
    const current = await LeaveRequest.findById(request._id).select('pendingDecision revision undoExpiresAt decidedAt status');
    if (!current?.pendingDecision || (current.revision ?? 0) !== stagedRevision) {
      throwError('The decision is now final and can no longer be undone.', 410);
    }
    if (now >= undoCutoff) {
      throwError('The undo window has expired. The decision is now final.', 410);
    }
    throwError('This decision was already updated. Refresh and try again.', 409);
  }

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

  // Refetch: the pre-claim `request` still carries the cleared pendingDecision.
  return (await LeaveRequest.findById(request._id).populate(LEAVE_REQUEST_POPULATE)).toSafeJSON();
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

/**
 * Finalizer sweep. Commits provisional actions whose undo window has expired
 * (plus the deliberate post-expiry notification delay) and sends exactly one
 * notification per finalized action. Covers BOTH staged decisions/cancels
 * AND deferred submit notifications, so browser close/refresh, Lambda
 * timer loss, and worker restarts all converge to the correct final state.
 *
 * Safety properties:
 * - A due item is finalized only if its live revision still matches the
 *   revision bound at stage time (`pendingRevision`); stale items are
 *   skipped as no-ops (a newer undo/edit already superseded them).
 * - Balance + status + flags commit atomically in ONE transaction, so a
 *   crash can never double-apply balance moves on retry.
 * - Notifications go out only AFTER the transaction commits. A notification
 *   failure is logged and never rolls back the finalized business state.
 * - Each item is isolated in try/catch: one bad request can no longer abort
 *   the whole sweep and freeze every other pending request.
 */
export async function runLeaveDecisionNotifyJob(now = new Date()) {
  const expiredPendingWfh = await expirePendingWfhAttendance(now);
  const dueDecisions = await LeaveRequest.find({
    pendingDecision: { $ne: null },
    notifyAfter: { $ne: null, $lte: now },
    notificationsSent: false,
  }).populate(LEAVE_REQUEST_POPULATE);
  const dueSubmits = await LeaveRequest.find({
    status: 'pending',
    pendingDecision: null,
    submitNotificationsSent: { $ne: true },
    notificationsSent: false,
    notifyAfter: { $ne: null, $lte: now },
  }).select('_id');

  let processed = 0;
  let submitNotified = 0;
  const skippedStale = [];
  const failed = [];

  for (const request of dueDecisions) {
    const decision = request.pendingDecision;
    const requestKey = request._id.toString();
    try {
      // Stale-guard: only the revision that staged this outcome may finalize
      // it. Anything else means a newer action superseded it — no-op.
      // Legacy staged rows without pendingRevision predate revisions and are
      // finalized on the flag match alone (one-shot migration path).
      if (request.pendingRevision != null && (request.revision ?? 0) !== request.pendingRevision) {
        skippedStale.push(requestKey);
        continue;
      }

      const userId = request.userId?._id ?? request.userId;
      const leaveTypeId = request.leaveTypeId?._id ?? request.leaveTypeId;
      const year = getISTYear(request.startDate);
      const finalStatus = decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'cancelled';

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          // Re-read inside the transaction: an undo racing finalization
          // loses deterministically when its revision no longer matches.
          const live = await LeaveRequest.findOne({
            _id: request._id,
            pendingDecision: decision,
            ...(request.pendingRevision != null ? { revision: request.pendingRevision } : {}),
          }).session(session);
          if (!live) {
            throw Object.assign(new Error('Stale provisional action; superseded before finalize.'), { code: 'STALE_PROVISIONAL' });
          }

          if (decision === 'approved') {
            // Finalise approval: consume the reserved pending days, mark WFH approved.
            await approvePendingDays(userId, leaveTypeId, request.days, year, session);
            await updateWfhAttendanceForRequest(request, {
              fromStatuses: ['pending', 'rejected'],
              toStatus: 'approved',
              legacyAnyMode: true,
              session,
            });
          } else if (decision === 'rejected') {
            // Finalise rejection: release the reserved pending days, mark WFH rejected.
            await releasePendingDays(userId, leaveTypeId, request.days, year, session);
            await updateWfhAttendanceForRequest(request, {
              fromStatuses: ['pending'],
              toStatus: 'rejected',
              legacyAnyMode: true,
              session,
            });
          } else if (decision === 'cancelled') {
            // Finalise cancellation: release consumed days, unset WFH markers.
            await releaseApprovedDays(userId, leaveTypeId, request.days, year, session);
            await updateWfhAttendanceForRequest(request, {
              fromStatuses: ['approved', 'pending'],
              legacyAnyMode: true,
              session,
            });
          }

          live.status = finalStatus;
          live.pendingDecision = null;
          live.pendingRevision = null;
          live.notifyAfter = null;
          live.undoExpiresAt = null;
          live.notificationsSent = true;
          live.finalizedAt = new Date();
          live.revision = (live.revision ?? 0) + 1;
          await live.save({ session });
        });
      } finally {
        session.endSession();
      }

      // Deferred notification — post-commit only, never blocking finality.
      try {
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
      } catch (notifyErr) {
        // Final state stands; delivery failure is logged for ops follow-up.
        // No retry by design (the decision is final) — surface request context
        // so a missed applicant/manager email can be found and re-sent manually.
        console.error('[leave] finalized notification failed', {
          requestId: requestKey,
          decision,
          revision: request.pendingRevision ?? request.revision,
          error: notifyErr?.message,
        });
        auditLog('leave_finalized_notification_failed', {
          requestId: requestKey,
          decision,
          error: notifyErr?.message ?? 'unknown',
        });
      }

      auditLog('leave_request_finalized', {
        userId: userId?.toString?.(),
        requestId: requestKey,
        decision,
        revision: (request.revision ?? 0) + 1,
      });
      processed += 1;
    } catch (err) {
      if (err?.code === 'STALE_PROVISIONAL') {
        skippedStale.push(requestKey);
        continue;
      }
      console.error('[leave] decision finalize failed', requestKey, err?.message);
      failed.push({ requestId: requestKey, error: err?.message });
    }
  }

  for (const stub of dueSubmits) {
    try {
      // Pass the sweep's clock: dispatch's final-state timing check must use
      // the same `now` the sweep query used otherwise due items would bail
      // against wall-clock time.
      await dispatchSubmitNotifications(stub._id, now);
      submitNotified += 1;
    } catch (err) {
      console.error('[leave] submit sweep failed', stub._id?.toString(), err?.message);
      failed.push({ requestId: stub._id?.toString(), error: err?.message });
    }
  }

  return {
    processed,
    submitNotified,
    skippedStale,
    failed,
    expiredPendingWfh,
    runAt: now.toISOString(),
  };
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
  // _id tiebreaker keeps offset pagination stable when timestamps tie.
  const sort =
    resolvedStatus === 'approved' || resolvedStatus === 'rejected'
      ? { decidedAt: -1, createdAt: -1, _id: -1 }
      : { createdAt: -1, _id: -1 };
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
