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

/** Paid vs unpaid copy follows LeavePolicy.paid; WFH is always paid (matches salaryService). */
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
