const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const IST_TIMEZONE = 'Asia/Kolkata';

function getISTParts(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

export function startOfDayIST(date = new Date()) {
  const { year, month, day } = getISTParts(date);
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - IST_OFFSET_MS);
}

export function endOfDayIST(date = new Date()) {
  const { year, month, day } = getISTParts(date);
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - IST_OFFSET_MS);
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

export function formatISTDateTime(value) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

export function formatISTDate(value) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    weekday: 'short',
  }).format(new Date(value));
}

export function getISTDateInputValue(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getISTYear(date = new Date()) {
  return Number(getISTDateInputValue(date).slice(0, 4));
}

export function getISTMonth(date = new Date()) {
  return Number(getISTDateInputValue(date).slice(5, 7));
}

export function getISTWeekday(date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    weekday: 'short',
  }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? 0;
}

export function isWeekendIST(date = new Date()) {
  const day = getISTWeekday(date);
  return day === 0 || day === 6;
}

export function isWorkingDayIST(date, holidayDates = new Set()) {
  if (isWeekendIST(date)) return false;
  return !holidayDates.has(getISTDateInputValue(date));
}

export function* iterateISTDays(startDate, endDate) {
  let cursor = startOfDayIST(startDate);
  const end = startOfDayIST(endDate);
  while (cursor <= end) {
    yield new Date(cursor);
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
}

export function countWorkingDaysIST(startDate, endDate, holidayDates = new Set()) {
  let count = 0;
  for (const day of iterateISTDays(startDate, endDate)) {
    if (isWorkingDayIST(day, holidayDates)) {
      count += 1;
    }
  }
  return count;
}

export function listWorkingDaysIST(startDate, endDate, holidayDates = new Set()) {
  const days = [];
  for (const day of iterateISTDays(startDate, endDate)) {
    if (isWorkingDayIST(day, holidayDates)) {
      days.push(getISTDateInputValue(day));
    }
  }
  return days;
}

/**
 * Compute leave day count for a date range.
 * Half-day: 0.5 for a single working day.
 * Sandwich (optional): count all calendar days from first to last working day in range,
 * so weekends/holidays between leave days are included (e.g. Fri–Mon = 4 days).
 */
export function computeLeaveDaysIST(
  startDate,
  endDate,
  holidayDates = new Set(),
  { halfDay = null, sandwichLeaveEnabled = false } = {},
) {
  const workingDays = listWorkingDaysIST(startDate, endDate, holidayDates);
  if (workingDays.length === 0) {
    return { days: 0, workingDays };
  }

  if (halfDay) {
    if (workingDays.length !== 1) {
      return { days: 0, workingDays, invalidHalfDay: true };
    }
    return { days: 0.5, workingDays };
  }

  if (!sandwichLeaveEnabled) {
    return { days: workingDays.length, workingDays };
  }

  const firstWorking = parseDateInputAsISTDay(workingDays[0]);
  const lastWorking = parseDateInputAsISTDay(workingDays[workingDays.length - 1]);
  let calendarDays = 0;
  for (const _day of iterateISTDays(firstWorking, lastWorking)) {
    calendarDays += 1;
  }

  return { days: calendarDays, workingDays, sandwichApplied: true };
}

/** Parse YYYY-MM and return IST month boundaries (inclusive). */
export function parseMonthInputAsISTRange(monthInput) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(monthInput ?? '').trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = startOfDayIST(parseDateInputAsISTDay(`${monthKey}-01`));
  const end = endOfDayIST(
    parseDateInputAsISTDay(`${monthKey}-${String(daysInMonth).padStart(2, '0')}`),
  );
  return { year, month, monthKey, start, end, daysInMonth };
}
