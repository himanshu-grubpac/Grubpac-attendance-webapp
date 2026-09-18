/**
 * Portal-wide cross-module invalidation broadcast channel.
 *
 * Writers call broadcastPortalSync (or topic helpers) after a successful save;
 * listeners subscribe via usePortalSync (same-tab CustomEvent + cross-tab storage).
 */
export const PORTAL_SYNC_EVENT = 'attendance:portal-sync';
export const PORTAL_SYNC_STORAGE_KEY = 'attendance.portal-sync';

/** @deprecated Legacy event — kept for tests; writers use PORTAL_SYNC_EVENT. */
export const SALARY_LOP_EVENT = 'attendance:salary-lop-invalidated';
/** @deprecated Legacy storage key — kept for tests. */
export const SALARY_LOP_STORAGE_KEY = 'attendance.salary-lop-invalidated';

export const PORTAL_TOPICS = {
  ATTENDANCE: 'attendance',
  LEAVE: 'leave',
  PAYROLL: 'payroll',
  SALARY: 'salary',
  HOLIDAY: 'holiday',
  POLICY: 'policy',
  EMPLOYEE: 'employee',
  DEPARTMENT: 'department',
  PERMISSIONS: 'permissions',
  HELP: 'help',
};

const PAYROLL_SOURCE_TOPICS = new Set([
  PORTAL_TOPICS.ATTENDANCE,
  PORTAL_TOPICS.LEAVE,
  PORTAL_TOPICS.SALARY,
  PORTAL_TOPICS.HOLIDAY,
  PORTAL_TOPICS.POLICY,
  PORTAL_TOPICS.PAYROLL,
]);

export function dayKeyInMonth(dayKey, month) {
  return Boolean(dayKey && month && dayKey.startsWith(`${month}-`));
}

export function monthFromDayKey(dayKey) {
  if (!dayKey || typeof dayKey !== 'string' || dayKey.length < 7) return undefined;
  return dayKey.slice(0, 7);
}

export function topicMatchesSubscription(eventTopic, subscribedTopics) {
  if (!subscribedTopics?.length) return true;
  if (subscribedTopics.includes(eventTopic)) return true;
  if (subscribedTopics.includes(PORTAL_TOPICS.PAYROLL) && PAYROLL_SOURCE_TOPICS.has(eventTopic)) {
    return true;
  }
  return false;
}

export function shouldHandlePortalSync(detail, { topics = [], userId = null, month = null, dayKey = null } = {}) {
  if (!detail?.topic) return false;
  if (!topicMatchesSubscription(detail.topic, topics)) return false;
  if (userId && detail.userId && String(detail.userId) !== String(userId)) {
    return false;
  }
  const effectiveMonth = detail.month ?? monthFromDayKey(detail.dayKey);
  if (month && effectiveMonth && effectiveMonth !== month) {
    return false;
  }
  if (dayKey && detail.dayKey && detail.dayKey !== dayKey) {
    return false;
  }
  return true;
}

export function broadcastPortalSync(detail) {
  if (!detail?.topic) return;

  const payload = {
    topic: detail.topic,
    at: Date.now(),
  };
  if (detail.userId != null) payload.userId = String(detail.userId);
  if (detail.dayKey) payload.dayKey = detail.dayKey;
  const month = detail.month ?? monthFromDayKey(detail.dayKey);
  if (month) payload.month = month;

  window.dispatchEvent(new CustomEvent(PORTAL_SYNC_EVENT, { detail: payload }));
  try {
    localStorage.setItem(PORTAL_SYNC_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function broadcastPortalSyncTopics(topics, detail = {}) {
  if (!Array.isArray(topics)) return;
  for (const topic of topics) {
    broadcastPortalSync({ ...detail, topic });
  }
}

export function broadcastAttendancePayrollSync({ userId, dayKey }) {
  if (!userId || !dayKey) return;
  broadcastPortalSyncTopics([PORTAL_TOPICS.ATTENDANCE, PORTAL_TOPICS.PAYROLL], { userId, dayKey });
}

export function broadcastLeavePayrollSync({ userId, startDate, dayKey } = {}) {
  const dk = dayKey ?? startDate;
  broadcastPortalSyncTopics([PORTAL_TOPICS.LEAVE, PORTAL_TOPICS.PAYROLL], {
    userId,
    dayKey: dk,
    month: monthFromDayKey(dk),
  });
}

export function broadcastLeaveItemSync(item) {
  broadcastLeavePayrollSync({
    userId: item?.userId,
    startDate: item?.startDate,
  });
}

export function broadcastSalaryPayrollSync({ userId, month, salaryEffectiveFrom, dayKey } = {}) {
  const effectiveMonth =
    month ??
    monthFromDayKey(dayKey) ??
    (salaryEffectiveFrom ? String(salaryEffectiveFrom).slice(0, 7) : undefined);
  broadcastPortalSyncTopics([PORTAL_TOPICS.SALARY, PORTAL_TOPICS.PAYROLL], {
    userId,
    month: effectiveMonth,
    dayKey,
  });
}

export function broadcastHolidayPayrollSync({ dayKey, date } = {}) {
  const dk = dayKey ?? date;
  broadcastPortalSyncTopics([PORTAL_TOPICS.HOLIDAY, PORTAL_TOPICS.PAYROLL], {
    dayKey: dk,
    month: monthFromDayKey(dk),
  });
}

export function broadcastPolicyPayrollSync() {
  broadcastPortalSyncTopics([PORTAL_TOPICS.POLICY, PORTAL_TOPICS.PAYROLL], {});
}

export function broadcastEmployeeSync({ userId } = {}) {
  broadcastPortalSync({ topic: PORTAL_TOPICS.EMPLOYEE, userId });
}

export function broadcastDepartmentSync() {
  broadcastPortalSync({ topic: PORTAL_TOPICS.DEPARTMENT });
}

export function broadcastPermissionsSync() {
  broadcastPortalSync({ topic: PORTAL_TOPICS.PERMISSIONS });
}

export function broadcastHelpSync() {
  broadcastPortalSync({ topic: PORTAL_TOPICS.HELP });
}

/** Short-name aliases — same helpers, preferred names in new writer imports. */
export const broadcastLeaveSync = broadcastLeavePayrollSync;
export const broadcastLeaveFromRequest = broadcastLeaveItemSync;
export const broadcastSalarySync = broadcastSalaryPayrollSync;
export const broadcastHolidaySync = broadcastHolidayPayrollSync;
export const broadcastPolicySync = broadcastPolicyPayrollSync;
export const broadcastAttendanceSync = broadcastAttendancePayrollSync;

/** @deprecated Use broadcastAttendancePayrollSync — kept for backward compat imports. */
export function broadcastSalaryLopInvalidated(detail) {
  broadcastAttendancePayrollSync(detail);
}

/** @deprecated Use shouldHandlePortalSync with topics: ['payroll']. */
export function shouldHandleSalaryLopInvalidation(detail, { userId = null, month = null } = {}) {
  if (!detail) return false;
  const normalized = detail.topic
    ? detail
    : { ...detail, topic: PORTAL_TOPICS.ATTENDANCE };
  return shouldHandlePortalSync(normalized, { topics: [PORTAL_TOPICS.PAYROLL], userId, month });
}
