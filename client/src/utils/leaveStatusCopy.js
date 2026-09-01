/** Employee-facing copy for pending / apply leave status (all leave types). */

/** Prefer the policy row for the requested year (avoids stale rows without year). */
export function selectLeavePolicyForType(policies, leaveTypeId, year = new Date().getFullYear()) {
  if (!leaveTypeId || !Array.isArray(policies)) return null;

  const matches = policies.filter(
    (policy) =>
      policy.leaveTypeId === leaveTypeId || policy.leaveType?.id === leaveTypeId,
  );
  if (!matches.length) return null;

  const forYear = matches.find((policy) => policy.year === year);
  if (forYear) return forYear;

  return matches.reduce(
    (best, policy) => ((policy.year ?? 0) > (best?.year ?? 0) ? policy : best),
    null,
  );
}

/** Paid vs unpaid policy copy; WFH is treated as paid by policy (overdraw still LOP in salary). */
export function resolveLeavePolicyPaid({ leaveTypeCode, policy } = {}) {
  if (String(leaveTypeCode ?? '').toUpperCase() === 'WFH') {
    return true;
  }
  if (!policy) return true;
  return policy.paid !== false;
}

export function formatLeaveTypeLabel({ leaveTypeCode, leaveTypeName } = {}) {
  if (leaveTypeCode && leaveTypeName) {
    return `${leaveTypeCode} — ${leaveTypeName}`;
  }
  return leaveTypeCode || leaveTypeName || 'Leave';
}

/**
 * Mohit-style warning when apply would overdraw remaining balance.
 * Does not block submit — caller shows banner and continues.
 */
export function buildNegativeBalanceWarning({
  leaveTypeCode,
  leaveTypeName,
  available,
  requestedDays,
} = {}) {
  const code = String(leaveTypeCode ?? '').trim() || String(leaveTypeName ?? '').trim() || 'leave';
  const remaining = Number(available);
  const days = Number(requestedDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (!Number.isFinite(remaining)) return null;
  if (remaining >= days) return null;

  if (remaining <= 0) {
    return `You don't have ${code} now. If you take it, it will be unpaid and will go in minus.`;
  }

  const overdrawn = Math.round((days - remaining) * 100) / 100;
  return `You have only ${remaining} day(s) of ${code} left. If you apply for ${days} day(s), ${overdrawn} day(s) will be unpaid and will go in minus.`;
}

/** Info notice on Apply leave — all types; paid line when policy.paid is true. */
export function buildApplyLeaveNotice({ leaveTypeCode, leaveTypeName, policyPaid = true } = {}) {
  const code = String(leaveTypeCode ?? '').toUpperCase();
  const label = formatLeaveTypeLabel({ leaveTypeCode, leaveTypeName });

  if (code === 'SL') {
    const paidLine = policyPaid
      ? `${label} is paid leave.`
      : `${label} is unpaid leave.`;
    return {
      title: 'Before you submit',
      lines: ['Sick leave is approved automatically when you submit.', paidLine],
    };
  }

  const paidLine = policyPaid
    ? `${label} is paid leave once your manager approves it.`
    : `${label} is unpaid leave once your manager approves it.`;

  return {
    title: 'Before you submit',
    lines: [
      'This leave counts only after your manager approves it. Until then, it is not treated as approved leave.',
      paidLine,
      'If that day passes without approval and you do not mark attendance, it may count as loss of pay (LOP).',
    ],
  };
}

/** Read-only dashboard label for today's auto-detected attendance mode. */
export function buildTodayAttendanceModeLabel({
  wfhApprovedToday,
  wfhApprovalPendingToday,
  approvedLeaveToday,
  checkIn,
} = {}) {
  if (checkIn) {
    if (checkIn.leaveStatus === 'pending') {
      return 'Today: Work from home (pending approval — shown in red until approved)';
    }
    if (checkIn.attendanceMode === 'wfh') return 'Today: Work from home (approved)';
    return 'Today: Office attendance';
  }
  if (wfhApprovalPendingToday) {
    return 'Today: Work from home (approval pending — shown in red until final)';
  }
  if (wfhApprovedToday) {
    return 'Today: Work from home (approved)';
  }
  if (approvedLeaveToday) {
    const label = formatLeaveTypeLabel(approvedLeaveToday);
    return `Today: ${label} (approved) — check-in not available on leave days`;
  }
  return 'Today: Office attendance';
}

/** Dashboard banner when pending leave covers today (before check-in). */
export function buildPendingLeaveCheckInWarning(pendingLeaveToday) {
  if (!pendingLeaveToday) return null;
  const label = formatLeaveTypeLabel(pendingLeaveToday);
  return {
    title: 'Pending leave for today',
    body: `You have a pending ${label} request for today. It is not approved yet, so this day is not covered as leave. You can still check in; until leave is approved, this day may count as loss of pay (LOP) if leave is not approved in time.`,
  };
}

/** After successful check-in while pending leave still exists for today. */
export function buildPendingLeaveCheckInFollowUp(pendingLeaveToday) {
  if (!pendingLeaveToday) return null;
  const label = formatLeaveTypeLabel(pendingLeaveToday);
  return `Check-in recorded. Your ${label} request is still pending — this day is not counted as approved leave until your manager approves it.`;
}
