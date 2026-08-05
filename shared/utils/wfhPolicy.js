const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const IST_TIMEZONE = 'Asia/Kolkata';

export const WFH_LEAVE_TYPE_CODE = 'WFH';
export const SL_LEAVE_TYPE_CODE = 'SL';
export const LEAVE_APPLY_CUTOFF_TIME = '12:00';
/** @deprecated Use LEAVE_APPLY_CUTOFF_TIME */
export const WFH_APPLY_CUTOFF_TIME = LEAVE_APPLY_CUTOFF_TIME;
export const LEAVE_APPLY_DEADLINE_ERROR =
  'Leave requests for tomorrow must be submitted before 12:00 PM IST today.';
/** @deprecated Use LEAVE_APPLY_DEADLINE_ERROR */
export const WFH_APPLY_DEADLINE_ERROR = LEAVE_APPLY_DEADLINE_ERROR;
export const WFH_CHECKIN_REQUIRES_APPROVAL_ERROR =
  'Work from Home check-in requires approved WFH leave for today.';

export function getISTDateInputValue(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function parseDateInputAsISTDay(dateInput) {
  if (!dateInput) {
    return null;
  }
  const [year, month, day] = String(dateInput).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0) - IST_OFFSET_MS);
}

export function buildISTTimestampFromDayAndTime(dayKey, timeHHmm) {
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey ?? '').trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(timeHHmm ?? '').trim());
  if (!dayMatch || !timeMatch) {
    return null;
  }
  const year = Number(dayMatch[1]);
  const month = Number(dayMatch[2]);
  const day = Number(dayMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (!year || !month || !day || hour > 23 || minute > 59) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - IST_OFFSET_MS);
}

/** Next calendar day in IST relative to the application instant. */
export function getTomorrowISTDateKey(appliedAt = new Date()) {
  const today = parseDateInputAsISTDay(getISTDateInputValue(appliedAt));
  if (!today) {
    return null;
  }
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return getISTDateInputValue(tomorrow);
}

export function normalizeLeaveTypeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

/** Sick leave is exempt from the 12:00 PM IST tomorrow apply cutoff. */
export function isLeaveTypeExemptFromApplyDeadline(leaveTypeCode) {
  return normalizeLeaveTypeCode(leaveTypeCode) === SL_LEAVE_TYPE_CODE;
}

/** True at or after 12:00 PM IST on the application day. */
export function isPastLeaveApplyCutoff(appliedAt = new Date()) {
  const todayKey = getISTDateInputValue(appliedAt);
  const cutoff = buildISTTimestampFromDayAndTime(todayKey, LEAVE_APPLY_CUTOFF_TIME);
  if (!cutoff) {
    return false;
  }
  return appliedAt.getTime() >= cutoff.getTime();
}

/** @deprecated Use isPastLeaveApplyCutoff */
export function isPastWfhApplyCutoff(appliedAt = new Date()) {
  return isPastLeaveApplyCutoff(appliedAt);
}

export function wfhRangeIncludesISTDate(fromDate, toDate, targetDateKey) {
  if (!fromDate || !toDate || !targetDateKey) {
    return false;
  }
  return fromDate <= targetDateKey && targetDateKey <= toDate;
}

/**
 * Apply deadline for all leave types except SL: after 12:00 PM IST, reject ranges that include
 * tomorrow (IST). Multi-day ranges are blocked when any covered day is tomorrow and the cutoff
 * has passed. Returns an error message string, or null when allowed.
 */
export function validateLeaveApplyDeadline(
  fromDate,
  toDate,
  leaveTypeCode,
  appliedAt = new Date(),
) {
  if (!fromDate || !toDate || toDate < fromDate) {
    return null;
  }
  if (isLeaveTypeExemptFromApplyDeadline(leaveTypeCode)) {
    return null;
  }
  if (!isPastLeaveApplyCutoff(appliedAt)) {
    return null;
  }
  const tomorrowKey = getTomorrowISTDateKey(appliedAt);
  if (wfhRangeIncludesISTDate(fromDate, toDate, tomorrowKey)) {
    return LEAVE_APPLY_DEADLINE_ERROR;
  }
  return null;
}

/** @deprecated Use validateLeaveApplyDeadline */
export function validateWfhApplyDeadline(fromDate, toDate, appliedAt = new Date()) {
  return validateLeaveApplyDeadline(fromDate, toDate, WFH_LEAVE_TYPE_CODE, appliedAt);
}

export function validateWfhCheckInMode(attendanceMode, wfhApprovedToday) {
  if (attendanceMode !== 'wfh') {
    return null;
  }
  if (wfhApprovedToday) {
    return null;
  }
  return WFH_CHECKIN_REQUIRES_APPROVAL_ERROR;
}
