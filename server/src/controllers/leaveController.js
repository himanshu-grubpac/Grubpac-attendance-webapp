import { LeaveType } from '../models/LeaveType.js';
import { LeavePolicy, LEAVE_POLICY_POPULATE } from '../models/LeavePolicy.js';
import { Holiday } from '../models/Holiday.js';
import { HolidayCategory } from '../models/HolidayCategory.js';
import { User } from '../models/User.js';
import {
  createLeavePolicySchema,
  createLeaveRequestSchema,
  createLeaveTypeSchema,
  adjustLeaveBalanceSchema,
  carryForwardSchema,
  carryForwardPreviewQuerySchema,
  encashLeaveSchema,
  leaveBalanceQuerySchema,
  leaveDecisionSchema,
  leavePolicyQuerySchema,
  leaveRequestQuerySchema,
  previewLeaveDaysQuerySchema,
  teamCalendarQuerySchema,
  updateLeavePolicySchema,
  updateLeaveTypeSchema,
} from '../../../shared/validation/leave.js';
import {
  createHolidaySchema,
  createHolidayCategorySchema,
  holidayQuerySchema,
  materializeRecurringSchema,
  recurringHolidayRulesSchema,
  updateHolidayCategorySchema,
  updateHolidaySchema,
} from '../../../shared/validation/holidays.js';
import { parseDateInputAsISTDay, getISTYear } from '../utils/istDate.js';
import { auditLog } from '../utils/auditLog.js';
import { signToken } from '../middleware/auth.js';
import { env } from '../config/env.js';
import {
  getRecurringHolidayRules,
  materializeRecurringHolidaysForYear,
  saveRecurringHolidayRules,
} from '../services/recurringHolidayService.js';
import { runMonthlyAccrualJob } from '../jobs/leaveJobs.js';
import {
  adjustBalance,
  applyYearEndCarryForward,
  getBalancesForUser,
  ensureBalancesForUser,
  previewYearEndCarryForward,
  recordEncashment,
} from '../services/leaveBalanceService.js';
import {
  cancelLeaveRequest,
  cancelApprovedLeaveByApprover,
  createLeaveRequest,
  decideLeaveRequest,
  decideLeaveRequestByToken,
  undoLeaveCancellation,
  undoLeaveDecision,
  editLeaveRequest,
  dispatchSubmitNotifications,
  undoSubmittedLeaveRequest,
  peekLeaveDecisionToken,
  autoLoginByDecisionToken,
  formatLeaveDateText,
  getTeamCalendar,
  listLeaveRequests,
  loadLeaveRequest,
  previewLeaveDays,
} from '../services/leaveService.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

export async function listLeaveTypes(req, res) {
  const types = await LeaveType.find().sort({ code: 1 });
  res.json({ types: types.map((item) => item.toSafeJSON()) });
}

export async function createLeaveType(req, res) {
  const parsed = createLeaveTypeSchema.parse(req.body);
  const existing = await LeaveType.findOne({ code: parsed.code });
  if (existing) {
    return res.status(409).json({ message: 'Leave type code already exists.' });
  }

  const leaveType = await LeaveType.create(parsed);
  auditLog('leave_type_created', {
    adminId: req.user._id.toString(),
    leaveTypeId: leaveType._id.toString(),
    code: leaveType.code,
  });
  res.status(201).json({ type: leaveType.toSafeJSON() });
}

export async function updateLeaveType(req, res) {
  const parsed = updateLeaveTypeSchema.parse(req.body);
  const leaveType = await LeaveType.findById(req.params.id);
  if (!leaveType) {
    return res.status(404).json({ message: 'Leave type not found.' });
  }

  if (parsed.name !== undefined) leaveType.name = parsed.name;
  if (parsed.isActive !== undefined) leaveType.isActive = parsed.isActive;
  await leaveType.save();

  res.json({ type: leaveType.toSafeJSON() });
}

export async function listLeavePolicies(req, res) {
  const parsed = leavePolicyQuerySchema.parse(req.query);
  const year = parsed.year ?? getISTYear();
  const currentYear = getISTYear();
  const yearFilter =
    year === currentYear
      ? { $or: [{ year }, { year: { $exists: false } }, { year: null }] }
      : { year };
  const policies = await LeavePolicy.find(yearFilter)
    .populate(LEAVE_POLICY_POPULATE)
    .sort({ createdAt: 1 });
  res.json({ year, policies: policies.map((item) => item.toSafeJSON()) });
}

export async function createLeavePolicy(req, res) {
  const parsed = createLeavePolicySchema.parse(req.body);
  const year = parsed.year ?? getISTYear();
  const leaveType = await LeaveType.findById(parsed.leaveTypeId);
  if (!leaveType) {
    return res.status(400).json({ message: 'Leave type not found.' });
  }

  const existing = await LeavePolicy.findOne({ leaveTypeId: parsed.leaveTypeId, year });
  if (existing) {
    return res.status(409).json({ message: 'Policy already exists for this leave type and year.' });
  }

  const policy = await LeavePolicy.create({ ...parsed, year });
  await policy.populate(LEAVE_POLICY_POPULATE);
  auditLog('leave_policy_created', {
    adminId: req.user._id.toString(),
    policyId: policy._id.toString(),
    year,
  });
  res.status(201).json({ policy: policy.toSafeJSON() });
}

export async function updateLeavePolicy(req, res) {
  const parsed = updateLeavePolicySchema.parse(req.body);
  const policy = await LeavePolicy.findById(req.params.id);
  if (!policy) {
    return res.status(404).json({ message: 'Leave policy not found.' });
  }

  Object.assign(policy, parsed);
  await policy.save();
  await policy.populate(LEAVE_POLICY_POPULATE);

  auditLog('leave_policy_updated', {
    adminId: req.user._id.toString(),
    policyId: policy._id.toString(),
  });

  res.json({ policy: policy.toSafeJSON() });
}

export async function getMyLeaveBalances(req, res) {
  const year = req.query.year ? Number(req.query.year) : getISTYear();
  const balances = await getBalancesForUser(req.user._id, year);
  res.json({ year, balances });
}

export async function getLeaveBalances(req, res) {
  const parsed = leaveBalanceQuerySchema.parse(req.query);
  const userId = parsed.userId ?? req.user._id.toString();
  const year = parsed.year ?? getISTYear();
  const balances = await getBalancesForUser(userId, year);
  res.json({ userId, year, balances });
}

export async function adjustLeaveBalances(req, res) {
  const parsed = adjustLeaveBalanceSchema.parse(req.body);
  const result = await adjustBalance(req.params.userId, parsed, req.user._id);

  auditLog('leave_balance_adjusted', {
    adminId: req.user._id.toString(),
    userId: req.params.userId,
    leaveTypeId: parsed.leaveTypeId,
    year: parsed.year,
    reason: parsed.reason,
  });

  res.json(result);
}

export async function createLeaveRequestHandler(req, res) {
  const parsed = createLeaveRequestSchema.parse(req.body);
  const request = await createLeaveRequest(req.user._id, parsed);
  res.status(201).json({ request });
}

export async function listLeaveRequestsHandler(req, res) {
  const parsed = leaveRequestQuerySchema.parse(req.query);
  const result = await listLeaveRequests(req.user, req.userPermissions, parsed);
  res.json(result);
}

export async function getLeaveRequestHandler(req, res) {
  const request = await loadLeaveRequest(req.params.id);
  const requesterId = request.userId?._id?.toString() ?? request.userId?.toString();
  const isOwner = requesterId === req.user._id.toString();
  const canViewAll = req.userPermissions.includes('leave.read_all');
  const canViewTeam = req.userPermissions.includes('leave.read_team');

  if (isOwner || canViewAll) {
    return res.json({ request: request.toSafeJSON() });
  }

  if (canViewTeam || req.userPermissions.includes('leave.approve')) {
    const requester = await User.findById(requesterId);
    if (requester?.reportingManagerId?.toString() === req.user._id.toString()) {
      return res.json({ request: request.toSafeJSON() });
    }
  }

  throwError('You do not have permission to view this request.', 403);
}

export async function previewLeaveRequestDays(req, res) {
  const parsed = previewLeaveDaysQuerySchema.parse(req.query);
  const preview = await previewLeaveDays(parsed.startDate, parsed.endDate, parsed.halfDay ?? null);
  res.json(preview);
}

export async function cancelLeaveRequestHandler(req, res) {
  const request = await cancelLeaveRequest(req.params.id, req.user);
  res.json({ request });
}

export async function editLeaveRequestHandler(req, res) {
  const request = await editLeaveRequest(req.params.id, req.user, req.body);
  res.json({ request });
}

export async function notifyLeaveRequestHandler(req, res) {
  await dispatchSubmitNotifications(req.params.id);
  res.json({ ok: true });
}

export async function undoSubmittedLeaveRequestHandler(req, res) {
  const request = await undoSubmittedLeaveRequest(req.params.id, req.user);
  res.json({ request });
}

export async function cancelApprovedLeaveByApproverHandler(req, res) {
  const request = await cancelApprovedLeaveByApprover(
    req.params.id,
    req.user,
    req.userPermissions,
    { decisionComment: req.body?.comment ?? null },
  );
  res.json({ request });
}

export async function undoLeaveCancellationHandler(req, res) {
  const request = await undoLeaveCancellation(
    req.params.id,
    req.user,
    req.userPermissions,
  );
  res.json({ request });
}

export async function approveLeaveRequestHandler(req, res) {
  const parsed = leaveDecisionSchema.parse(req.body ?? {});
  const request = await decideLeaveRequest(
    req.params.id,
    req.user,
    req.userPermissions,
    'approved',
    parsed,
  );
  res.json({ request });
}

export async function rejectLeaveRequestHandler(req, res) {
  const parsed = leaveDecisionSchema.parse(req.body ?? {});
  const request = await decideLeaveRequest(
    req.params.id,
    req.user,
    req.userPermissions,
    'rejected',
    parsed,
  );
  res.json({ request });
}
export async function undoLeaveDecisionHandler(req, res) {
  const request = await undoLeaveDecision(
    req.params.id,
    req.user,
    req.userPermissions,
  );
  res.json({ request });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decisionLinkHtml(success, message, portalUrl) {
  const color = success ? '#16a34a' : '#dc2626';
  const title = success ? 'Action complete' : 'Unable to process';
  const safeMessage = escapeHtml(message);
  const safePortalUrl = escapeHtml(portalUrl);
  const portalLink = success && portalUrl
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;"><a href="${safePortalUrl}" style="color:#1d4ed8;text-decoration:none;">Open in Admin Portal &rarr;</a></p>`
    : '';
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:32px 24px;">
            <h1 style="margin:0 0 12px;font-size:20px;color:${color};">${title}</h1>
            <p style="margin:0;font-size:15px;line-height:1.5;">${safeMessage}</p>
            ${portalLink}
            <p style="margin:${success ? '12' : '20'}px 0 0;font-size:13px;line-height:1.5;color:#6b7280;">You can close this tab. If the request was approved or rejected, the employee has been notified by email and SMS.</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function decisionConfirmHtml(action, token, requestId, leaveDetails = {}) {
  const verb = action === 'approve' ? 'APPROVE' : 'REJECT';
  const color = action === 'approve' ? '#16a34a' : '#dc2626';
  const { requesterName, leaveTypeName, dateText, reason, portalUrl } = leaveDetails;
  const safeRequesterName = escapeHtml(requesterName);
  const safeLeaveTypeName = escapeHtml(leaveTypeName || '—');
  const safeDateText = escapeHtml(dateText || '—');
  const safeReason = escapeHtml(reason || '—');
  const safeRequestId = escapeHtml(requestId);
  const safeAction = escapeHtml(action);
  const safeToken = escapeHtml(token);
  const safePortalUrl = escapeHtml(portalUrl);
  const detailsHtml = requesterName
    ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:0 0 20px;">
        <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Employee:</strong> ${safeRequesterName}</p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Leave Type:</strong> ${safeLeaveTypeName}</p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${safeDateText}</p>
        <p style="margin:0;font-size:14px;line-height:1.5;"><strong>Reason:</strong> ${safeReason}</p>
      </div>`
    : '';
  const commentField = `<label style="display:block;margin:0 0 16px;font-size:14px;line-height:1.5;font-weight:600;">Remark (required)
                <textarea name="comment" required maxlength="500" rows="3" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px;border:1px solid #d1d5db;border-radius:8px;font:inherit;"></textarea>
              </label>`;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:32px 24px;">
            <h1 style="margin:0 0 12px;font-size:20px;color:${color};">Confirm: ${verb} leave request</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">You opened this link from your email. Review the details below and confirm to ${action} this request.</p>
            ${detailsHtml}
            <form method="POST" action="/api/leave/decision-link" style="margin:0 0 12px;">
              <input type="hidden" name="request" value="${safeRequestId}" />
              <input type="hidden" name="action" value="${safeAction}" />
              <input type="hidden" name="token" value="${safeToken}" />
              ${commentField}
              <button type="submit" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border:0;border-radius:8px;cursor:pointer;">Confirm ${verb}</button>
            </form>
            ${portalUrl ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;"><a href="${safePortalUrl}" style="color:#1d4ed8;text-decoration:none;">Open in Admin Portal &rarr;</a></p>` : ''}
            <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#6b7280;">If you did not expect this, simply close the tab. Nothing has been changed yet.</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export async function leaveDecisionLinkPageHandler(req, res) {
  const { request, action, token } = req.query;
  if (!request || !action || !token || (action !== 'approve' && action !== 'reject')) {
    return res.status(400).type('html').send(decisionLinkHtml(false, 'This link is missing required parameters.'));
  }
  const peek = await peekLeaveDecisionToken(request, action, token);
  if (!peek) {
    return res.status(410).type('html').send(decisionLinkHtml(false, 'This link is invalid, has already been used, or has expired.'));
  }
  if (peek.status !== 'pending') {
    return res.status(409).type('html').send(decisionLinkHtml(false, 'This leave request has already been decided.'));
  }
  let leaveDetails = {};
  try {
    const leaveRequest = await loadLeaveRequest(request);
    if (leaveRequest) {
      const requester = leaveRequest.userId;
      const leaveType = leaveRequest.leaveTypeId;
      leaveDetails = {
        requesterName: requester?.name || 'An employee',
        leaveTypeName: leaveType?.name || leaveType?.code || 'leave',
        dateText: formatLeaveDateText(leaveRequest),
        reason: leaveRequest.reason || '',
        portalUrl: `${env.clientOrigin}/admin/leave/approvals?request=${request}`,
      };
    }
  } catch {
    // If we can't load details, show the page without them.
  }
  return res.status(200).type('html').send(decisionConfirmHtml(action, token, request, leaveDetails));
}

export async function leaveDecisionLinkHandler(req, res) {
  const { request, action, token, comment } = req.body ?? {};
  if (!request || !action || !token || (action !== 'approve' && action !== 'reject')) {
    return res.status(400).type('html').send(decisionLinkHtml(false, 'This link is missing required parameters.'));
  }
  const decisionComment = typeof comment === 'string' ? comment.trim() : null;
  if (!decisionComment) {
    return res.status(400).type('html').send(decisionLinkHtml(false, 'A remark is required for this action.'));
  }
  try {
    const { manager } = await decideLeaveRequestByToken(request, action, token, decisionComment);
    const verb = action === 'approve' ? 'approved' : 'rejected';
    const by = manager && manager.name ? ` by ${manager.name}` : '';
    const portalUrl = `${env.clientOrigin}/admin/leave/approvals`;
    return res.status(200).type('html').send(decisionLinkHtml(true, `Leave request ${verb} successfully${by}.`, portalUrl));
  } catch (e) {
    return res.status(e.statusCode || 500).type('html').send(decisionLinkHtml(false, e.message || 'Something went wrong.'));
  }
}

export async function leaveDecisionLoginHandler(req, res) {
  const { request, action, token } = req.query;
  if (!request || !action || !token || (action !== 'approve' && action !== 'reject' && action !== 'decide')) {
    return res.status(400).type('html').send(decisionLinkHtml(false, 'This link is missing required parameters.'));
  }
  try {
    const { manager } = await autoLoginByDecisionToken(request, action, token);
    const jwtToken = signToken(manager);
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('attendance_token', jwtToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'strict' : 'lax',
      maxAge: env.jwtCookieMaxAgeMs,
      path: '/',
    });
    const redirectUrl = action === 'decide'
      ? `${env.clientOrigin}/admin/leave/approvals?decision=request&requestId=${request}`
      : `${env.clientOrigin}/admin/leave/approvals?decision=request&requestId=${request}&action=${action}`;
    return res.redirect(302, redirectUrl);
  } catch (e) {
    return res.status(e.statusCode || 500).type('html').send(decisionLinkHtml(false, e.message || 'Something went wrong.'));
  }
}
export async function getTeamCalendarHandler(req, res) {
  const parsed = teamCalendarQuerySchema.parse(req.query);
  const result = await getTeamCalendar(req.user, req.userPermissions, parsed);
  res.json(result);
}

export async function listHolidays(req, res) {
  const parsed = holidayQuerySchema.parse(req.query);
  const filter = { isActive: true };

  if (parsed.year) {
    const start = parseDateInputAsISTDay(`${parsed.year}-01-01`);
    const end = parseDateInputAsISTDay(`${parsed.year}-12-31`);
    filter.date = { $gte: start, $lte: end };
  }

  const holidays = await Holiday.find(filter).sort({ date: 1 });
  res.json({
    holidays: holidays.map((item) => item.toSafeJSON()),
    note: 'Company holiday list is published each January — add dates when HR publishes the calendar.',
  });
}

export async function listHolidayCategories(req, res) {
  const categories = await HolidayCategory.find().sort({ name: 1 });
  res.json({ categories: categories.map((category) => category.toSafeJSON()) });
}

export async function createHolidayCategory(req, res) {
  const parsed = createHolidayCategorySchema.parse(req.body);
  const slug = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const reserved = new Set(['public', 'restricted', 'event']);
  if (!slug || reserved.has(slug)) {
    return res.status(400).json({ message: 'Choose a category name different from the built-in categories.' });
  }
  const existing = await HolidayCategory.findOne({ slug });
  if (existing) return res.status(409).json({ message: 'A category with this name already exists.' });

  const category = await HolidayCategory.create({ slug, name: parsed.name, color: parsed.color });
  res.status(201).json({ category: category.toSafeJSON() });
}

export async function updateHolidayCategory(req, res) {
  const parsed = updateHolidayCategorySchema.parse(req.body);
  const category = await HolidayCategory.findById(req.params.id);
  if (!category) return res.status(404).json({ message: 'Category not found.' });
  if (parsed.name !== undefined) category.name = parsed.name;
  if (parsed.color !== undefined) category.color = parsed.color;
  await category.save();
  res.json({ category: category.toSafeJSON() });
}

export async function deleteHolidayCategory(req, res) {
  const category = await HolidayCategory.findById(req.params.id);
  if (!category) return res.status(404).json({ message: 'Category not found.' });
  await Holiday.updateMany({ type: category.slug }, { $set: { type: 'public' } });
  await category.deleteOne();
  res.json({ message: 'Category deleted. Entries using it were moved to Public holiday.' });
}

export async function createHoliday(req, res) {
  const parsed = createHolidaySchema.parse(req.body);
  const date = parseDateInputAsISTDay(parsed.date);
  const existing = await Holiday.findOne({ date });
  if (existing) {
    return res.status(409).json({ message: 'Holiday already exists for this date.' });
  }

  const holiday = await Holiday.create({
    date,
    name: parsed.name,
    description: parsed.description ?? null,
    type: parsed.type ?? 'public',
    isActive: parsed.isActive ?? true,
    createdBy: req.user._id,
  });

  auditLog('holiday_created', {
    adminId: req.user._id.toString(),
    holidayId: holiday._id.toString(),
    date: parsed.date,
  });

  res.status(201).json({ holiday: holiday.toSafeJSON() });
}

export async function updateHoliday(req, res) {
  const parsed = updateHolidaySchema.parse(req.body);
  const holiday = await Holiday.findById(req.params.id);
  if (!holiday) {
    return res.status(404).json({ message: 'Holiday not found.' });
  }

  if (parsed.date) {
    const date = parseDateInputAsISTDay(parsed.date);
    const existing = await Holiday.findOne({ date, _id: { $ne: holiday._id } });
    if (existing) {
      return res.status(409).json({ message: 'Holiday already exists for this date.' });
    }
    holiday.date = date;
  }
  if (parsed.name !== undefined) holiday.name = parsed.name;
  if (parsed.description !== undefined) holiday.description = parsed.description;
  if (parsed.type !== undefined) holiday.type = parsed.type;
  if (parsed.isActive !== undefined) holiday.isActive = parsed.isActive;

  await holiday.save();
  res.json({ holiday: holiday.toSafeJSON() });
}

export async function deleteHoliday(req, res) {
  const holiday = await Holiday.findById(req.params.id);
  if (!holiday) {
    return res.status(404).json({ message: 'Holiday not found.' });
  }

  await holiday.deleteOne();
  auditLog('holiday_deleted', {
    adminId: req.user._id.toString(),
    holidayId: holiday._id.toString(),
  });
  res.json({ message: 'Holiday deleted successfully.' });
}

export async function listRecurringHolidayRules(req, res) {
  const rules = await getRecurringHolidayRules();
  res.json({ rules });
}

export async function updateRecurringHolidayRules(req, res) {
  const parsed = recurringHolidayRulesSchema.parse(req.body);
  const rules = await saveRecurringHolidayRules(parsed.rules, req.user._id);
  auditLog('recurring_holiday_rules_updated', {
    adminId: req.user._id.toString(),
    count: rules.length,
  });
  res.json({ rules });
}

export async function materializeRecurringHolidays(req, res) {
  const parsed = materializeRecurringSchema.parse(req.body);
  const result = await materializeRecurringHolidaysForYear(parsed.year, req.user._id);
  auditLog('recurring_holidays_materialized', {
    adminId: req.user._id.toString(),
    year: parsed.year,
    created: result.created.length,
    skipped: result.skipped.length,
  });
  res.json(result);
}

export async function initUserBalancesHandler(req, res) {
  const year = req.body?.year ? Number(req.body.year) : getISTYear();
  const balances = await ensureBalancesForUser(req.user._id, year);
  res.json({ year, balances: balances.map((item) => item.toSafeJSON()) });
}

export async function encashLeaveBalanceHandler(req, res) {
  const parsed = encashLeaveSchema.parse(req.body);
  const result = await recordEncashment(req.params.userId, parsed, req.user._id);

  auditLog('leave_encashment_recorded', {
    adminId: req.user._id.toString(),
    userId: req.params.userId,
    leaveTypeId: parsed.leaveTypeId,
    year: parsed.year,
    days: parsed.days,
    reason: parsed.reason,
  });

  res.json(result);
}

export async function previewCarryForwardHandler(req, res) {
  const parsed = carryForwardPreviewQuerySchema.parse(req.query);
  const result = await previewYearEndCarryForward(parsed.fromYear, {
    userId: parsed.userId,
  });
  res.json(result);
}

export async function carryForwardHandler(req, res) {
  const parsed = carryForwardSchema.parse(req.body);
  const result = await applyYearEndCarryForward(parsed.fromYear, {
    userId: parsed.userId,
    userIds: parsed.userIds,
    appliedBy: req.user._id,
  });

  auditLog('leave_carry_forward_applied', {
    adminId: req.user._id.toString(),
    fromYear: parsed.fromYear,
    toYear: result.toYear,
    adjustments: result.adjustments,
    totalCarried: result.totalCarried,
    totalForfeited: result.totalForfeited,
    userId: parsed.userId ?? null,
    userIds: parsed.userIds ?? null,
  });

  res.json(result);
}

export async function runLeaveAccrualJobHandler(req, res) {
  const result = await runMonthlyAccrualJob();

  auditLog('leave_accrual_job_run', {
    adminId: req.user._id.toString(),
    year: result.year,
  });

  res.json(result);
}
