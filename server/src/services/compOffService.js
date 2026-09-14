import mongoose from 'mongoose';
import crypto from 'crypto';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { WFH_LEAVE_TYPE_CODE } from '../../../shared/utils/wfhPolicy.js';
import {
  endOfDayIST,
  getISTDateInputValue,
  getISTYear,
  isWeekendIST,
  parseDateInputAsISTDay,
  startOfDayIST,
} from '../utils/istDate.js';
import { CompOffRequest, COMP_OFF_REQUEST_POPULATE } from '../models/CompOffRequest.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { Holiday } from '../models/Holiday.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { createNotification } from './notificationService.js';
import { auditLog } from '../utils/auditLog.js';
import { scheduleLeaveFinalize } from './leaveFinalizeQueue.js';
import { canApproveLeave, hashDecisionToken } from './leaveService.js';
import { ensureBalancesForUser } from './leaveBalanceService.js';
import { resolveLeaveApprovalUserIds } from './teamScopeService.js';
import { env } from '../config/env.js';
import {
  sendEmail,
  renderCompOffManagerEmail,
  renderCompOffDecisionEmail,
  renderCompOffAssessedEmail,
} from './emailService.js';
import { sendSms } from './smsService.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

// Provisional → undoable → finalized lifecycle. Identical semantics to the
// leave workflow: every undoable action (submit, approve/reject, assess)
// records an undo deadline (`undoExpiresAt`) and a finalize time
// (`notifyAfter = undoExpiresAt + LEAVE_NOTIFICATION_DELAY_MS`). Only the
// background finalizer may send notifications or mutate the CO balance, and
// only after `notifyAfter` has passed for the CURRENT revision.
const LEAVE_SUBMIT_UNDO_WINDOW_MS = env.leaveSubmitUndoMs;
const LEAVE_DECISION_UNDO_MS = env.leaveDecisionUndoMs;
const LEAVE_NOTIFICATION_DELAY_MS = env.leaveNotificationDelayMs;

const COMP_OFF_LEAVE_TYPE_CODE = 'CO';
/** Terminal statuses: an overlap check only considers non-terminal requests. */
const ACTIVE_STATUSES = ['pending', 'approved', 'worked'];
const ASSESSMENT_RATE = { completed: 1, half: 0.5, none: 0 };

/**
 * Computes the two timestamps for a new provisional comp-off action.
 * @returns {{ undoExpiresAt: Date, notifyAfter: Date }}
 */
function provisionalTiming(windowMs, fromTime = Date.now()) {
  const undoExpiresAt = new Date(fromTime + windowMs);
  const notifyAfter = new Date(undoExpiresAt.getTime() + LEAVE_NOTIFICATION_DELAY_MS);
  return { undoExpiresAt, notifyAfter };
}

/** Round a credit figure to 0.5 granularity (never rounds below 0). */
export function roundHalf(amount) {
  return Math.max(0, Math.round((amount ?? 0) * 2) / 2);
}

/**
 * Credit math: requested days × assessment rate, rounded to 0.5 granularity.
 * completed ×1, half ×0.5, none ×0. Pure — unit tested.
 */
export function computeCompOffCredit(days, assessment) {
  const rate = ASSESSMENT_RATE[assessment] ?? 0;
  return roundHalf((days ?? 0) * rate);
}

/**
 * Eligible comp-off day keys (YYYY-MM-DD) for a calendar year given office
 * weekend days and active holiday date keys. Pure — unit tested.
 */
export function buildEligibleDayKeysForYear(year, weekendDays, holidayDateKeys) {
  const start = parseDateInputAsISTDay(`${year}-01-01`);
  const end = parseDateInputAsISTDay(`${year}-12-31`);
  const days = [];
  const cursor = startOfDayIST(start);
  const endMs = startOfDayIST(end).getTime();
  let day = new Date(cursor.getTime());
  while (day.getTime() <= endMs) {
    const key = getISTDateInputValue(day);
    if (isWeekendIST(day, weekendDays) || holidayDateKeys?.has(key)) {
      days.push(key);
    }
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}

/**
 * Checks that every calendar day in [startKey, endKey] is eligible for comp
 * off (weekend or active holiday). holidayDateSets maps each year to its Set
 * of holiday keys. Returns the number of days in range or throws (pure).
 */
export function countEligibleDaysInRangeKeys(startKey, endKey, weekendDays, holidayDateSets) {
  if (!startKey || !endKey || endKey < startKey) {
    const error = new Error('Invalid comp off date range.');
    error.statusCode = 400;
    throw error;
  }
  let cursor = parseDateInputAsISTDay(startKey);
  const end = parseDateInputAsISTDay(endKey);
  let count = 0;
  while (cursor <= end) {
    const key = getISTDateInputValue(cursor);
    const yearSet = holidayDateSets?.get(Number(key.slice(0, 4)));
    if (!isWeekendIST(cursor, weekendDays) && !yearSet?.has(key)) {
      const error = new Error('Comp off can only be requested for weekends and holidays.');
      error.statusCode = 400;
      throw error;
    }
    count += 1;
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return count;
}

const pendingSubmitTimers = new Map();

/** Single-flight guard so the in-memory timer and the sweeper job never dispatch the same request concurrently. */
const pendingSubmitDispatch = new Set();

function scheduleSubmitNotification(requestId, dueAt = null) {
  if (process.env.NODE_ENV === 'test') return;
  if (pendingSubmitTimers.has(requestId)) return;
  const delayMs = dueAt
    ? Math.max(0, new Date(dueAt).getTime() - Date.now())
    : LEAVE_SUBMIT_UNDO_WINDOW_MS + LEAVE_NOTIFICATION_DELAY_MS;
  const timer = setTimeout(() => {
    pendingSubmitTimers.delete(requestId);
    dispatchCompOffSubmit(requestId).catch((err) =>
      console.error('[comp-off] deferred submit notification failed', requestId, err?.message),
    );
  }, delayMs);
  if (timer.unref) timer.unref();
  pendingSubmitTimers.set(requestId, timer);
}

/**
 * Recovery for comp-off submit notifications (Lambda cold-start / restart
 * safe). Mirrors the leave recovery: pending non-notified requests either get
 * dispatched immediately (already due) or re-armed on the in-memory timer.
 */
export async function recoverPendingCompOffSubmitNotifications() {
  const stale = await CompOffRequest.find({
    status: 'pending',
    pendingAction: null,
    notificationsSent: false,
    submitNotificationsSent: { $ne: true },
  }).select('_id createdAt notifyAfter');

  let recovered = 0;
  for (const req of stale) {
    const dueAt = req.notifyAfter
      ? new Date(req.notifyAfter).getTime()
      : new Date(req.createdAt).getTime() + LEAVE_SUBMIT_UNDO_WINDOW_MS;
    if (Date.now() >= dueAt) {
      pendingSubmitTimers.delete(req._id.toString());
      await dispatchCompOffSubmit(req._id).catch((err) =>
        console.error('[comp-off] recovered submit notification failed', req._id?.toString(), err?.message),
      );
      recovered += 1;
    } else {
      scheduleSubmitNotification(req._id.toString(), req.notifyAfter ?? null);
    }
  }
  return { recovered };
}

export async function loadCompOffRequest(requestId) {
  if (!mongoose.isValidObjectId(requestId)) {
    throwError('Comp off request not found.', 404);
  }
  const request = await CompOffRequest.findById(requestId).populate(COMP_OFF_REQUEST_POPULATE);
  if (!request) {
    throwError('Comp off request not found.', 404);
  }
  return request;
}

async function loadRequester(userId) {
  const user = await User.findById(userId).populate({
    path: 'reportingManagerId',
    select: 'name email delegateApproverId',
  });
  if (!user || !user.isActive) {
    throwError('Employee not found.', 404);
  }
  return user;
}

function requesterManagerIds(requester) {
  const ids = [];
  const rm = requester?.reportingManagerId;
  if (rm) {
    const rmId = rm?._id ?? rm;
    ids.push(String(rmId));
    const delegate = rm?.delegateApproverId;
    if (delegate) ids.push(String(delegate._id ?? delegate));
  }
  return [...new Set(ids)];
}

function formatCompOffDateText(request) {
  const start = getISTDateInputValue(request.startDate);
  const end = getISTDateInputValue(request.endDate);
  return start === end ? start : `${start} to ${end}`;
}

// Single-use email Take-Action tokens. Mirrors the leave decision-token
// lifecycle exactly: SHA-256 stored hash, expiry = max(end-of-work-day,
// now + TTL), atomic single-use consume, peek-without-consume for the
// auto-login link. The link stays usable for login until the request is
// decided/withdrawn (which clears decisionTokens) or the token expires.
const COMP_OFF_DECISION_TOKEN_TTL_MS = Number(process.env.LEAVE_DECISION_TOKEN_TTL_MS ?? 48 * 60 * 60 * 1000);

export async function issueCompOffDecisionToken(requestId, managerId, action) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashDecisionToken(raw);
  const request = await CompOffRequest.findById(requestId).select('endDate');
  let expiresAt = request?.endDate ? endOfDayIST(request.endDate) : null;
  const minExpiresAt = new Date(Date.now() + COMP_OFF_DECISION_TOKEN_TTL_MS);
  if (!expiresAt || expiresAt < minExpiresAt) expiresAt = minExpiresAt;
  await CompOffRequest.updateOne(
    { _id: requestId },
    { $push: { decisionTokens: { tokenHash, action, managerId, expiresAt, used: false, usedAt: null } } },
  );
  return raw;
}

export async function consumeCompOffDecisionToken(requestId, action, rawToken) {
  const request = await CompOffRequest.findById(requestId).select('decisionTokens');
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
  const claimed = await CompOffRequest.findOneAndUpdate(
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

export async function peekCompOffDecisionToken(requestId, action, rawToken) {
  const request = await CompOffRequest.findById(requestId).select('decisionTokens status');
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

export async function autoLoginByCompOffDecisionToken(requestId, action, rawToken) {
  // Peek, don't consume: the link stays usable for login until the request is
  // decided or withdrawn (both clear decisionTokens) or the token expires.
  const peeked = await peekCompOffDecisionToken(requestId, action, rawToken);
  const managerId = peeked?.managerId ?? null;
  if (!managerId) {
    const err = new Error('This link is invalid, has already been used, or has expired.');
    err.statusCode = 410;
    throw err;
  }
  const request = await loadCompOffRequest(requestId);
  if (request.status !== 'pending') {
    const err = new Error('This comp off request has already been decided.');
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

/** Active holidays in a calendar year keyed by YYYY-MM-DD. */
export async function getCompOffHolidayMapForYear(year) {
  const start = parseDateInputAsISTDay(`${year}-01-01`);
  const end = parseDateInputAsISTDay(`${year}-12-31`);
  const holidays = await Holiday.find({
    isActive: true,
    date: { $gte: start, $lte: end },
  }).select('date');
  const map = new Map();
  for (const item of holidays) {
    map.set(getISTDateInputValue(item.date), true);
  }
  return map;
}

async function loadWeekendDays() {
  const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  return settings?.weekendDays?.length ? settings.weekendDays : [0, 6];
}

/**
 * Eligible comp-off days for a calendar year: office weekends + active
 * holidays. Pure computation, server-authoritative — the client picker never
 * decides eligibility.
 */
export async function getEligibleCompOffDays(year = getISTYear()) {
  year = Math.min(2100, Math.max(2000, Number(year) || getISTYear()));
  const weekendDays = await loadWeekendDays();
  const holidayMap = await getCompOffHolidayMapForYear(year);
  return {
    year,
    days: buildEligibleDayKeysForYear(year, weekendDays, new Set(holidayMap.keys())),
  };
}

/**
 * Counts eligible days in [startDate, endDate]. Throws 400 when ANY calendar
 * day in the range is not a weekend/active holiday — comp off can only be
 * requested for fully-eligible ranges.
 */
async function assertRangeEligible(startDate, endDate) {
  const weekendDays = await loadWeekendDays();
  const years = new Set();
  for (let y = getISTYear(startDate); y <= getISTYear(endDate); y += 1) years.add(y);
  const holidayDateSets = new Map();
  for (const y of years) {
    const map = await getCompOffHolidayMapForYear(y);
    holidayDateSets.set(y, new Set(map.keys()));
  }
  return countEligibleDaysInRangeKeys(
    getISTDateInputValue(startDate),
    getISTDateInputValue(endDate),
    weekendDays,
    holidayDateSets,
  );
}

/** Approved/pending LEAVE covering any requested day blocks comp off (WFH requests do NOT block). */
async function assertNoLeaveOverlap(userId, startDate, endDate) {
  const wfhType = await LeaveType.findOne({ code: WFH_LEAVE_TYPE_CODE }).select('_id');
  const filter = {
    userId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  };
  if (wfhType) filter.leaveTypeId = { $ne: wfhType._id };
  const overlap = await LeaveRequest.findOne(filter).select('_id leaveTypeId');
  if (overlap) {
    throwError('You have a leave request covering one of the requested comp off days.');
  }
}

/**
 * Creates a pending comp-off request. Enters the provisional lifecycle like a
 * leave submission: NO notification and NO balance change until the submit
 * undo window expires and the finalizer dispatches the manager notification.
 */
export async function createCompOffRequest(userId, payload) {
  await loadRequester(userId);

  const startDate = parseDateInputAsISTDay(payload.startDate);
  const endDate = parseDateInputAsISTDay(payload.endDate);
  if (!startDate || !endDate || endDate < startDate) {
    throwError('Invalid comp off date range.');
  }

  const todayKey = getISTDateInputValue();
  // Same-calendar-month backdate rule (IST): already-worked weekends/holidays
  // earlier this month are requestable; previous-month dates are rejected.
  // Future dates stay allowed (pre-approval for planned work). The fully-
  // eligible-range check below still enforces weekend/holiday-only ranges.
  const firstOfMonthKey = `${todayKey.slice(0, 7)}-01`;
  if (payload.startDate < firstOfMonthKey) {
    throwError('Comp off can only be requested for dates within the current calendar month or future dates.');
  }

  const days = await assertRangeEligible(startDate, endDate);
  await assertNoLeaveOverlap(userId, startDate, endDate);

  const overlap = await CompOffRequest.findOne({
    userId,
    status: { $in: ACTIVE_STATUSES },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  }).select('_id');
  if (overlap) {
    throwError('You already have a comp off request overlapping this date range.', 409);
  }

  const submitTiming = provisionalTiming(LEAVE_SUBMIT_UNDO_WINDOW_MS);
  const [request] = await CompOffRequest.create([
    {
      userId,
      startDate,
      endDate,
      days,
      reason: payload.reason,
      status: 'pending',
      revision: 0,
      pendingRevision: null,
      undoExpiresAt: submitTiming.undoExpiresAt,
      notifyAfter: submitTiming.notifyAfter,
      finalizedAt: null,
    },
  ]);

  scheduleSubmitNotification(request._id.toString());
  await scheduleLeaveFinalize({
    requestId: request._id.toString(),
    kind: 'comp-off',
    notifyAfter: request.notifyAfter,
    revision: request.revision ?? 0,
  });
  auditLog('comp_off_requested', {
    userId: userId.toString(),
    requestId: request._id.toString(),
    days,
    startDate: payload.startDate,
    endDate: payload.endDate,
  });

  return (await CompOffRequest.findById(request._id).populate(COMP_OFF_REQUEST_POPULATE)).toSafeJSON();
}

async function notifyManagersOnSubmit(requester, request) {
  const applicantName = requester.name ?? 'An employee';
  const dateText = formatCompOffDateText(request);
  const link = '/admin/leave/comp-off';

  const managerIds = requesterManagerIds(requester);
  if (managerIds.length > 0) {
    const managers = await User.find({ _id: { $in: managerIds }, isActive: true }).select('name email mobile whatsappOptIn');
    const decisionLoginBaseUrl = `${env.apiOrigin}/api/leave/comp-off/decision-login`;
    await Promise.allSettled(
      managers.map(async (manager) => {
        await createNotification({
          userId: manager._id,
          type: 'comp_off_pending',
          title: 'New comp off request',
          body: `${applicantName} requested to work ${dateText} (${request.days} day(s)). Reason: ${request.reason}`,
          link,
          metadata: { requestId: request._id.toString() },
        });
        // Single-use Take Action link (mirrors the leave flow): the token is
        // peeked — not consumed — by the auto-login endpoint, and dies with
        // the request on decide/undo/withdraw.
        const token = await issueCompOffDecisionToken(request._id, manager._id, 'decide');
        const actionUrl = `${decisionLoginBaseUrl}?request=${request._id}&action=decide&token=${token}`;
        if (manager.email) {
          const { subject, html, text } = renderCompOffManagerEmail({
            applicantName,
            dateText,
            days: request.days,
            reason: request.reason,
            withActions: true,
            actionUrl,
          });
          await sendEmail({ to: manager.email, subject, html, text, tag: 'comp-off-manager' });
        }
        if (manager.mobile) {
          await sendSms({
            to: manager.mobile,
            message: `${applicantName} requested to work ${dateText} (${request.days} day(s)) for comp off. Take action: ${actionUrl}`,
          });
        }
      }),
    );
    return;
  }

  // No reporting manager/delegate assigned — fall back to admin/HR like leave.
  const adminRole = await Role.findOne({ slug: 'admin' });
  const hrRole = await Role.findOne({ slug: 'hr' });
  const roleIds = [adminRole?._id, hrRole?._id].filter(Boolean);
  const admins = await User.find({ isActive: true, roleId: { $in: roleIds } }).select('_id name email mobile');
  await Promise.allSettled(
    admins.map(async (admin) => {
      await createNotification({
        userId: admin._id,
        type: 'comp_off_pending_admin',
        title: 'Comp off request (no manager)',
        body: `${applicantName} requested comp off ${dateText} without a reporting manager assigned.`,
        link,
        metadata: { requestId: request._id.toString() },
      });
    }),
  );
}

/**
 * Final manager notification for a comp-off submission. Runs ONLY from the
 * finalizer path after the submit undo window expires. Applicant needs no
 * submit notice (they submitted it); only managers are notified.
 */
export async function dispatchCompOffSubmit(requestId, now = new Date()) {
  const key = String(requestId);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (pendingSubmitDispatch.has(key)) return;
  pendingSubmitDispatch.add(key);
  try {
    const request = await CompOffRequest.findById(requestId).populate(COMP_OFF_REQUEST_POPULATE);
    if (!request) return;
    if (
      request.status !== 'pending'
      || request.pendingAction
      || request.notificationsSent
      || request.submitNotificationsSent
    ) return;
    if (request.notifyAfter && new Date(request.notifyAfter).getTime() > nowMs) return;

    // Atomic claim FIRST so concurrent dispatchers deliver exactly once.
    const claimed = await CompOffRequest.findOneAndUpdate(
      {
        _id: request._id,
        status: 'pending',
        pendingAction: null,
        notificationsSent: false,
        submitNotificationsSent: { $ne: true },
      },
      { $set: { notificationsSent: true, submitNotificationsSent: true } },
    );
    if (!claimed) return;
    try {
      const requester = await loadRequester(request.userId?._id ?? request.userId);
      await notifyManagersOnSubmit(requester, request);
    } catch (err) {
      // Sending failed after the claim: release the claim so a later sweep
      // can retry instead of dropping the notification silently.
      await CompOffRequest.updateOne(
        { _id: request._id },
        { $set: { notificationsSent: false, submitNotificationsSent: false } },
      ).catch(() => {});
      console.error('[comp-off] submit notification send failed', key, err?.message);
      return;
    }
    auditLog('comp_off_submit_finalized', {
      userId: (request.userId?._id ?? request.userId)?.toString?.(),
      requestId: request._id.toString(),
    });
  } finally {
    pendingSubmitDispatch.delete(key);
  }
}

/**
 * Stages an employee withdrawal of a freshly submitted comp-off request
 * inside its undo window. The request stays `pending` with
 * `pendingAction: 'cancelled'` so the employee gets an Undo toast and can
 * still change their mind; only the finalizer flips it to `cancelled`
 * (silently). Same guards as before: withdraw is only possible before the
 * manager was notified — afterwards the request must run its course.
 */
export async function undoCompOffSubmit(requestId, actor) {
  const request = await loadCompOffRequest(requestId);
  const requesterId = request.userId?._id?.toString() ?? request.userId?.toString();
  if (requesterId !== actor._id.toString()) {
    throwError('You can only withdraw your own comp off requests.', 403);
  }

  const now = new Date();
  const stageTiming = provisionalTiming(LEAVE_DECISION_UNDO_MS, now.getTime());
  const claimed = await CompOffRequest.findOneAndUpdate(
    {
      _id: request._id,
      status: 'pending',
      pendingAction: null,
      notificationsSent: false,
      submitNotificationsSent: { $ne: true },
      undoExpiresAt: { $gt: now },
    },
    [
      {
        $set: {
          pendingAction: 'cancelled',
          decidedAt: now,
          approverId: null,
          decisionTokens: [],
          undoExpiresAt: stageTiming.undoExpiresAt,
          notifyAfter: stageTiming.notifyAfter,
          pendingRevision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
          finalizedAt: null,
          revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  );

  if (!claimed) {
    const current = await CompOffRequest.findById(request._id).select('status pendingAction notificationsSent submitNotificationsSent undoExpiresAt');
    if (!current || current.status !== 'pending') {
      throwError('This request can no longer be undone.', 409);
    }
    if (current.pendingAction) {
      throwError('A change is already pending. Undo it first to keep editing this request.', 409);
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

  await scheduleLeaveFinalize({
    requestId: request._id.toString(),
    kind: 'cancel',
    notifyAfter: stageTiming.notifyAfter,
    revision: claimed.revision,
  });

  auditLog('comp_off_withdraw_staged', {
    userId: actor._id.toString(),
    requestId: request._id.toString(),
    revision: claimed.revision,
  });

  return (await CompOffRequest.findById(request._id).populate(COMP_OFF_REQUEST_POPULATE)).toSafeJSON();
}

/**
 * Undoes a staged employee withdrawal inside its undo window, restoring the
 * request to a live pending request with a FRESH submit undo window (so the
 * manager is still notified afterwards — the withdrawal never happened as
 * far as anyone else is concerned). Owner-only. Silent: no notifications.
 */
export async function undoCompOffWithdraw(requestId, actor) {
  const request = await loadCompOffRequest(requestId);
  const requesterId = request.userId?._id?.toString() ?? request.userId?.toString();
  if (requesterId !== actor._id.toString()) {
    throwError('You can only undo your own comp off withdrawal.', 403);
  }
  if (request.pendingAction !== 'cancelled') {
    if (request.status !== 'pending' || request.finalizedAt) {
      throwError('The withdrawal is now final and cannot be undone.', 410);
    }
    throwError('No pending withdrawal to undo.', 400);
  }

  const now = new Date();
  const stagedRevision = request.revision ?? 0;
  const undoCutoff = request.undoExpiresAt
    ? new Date(request.undoExpiresAt)
    : new Date(new Date(request.decidedAt).getTime() + LEAVE_DECISION_UNDO_MS);
  const freshTiming = provisionalTiming(LEAVE_SUBMIT_UNDO_WINDOW_MS, now.getTime());

  const claimed = await CompOffRequest.findOneAndUpdate(
    {
      _id: request._id,
      status: 'pending',
      pendingAction: 'cancelled',
      revision: stagedRevision,
      $or: [
        { undoExpiresAt: { $gt: now } },
        { undoExpiresAt: null, decidedAt: { $gt: new Date(now.getTime() - LEAVE_DECISION_UNDO_MS) } },
      ],
    },
    {
      $set: {
        pendingAction: null,
        decidedAt: null,
        comment: null,
        undoExpiresAt: freshTiming.undoExpiresAt,
        notifyAfter: freshTiming.notifyAfter,
        pendingRevision: null,
        finalizedAt: null,
        notificationsSent: false,
        submitNotificationsSent: false,
        decisionTokens: [],
      },
      $inc: { revision: 1 },
    },
  );

  if (!claimed) {
    const current = await CompOffRequest.findById(request._id).select('pendingAction revision undoExpiresAt decidedAt status');
    if (!current || current.pendingAction !== 'cancelled' || (current.revision ?? 0) !== stagedRevision) {
      throwError('The withdrawal is now final and cannot be undone.', 410);
    }
    if (now >= undoCutoff) {
      throwError('The undo window has expired. The withdrawal is now final.', 410);
    }
    throwError('This withdrawal was already updated. Refresh and try again.', 409);
  }

  scheduleSubmitNotification(request._id.toString(), freshTiming.notifyAfter);
  await scheduleLeaveFinalize({
    requestId: request._id.toString(),
    kind: 'submit',
    notifyAfter: freshTiming.notifyAfter,
    revision: stagedRevision + 1,
  });

  auditLog('comp_off_withdraw_undone', {
    userId: actor._id.toString(),
    requestId: request._id.toString(),
  });

  return (await CompOffRequest.findById(request._id).populate(COMP_OFF_REQUEST_POPULATE)).toSafeJSON();
}

async function notifyCompOffApplicant({ request, status, remarks = null, creditedDays = 0, assessment = null, breakdown = [] }) {
  const userId = request.userId?._id?.toString?.() ?? request.userId?.toString?.();
  const applicant = await User.findById(userId).select('name email mobile whatsappOptIn');
  if (!applicant) return;
  const dateText = formatCompOffDateText(request);
  const safeRemarks = remarks || '';

  try {
    if (status === 'assessed') {
      await createNotification({
        userId,
        type: 'comp_off_assessed',
        title: 'Comp off credited',
        body: `Your comp off work on ${dateText} was assessed. +${creditedDays} day(s) added to your CO balance.`,
        link: '/employee/leave/comp-off',
        metadata: { requestId: request._id.toString(), creditedDays },
      });
      if (applicant.email) {
        const { subject, html, text } = renderCompOffAssessedEmail({
          dateText,
          creditedDays,
          assessment,
          breakdown,
        });
        await sendEmail({ to: applicant.email, subject, html, text, tag: 'comp-off-assessed' });
      }
      if (applicant.mobile) {
        await sendSms({
          to: applicant.mobile,
          message: `Your comp off work on ${dateText} was assessed. +${creditedDays} day(s) added to your CO balance.`,
        });
      }
      return;
    }

    await createNotification({
      userId,
      type: 'comp_off_decision',
      title: status === 'approved' ? 'Comp off approved' : 'Comp off rejected',
      body: `Your comp off work request for ${dateText} was ${status}.${safeRemarks ? ` Remarks: ${safeRemarks}` : ''}`,
      link: '/employee/leave/comp-off',
      metadata: { requestId: request._id.toString() },
    });
    if (applicant.email) {
      const { subject, html, text } = renderCompOffDecisionEmail({
        status,
        dateText,
        remarks: safeRemarks,
      });
      await sendEmail({ to: applicant.email, subject, html, text, tag: 'comp-off-status' });
    }
    if (applicant.mobile) {
      await sendSms({
        to: applicant.mobile,
        message: `Your comp off work request for ${dateText} was ${status}.${safeRemarks ? ' Remarks: ' + safeRemarks : ''}`,
      });
    }
  } catch (err) {
    console.error('[comp-off] applicant notification failed', request._id?.toString(), err?.message);
  }
}

/**
 * Stages an approve/reject decision. Nothing changes until the undo window
 * expires — the request stays pending and NO notification is sent. The atomic
 * pipeline claim resolves concurrent decisions to exactly one staged outcome
 * and binds it to the live revision.
 */
export async function decideCompOffRequest(requestId, actor, permissions, decision, payload = {}) {
  const request = await loadCompOffRequest(requestId);
  if (request.status !== 'pending') {
    throwError('Only pending comp off requests can be approved or rejected.');
  }
  if (request.pendingAction) {
    throwError('A decision is already pending. Undo it first before acting again.', 409);
  }

  const isApproved = decision === 'approve' || decision === 'approved';
  if (!isApproved && decision !== 'reject' && decision !== 'rejected') {
    throwError('Invalid comp off decision.', 400);
  }
  const comment = (payload.comment ?? '').trim() || null;
  if (!isApproved && !comment) {
    throwError('A remark is required for rejection.');
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to approve this comp off request.', 403);
  }

  const pendingAction = isApproved ? 'approved' : 'rejected';
  const stagedAt = new Date();
  const stageTiming = provisionalTiming(LEAVE_DECISION_UNDO_MS, stagedAt.getTime());
  const setUpdate = {
    pendingAction,
    approverId: actor._id,
    decidedAt: stagedAt,
    comment,
    undoExpiresAt: stageTiming.undoExpiresAt,
    notifyAfter: stageTiming.notifyAfter,
    notificationsSent: false,
    submitNotificationsSent: true,
    decisionTokens: [],
    finalizedAt: null,
  };

  const claimed = await CompOffRequest.findOneAndUpdate(
    { _id: request._id, status: 'pending', pendingAction: null },
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
    const current = await CompOffRequest.findById(request._id).select('status pendingAction');
    if (!current || current.status !== 'pending') {
      throwError('Only pending comp off requests can be approved or rejected.', 409);
    }
    throwError('A decision is already pending. Undo it first before acting again.', 409);
  }

  for (const [key, value] of Object.entries(setUpdate)) {
    request[key] = value;
  }
  request.revision = claimed.revision;
  request.pendingRevision = claimed.pendingRevision;

  await scheduleLeaveFinalize({
    requestId: request._id.toString(),
    kind: 'comp-off',
    notifyAfter: setUpdate.notifyAfter,
    revision: request.revision,
  });

  auditLog(isApproved ? 'comp_off_approved' : 'comp_off_rejected', {
    adminId: actor._id.toString(),
    userId: requester._id.toString(),
    requestId: request._id.toString(),
    comment,
    revision: request.revision,
  });

  return (await CompOffRequest.findById(request._id).populate(COMP_OFF_REQUEST_POPULATE)).toSafeJSON();
}

/**
 * Undoes a staged decision inside its undo window. Silent for the manager;
 * the applicant gets an in-app notice that the request moved back to pending.
 */
export async function undoCompOffDecision(requestId, actor, permissions) {
  const request = await loadCompOffRequest(requestId);
  // Staged employee withdrawals belong to undoCompOffWithdraw (owner-only);
  // a manager decision-undo must never clear them.
  if (!request.pendingAction || request.pendingAction === 'assessed' || request.pendingAction === 'cancelled') {
    if (request.status !== 'pending' || request.finalizedAt) {
      throwError('The decision is now final and can no longer be undone.', 410);
    }
    throwError('No pending comp off decision to undo.', 400);
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to undo this comp off decision.', 403);
  }

  const userId = requester._id;
  const now = new Date();
  const stagedRevision = request.revision ?? 0;
  const undoCutoff = request.undoExpiresAt
    ? new Date(request.undoExpiresAt)
    : new Date(new Date(request.decidedAt).getTime() + LEAVE_DECISION_UNDO_MS);

  const claimed = await CompOffRequest.findOneAndUpdate(
    {
      _id: request._id,
      pendingAction: request.pendingAction,
      revision: stagedRevision,
      $or: [
        { undoExpiresAt: { $gt: now } },
        { undoExpiresAt: null, decidedAt: { $gt: new Date(now.getTime() - LEAVE_DECISION_UNDO_MS) } },
      ],
    },
    {
      $set: {
        pendingAction: null,
        approverId: null,
        decidedAt: null,
        comment: null,
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
    const current = await CompOffRequest.findById(request._id).select('pendingAction revision undoExpiresAt decidedAt status');
    if (!current?.pendingAction || (current.revision ?? 0) !== stagedRevision) {
      throwError('The decision is now final and can no longer be undone.', 410);
    }
    if (now >= undoCutoff) {
      throwError('The undo window has expired. The decision is now final.', 410);
    }
    throwError('This decision was already updated. Refresh and try again.', 409);
  }

  await createNotification({
    userId: userId.toString(),
    type: 'comp_off_undone',
    title: 'Comp off decision undone',
    body: 'Your comp off request was moved back to pending for review.',
    link: '/employee/leave/comp-off',
    metadata: { requestId: request._id.toString() },
  });

  auditLog('comp_off_decision_undone', {
    adminId: actor._id.toString(),
    userId: userId.toString(),
    requestId: request._id.toString(),
  });

  return (await CompOffRequest.findById(request._id).populate(COMP_OFF_REQUEST_POPULATE)).toSafeJSON();
}

/**
 * IST day keys covered by a request, inclusive. The request range is fully
 * eligible by construction (creation enforces it), so these are exactly the
 * days an assessment must rate.
 */
export function listRequestDayKeys(request) {
  // NB: getISTDateInputValue defaults missing input to today, so validate
  // the RAW values first — otherwise garbage in yields a bogus single day.
  const rawStart = request?.startDate;
  const rawEnd = request?.endDate;
  if (rawStart == null || rawEnd == null) return [];
  const startKey = getISTDateInputValue(rawStart);
  const endKey = getISTDateInputValue(rawEnd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(endKey ?? '')) return [];
  const keys = [];
  let cursor = parseDateInputAsISTDay(startKey);
  const end = parseDateInputAsISTDay(endKey);
  while (cursor && end && cursor.getTime() <= end.getTime()) {
    keys.push(getISTDateInputValue(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return keys;
}

/**
 * Normalizes assessment input to the canonical per-day form
 * [{ dayKey, assessment }]. Accepts either a single rate string (applied to
 * every day — the legacy form, kept for backward compatibility) or an
 * explicit per-day array, which must then cover EXACTLY the request's days:
 * no missing days, no out-of-range days, no duplicates, valid rates only.
 */
export function normalizeDayAssessments(request, assessment, assessments) {
  const expected = listRequestDayKeys(request);
  if (assessments != null) {
    if (!Array.isArray(assessments) || assessments.length === 0) {
      throwError('Invalid comp off assessment.', 400);
    }
    const seen = new Set();
    const normalized = assessments.map((entry) => {
      const dayKey = String(entry?.date ?? '').trim();
      const rate = entry?.assessment;
      if (!expected.includes(dayKey)) {
        throwError(`Assessment date ${dayKey || '—'} is outside this request's worked days.`, 400);
      }
      if (!(rate in ASSESSMENT_RATE)) {
        throwError('Invalid comp off assessment.', 400);
      }
      if (seen.has(dayKey)) {
        throwError(`Duplicate assessment for ${dayKey}.`, 400);
      }
      seen.add(dayKey);
      return { dayKey, assessment: rate };
    });
    const missing = expected.filter((key) => !seen.has(key));
    if (missing.length > 0) {
      throwError(`Assessment missing for worked day(s): ${missing.join(', ')}.`, 400);
    }
    return normalized.sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1));
  }
  if (!(assessment in ASSESSMENT_RATE)) {
    throwError('Invalid comp off assessment.', 400);
  }
  return expected.map((dayKey) => ({ dayKey, assessment }));
}

/** Per-day credit: Σ (1 day × rate), kept at 0.5 granularity. */
export function computeDayAssessmentsCredit(dayAssessments) {
  const total = (dayAssessments ?? []).reduce(
    (sum, entry) => sum + (ASSESSMENT_RATE[entry?.assessment] ?? 0),
    0,
  );
  return roundHalf(total);
}

/**
 * Stages a work assessment on a `worked` request. Requires the employee to
 * have checked out on the approved day(s). Credit is granted ONLY after the
 * assessment undo window expires (see finalizeCompOffAction).
 */
export async function assessCompOffWork(requestId, actor, permissions, assessment, payload = {}) {
  const request = await loadCompOffRequest(requestId);
  if (request.status !== 'worked') {
    throwError('Comp off can only be assessed after the employee has checked out.', 409);
  }
  if (request.pendingAction) {
    throwError('An assessment is already pending. Undo it first before assessing again.', 409);
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to assess this comp off request.', 403);
  }

  // Canonical per-day form (single-rate input fans out to every worked day).
  const dayAssessments = normalizeDayAssessments(request, assessment, payload.assessments);
  const uniformRate = dayAssessments.every((entry) => entry.assessment === dayAssessments[0].assessment)
    ? dayAssessments[0].assessment
    : null;

  const comment = (payload.comment ?? '').trim() || null;
  const stagedAt = new Date();
  const stageTiming = provisionalTiming(LEAVE_DECISION_UNDO_MS, stagedAt.getTime());
  const setUpdate = {
    pendingAction: 'assessed',
    pendingAssessment: uniformRate,
    pendingDayAssessments: dayAssessments,
    approverId: actor._id,
    decidedAt: stagedAt,
    comment,
    undoExpiresAt: stageTiming.undoExpiresAt,
    notifyAfter: stageTiming.notifyAfter,
    notificationsSent: false,
    submitNotificationsSent: true,
    finalizedAt: null,
  };

  const claimed = await CompOffRequest.findOneAndUpdate(
    { _id: request._id, status: 'worked', pendingAction: null },
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
    const current = await CompOffRequest.findById(request._id).select('status pendingAction');
    if (!current || current.status !== 'worked') {
      throwError('Comp off can only be assessed after the employee has checked out.', 409);
    }
    throwError('An assessment is already pending. Undo it first before assessing again.', 409);
  }

  for (const [key, value] of Object.entries(setUpdate)) {
    request[key] = value;
  }
  request.revision = claimed.revision;
  request.pendingRevision = claimed.pendingRevision;

  await scheduleLeaveFinalize({
    requestId: request._id.toString(),
    kind: 'comp-off',
    notifyAfter: setUpdate.notifyAfter,
    revision: request.revision,
  });

  auditLog('comp_off_assess_staged', {
    adminId: actor._id.toString(),
    userId: requester._id.toString(),
    requestId: request._id.toString(),
    dayAssessments,
    comment,
    revision: request.revision,
  });

  return (await CompOffRequest.findById(request._id).populate(COMP_OFF_REQUEST_POPULATE)).toSafeJSON();
}

/** Undoes a staged assessment inside its undo window. Credit never moved, so nothing to reverse. */
export async function undoCompOffAssessment(requestId, actor, permissions) {
  const request = await loadCompOffRequest(requestId);
  if (request.pendingAction !== 'assessed') {
    if (request.status !== 'worked' || request.finalizedAt) {
      throwError('The assessment is now final and can no longer be undone.', 410);
    }
    throwError('No pending comp off assessment to undo.', 400);
  }

  const requester = await loadRequester(request.userId?._id ?? request.userId);
  if (!canApproveLeave(actor, requester, permissions)) {
    throwError('You are not authorized to undo this comp off assessment.', 403);
  }

  const userId = requester._id;
  const now = new Date();
  const stagedRevision = request.revision ?? 0;
  const undoCutoff = request.undoExpiresAt
    ? new Date(request.undoExpiresAt)
    : new Date(new Date(request.decidedAt).getTime() + LEAVE_DECISION_UNDO_MS);

  const claimed = await CompOffRequest.findOneAndUpdate(
    {
      _id: request._id,
      pendingAction: 'assessed',
      revision: stagedRevision,
      $or: [
        { undoExpiresAt: { $gt: now } },
        { undoExpiresAt: null, decidedAt: { $gt: new Date(now.getTime() - LEAVE_DECISION_UNDO_MS) } },
      ],
    },
    {
      $set: {
        pendingAction: null,
        pendingAssessment: null,
        pendingDayAssessments: [],
        approverId: null,
        decidedAt: null,
        comment: null,
        notifyAfter: null,
        undoExpiresAt: null,
        pendingRevision: null,
        notificationsSent: false,
        submitNotificationsSent: true,
      },
      $inc: { revision: 1 },
    },
  );

  if (!claimed) {
    const current = await CompOffRequest.findById(request._id).select('pendingAction revision undoExpiresAt decidedAt status');
    if (current?.pendingAction !== 'assessed' || (current.revision ?? 0) !== stagedRevision) {
      throwError('The assessment is now final and can no longer be undone.', 410);
    }
    if (now >= undoCutoff) {
      throwError('The undo window has expired. The assessment is now final.', 410);
    }
    throwError('This assessment was already updated. Refresh and try again.', 409);
  }

  await createNotification({
    userId: userId.toString(),
    type: 'comp_off_undone',
    title: 'Comp off assessment undone',
    body: 'Your comp off assessment was undone and is awaiting reassessment.',
    link: '/employee/leave/comp-off',
    metadata: { requestId: request._id.toString() },
  });

  auditLog('comp_off_assess_undone', {
    adminId: actor._id.toString(),
    userId: userId.toString(),
    requestId: request._id.toString(),
  });

  return (await CompOffRequest.findById(request._id).populate(COMP_OFF_REQUEST_POPULATE)).toSafeJSON();
}

/**
 * Credit helper: grants comp-off credit to the CO balance for the WORKED year
 * (getISTYear(startDate)). Runs inside the finalizer transaction — the CO
 * balance is ensured beforehand so the txn only increments `compOffEarned`.
 */
async function creditCompOffDays(userId, creditedDays, year, session) {
  if (creditedDays <= 0) return;
  const coType = await LeaveType.findOne({ code: COMP_OFF_LEAVE_TYPE_CODE, isActive: true }).select('_id');
  if (!coType) {
    throw new Error('CO leave type is inactive; comp off credit deferred.');
  }
  const balanceQuery = LeaveBalance.findOne({ userId, leaveTypeId: coType._id, year });
  if (session) balanceQuery.session(session);
  const balance = await balanceQuery;
  if (!balance) {
    throw new Error('CO leave balance not found; comp off credit deferred.');
  }
  balance.compOffEarned = (balance.compOffEarned ?? 0) + creditedDays;
  await balance.save({ session });
}

/**
 * Finalizes ONE staged comp-off action (decision or assessment) after its undo
 * window expired. Single transaction commits state + flags + credit atomically;
 * notifications go out ONLY after the commit.
 */
export async function finalizeCompOffAction(request) {
  const decision = request.pendingAction;
  const requestKey = request._id.toString();
  const userId = request.userId?._id ?? request.userId;

  let creditedDays = 0;
  let workedYear = null;
  let assessmentBreakdown = [];
  if (decision === 'assessed') {
    workedYear = getISTYear(request.startDate);
    // Canonical per-day form; legacy single-rate stages (in-flight from
    // before this change) fan out across the request's days.
    const stagedDays = (request.pendingDayAssessments ?? []).length > 0
      ? request.pendingDayAssessments
      : listRequestDayKeys(request).map((dayKey) => ({
          dayKey,
          assessment: request.pendingAssessment ?? 'none',
        }));
    assessmentBreakdown = stagedDays.map((entry) => ({
      dayKey: entry.dayKey,
      assessment: entry.assessment,
      credit: ASSESSMENT_RATE[entry.assessment] ?? 0,
    }));
    creditedDays = computeDayAssessmentsCredit(stagedDays);
    // Ensure the CO balance exists BEFORE the transaction (matches the leave
    // flow: ensure/accrual writes run outside the state txn). If the CO type
    // or policy is inactive, ensureBalancesForUser creates no balance and the
    // transaction below fails cleanly → the item lands in the sweep `failed`
    // list and is retried next sweep (never half-credits).
    await ensureBalancesForUser(userId, workedYear);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const live = await CompOffRequest.findOne({
        _id: request._id,
        pendingAction: decision,
        ...(request.pendingRevision != null ? { revision: request.pendingRevision } : {}),
      }).session(session);
      if (!live) {
        throw Object.assign(new Error('Stale provisional action; superseded before finalize.'), { code: 'STALE_PROVISIONAL' });
      }

      if (decision === 'assessed') {
        live.creditedDays = creditedDays;
        live.assessmentBreakdown = assessmentBreakdown;
        await creditCompOffDays(userId, creditedDays, workedYear, session);
      }

      live.status = decision;
      live.pendingAction = null;
      live.pendingAssessment = null;
      live.pendingDayAssessments = [];
      live.pendingRevision = null;
      live.notifyAfter = null;
      live.undoExpiresAt = null;
      live.notificationsSent = true;
      live.finalizedAt = new Date();
      live.revision = (live.revision ?? 0) + 1;
      await live.save({ session });
    });
  } catch (err) {
    if (err?.code === 'STALE_PROVISIONAL') {
      return { finalized: false, stale: true, requestId: requestKey };
    }
    throw err;
  } finally {
    session.endSession();
  }

  // Deferred notification — post-commit only, never blocking finality.
  // A finalized employee withdrawal is silent by design (nobody was ever
  // notified while it was provisional): no email, SMS, or in-app notice.
  if (decision === 'cancelled') {
    auditLog('comp_off_withdrawn', {
      userId: userId?.toString?.(),
      requestId: requestKey,
      revision: (request.revision ?? 0) + 1,
    });
    return { finalized: true, requestId: requestKey };
  }
  try {
    if (decision === 'assessed') {
      await notifyCompOffApplicant({
        request,
        status: 'assessed',
        creditedDays,
        assessment: assessmentBreakdown.every((entry) => entry.assessment === assessmentBreakdown[0]?.assessment)
          ? (assessmentBreakdown[0]?.assessment ?? 'none')
          : 'mixed',
        breakdown: assessmentBreakdown,
      });
    } else {
      await notifyCompOffApplicant({
        request,
        status: decision === 'approved' ? 'approved' : 'rejected',
        remarks: request.comment,
      });
    }
  } catch (notifyErr) {
    console.error('[comp-off] finalized notification failed', {
      requestId: requestKey,
      decision,
      error: notifyErr?.message,
    });
    auditLog('comp_off_finalized_notification_failed', {
      requestId: requestKey,
      decision,
      error: notifyErr?.message ?? 'unknown',
    });
  }

  auditLog('comp_off_finalized', {
    userId: userId?.toString?.(),
    requestId: requestKey,
    decision,
    creditedDays,
    revision: (request.revision ?? 0) + 1,
  });

  return { finalized: true, requestId: requestKey };
}

/**
 * Lapses approved comp-off requests whose holiday(s) passed with no check-in.
 * Boundary: endDate strictly before start-of-yesterday IST (holiday + the day
 * after have fully elapsed). SILENT — no notifications of any kind.
 */
export async function lapseStaleCompOff(now = new Date()) {
  const startOfYesterday = new Date(startOfDayIST(now).getTime() - 24 * 60 * 60 * 1000);
  const candidates = await CompOffRequest.find({
    status: 'approved',
    endDate: { $lt: startOfYesterday },
  }).select('_id userId startDate endDate');

  let lapsed = 0;
  const skippedWithCheckIn = [];
  for (const request of candidates) {
    const userId = request.userId?._id ?? request.userId;
    const checkIn = await AttendanceRecord.findOne({
      userId,
      type: 'check_in',
      status: 'allowed',
      timestamp: { $gte: startOfDayIST(request.startDate), $lte: endOfDayIST(request.endDate) },
    }).select('_id');
    if (checkIn) {
      // Employee did check in on the comp-off day — keep the request open
      // (credit path runs through check-out → worked → assessment).
      skippedWithCheckIn.push(request._id.toString());
      continue;
    }
    await CompOffRequest.updateOne({ _id: request._id, status: 'approved' }, {
      $set: {
        status: 'lapsed',
        pendingAction: null,
        pendingRevision: null,
        notifyAfter: null,
        undoExpiresAt: null,
        finalizedAt: new Date(),
        notificationsSent: true,
        submitNotificationsSent: true,
      },
      $inc: { revision: 1 },
    });
    auditLog('comp_off_lapsed', {
      userId: userId?.toString?.(),
      requestId: request._id.toString(),
    });
    lapsed += 1;
  }
  return { lapsed, skippedWithCheckIn };
}

/**
 * Comp-off portion of the universal finalizer sweep: staged decisions/
 * assessments due for finalize + submit-due dispatches + lapse pass.
 * Per-item isolation matches the leave sweep conventions.
 */
export async function runCompOffSweep(now = new Date()) {
  const dueDecisions = await CompOffRequest.find({
    pendingAction: { $ne: null },
    notifyAfter: { $ne: null, $lte: now },
    notificationsSent: false,
  }).populate(COMP_OFF_REQUEST_POPULATE);
  const dueSubmits = await CompOffRequest.find({
    status: 'pending',
    pendingAction: null,
    submitNotificationsSent: { $ne: true },
    notificationsSent: false,
    notifyAfter: { $ne: null, $lte: now },
  }).select('_id');

  let processed = 0;
  let submitNotified = 0;
  const skippedStale = [];
  const failed = [];

  for (const request of dueDecisions) {
    const requestKey = request._id.toString();
    try {
      if (request.pendingRevision != null && (request.revision ?? 0) !== request.pendingRevision) {
        skippedStale.push(requestKey);
        continue;
      }
      const result = await finalizeCompOffAction(request);
      if (result.stale) {
        skippedStale.push(requestKey);
        continue;
      }
      processed += 1;
    } catch (err) {
      if (err?.code === 'STALE_PROVISIONAL') {
        skippedStale.push(requestKey);
        continue;
      }
      console.error('[comp-off] finalize failed', requestKey, err?.message);
      failed.push({ requestId: requestKey, error: err?.message });
    }
  }

  for (const stub of dueSubmits) {
    try {
      await dispatchCompOffSubmit(stub._id, now);
      submitNotified += 1;
    } catch (err) {
      console.error('[comp-off] submit sweep failed', stub._id?.toString(), err?.message);
      failed.push({ requestId: stub._id?.toString(), error: err?.message });
    }
  }

  let lapse = null;
  try {
    lapse = await lapseStaleCompOff(now);
  } catch (err) {
    console.error('[comp-off] lapse sweep failed', err?.message);
    failed.push({ requestId: 'lapse', error: err?.message });
  }

  return { processed, submitNotified, skippedStale, failed, lapse, runAt: now.toISOString() };
}

/**
 * Lists comp-off requests. `mine` = requester's own requests. `approvals` =
 * requests the actor can act on (requires LEAVE_APPROVE; scoped to own reports
 * unless the actor has LEAVE_READ_ALL).
 */
export async function listCompOffRequests(actor, permissions, query) {
  const filter = {};
  const scope = query.scope ?? 'mine';

  if (scope === 'approvals') {
    if (!hasPermission(permissions, PERMISSIONS.LEAVE_APPROVE)) {
      throwError('You do not have permission to view the comp off approval queue.', 403);
    }
    if (!hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
      const reportIds = await resolveLeaveApprovalUserIds(actor);
      filter.userId = { $in: reportIds };
    }
  } else {
    filter.userId = actor._id;
  }

  if (query.userId) {
    // An explicit userId filter must never widen the caller's scope: plain
    // employees may only ever see their own requests; approvers only their
    // reports (unless LEAVE_READ_ALL). Without this, any LEAVE_READ holder
    // could read anyone's requests via ?userId=.
    if (!hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
      if (scope !== 'approvals') {
        if (String(query.userId) !== String(actor._id)) {
          throwError('You can only view your own comp off requests.', 403);
        }
      } else {
        const reportIds = await resolveLeaveApprovalUserIds(actor);
        if (!reportIds.map(String).includes(String(query.userId))) {
          throwError("You are not authorized to view this user's comp off requests.", 403);
        }
      }
    }
    filter.userId = query.userId;
  }
  // Virtual queue: 'closed' covers every terminal non-credited outcome with
  // real server-side pagination (rejected + lapsed + cancelled).
  if (query.status && query.status !== 'all') {
    filter.status = query.status === 'closed'
      ? { $in: ['rejected', 'lapsed', 'cancelled'] }
      : query.status;
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
      ? { decidedAt: -1, createdAt: -1, _id: -1 }
      : { createdAt: -1, _id: -1 };
  const [requests, total] = await Promise.all([
    CompOffRequest.find(filter)
      .populate(COMP_OFF_REQUEST_POPULATE)
      .sort(sort)
      .skip(skip)
      .limit(query.limit),
    CompOffRequest.countDocuments(filter),
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

/**
 * Single comp-off request with the same visibility rules as the list:
 * owner, or approver-scope (reporting chain), or LEAVE_READ_ALL.
 */
export async function getCompOffRequest(requestId, actor, permissions) {
  const request = await loadCompOffRequest(requestId);
  const requesterId = request.userId?._id?.toString() ?? request.userId?.toString();
  if (requesterId === actor._id.toString()) {
    return request.toSafeJSON();
  }
  if (hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL)) {
    return request.toSafeJSON();
  }
  if (hasPermission(permissions, PERMISSIONS.LEAVE_APPROVE)) {
    const requester = await loadRequester(request.userId?._id ?? request.userId);
    if (canApproveLeave(actor, requester, permissions)) {
      return request.toSafeJSON();
    }
  }
  throwError('You do not have permission to view this comp off request.', 403);
}

/**
 * Pending-assessment count for the dashboard button (status `worked` in the
 * approvals scope). Non-approvers get { count: 0 } instead of a 403 so the
 * employee dashboard simply shows no button.
 */
export async function getCompOffApprovalsCount(actor, permissions) {
  if (!hasPermission(permissions, PERMISSIONS.LEAVE_APPROVE)) {
    return { count: 0 };
  }
  const result = await listCompOffRequests(actor, permissions, {
    scope: 'approvals',
    status: 'worked',
    page: 1,
    limit: 1,
  });
  return { count: result.pagination.total };
}

/**
 * Pending comp-off counts for badges/KPIs: `pending` (awaiting approve/reject)
 * and `assessment` (worked, awaiting assessment). Scoped like the list;
 * non-approvers get zeros.
 */
export async function getCompOffPendingCounts(actor, permissions) {
  if (!hasPermission(permissions, PERMISSIONS.LEAVE_APPROVE)) {
    return { pending: 0, assessment: 0 };
  }
  const [pendingResult, workedResult] = await Promise.all([
    listCompOffRequests(actor, permissions, { scope: 'approvals', status: 'pending', page: 1, limit: 1 }),
    listCompOffRequests(actor, permissions, { scope: 'approvals', status: 'worked', page: 1, limit: 1 }),
  ]);
  return { pending: pendingResult.pagination.total, assessment: workedResult.pagination.total };
}
