import { Holiday } from '../models/Holiday.js';
import { OfficeSettings } from '../models/OfficeSettings.js';
import { getISTDateInputValue, parseDateInputAsISTDay } from '../utils/istDate.js';

function normalizeMonths(months) {
  if (months === 'all' || months == null) {
    return Array.from({ length: 12 }, (_, index) => index + 1);
  }
  if (Array.isArray(months)) {
    return months.map(Number).filter((month) => month >= 1 && month <= 12);
  }
  return [];
}

function resolveNthWeekday(year, month, weekday, nth) {
  if (nth === -1) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = lastDay; day >= 1; day -= 1) {
      const date = parseDateInputAsISTDay(
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      );
      const wd = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
      }).format(date);
      const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      if (map[wd] === weekday) {
        return getISTDateInputValue(date);
      }
    }
    return null;
  }

  let count = 0;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = parseDateInputAsISTDay(
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    );
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
    }).format(date);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    if (map[wd] !== weekday) continue;
    count += 1;
    if (count === nth) {
      return getISTDateInputValue(date);
    }
  }
  return null;
}

export function materializeRecurringRuleDates(rule, year) {
  const months = normalizeMonths(rule.months);
  const dates = [];
  for (const month of months) {
    const dayKey = resolveNthWeekday(year, month, rule.weekday, rule.nth);
    if (dayKey) {
      dates.push(dayKey);
    }
  }
  return dates;
}

export async function getRecurringHolidayRules() {
  const settings = await OfficeSettings.findOne().sort({ updatedAt: -1 }).select('recurringHolidayRules');
  return settings?.recurringHolidayRules ?? [];
}

export async function saveRecurringHolidayRules(rules, updatedBy) {
  let settings = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  if (!settings) {
    settings = await OfficeSettings.create({
      name: 'Main Office',
      latitude: 0,
      longitude: 0,
      recurringHolidayRules: rules,
      updatedBy,
    });
  } else {
    settings.recurringHolidayRules = rules;
    settings.updatedBy = updatedBy;
    await settings.save();
  }
  return settings.recurringHolidayRules ?? [];
}

export async function materializeRecurringHolidaysForYear(year, actorId) {
  const rules = await getRecurringHolidayRules();
  const created = [];
  const skipped = [];

  for (const rule of rules) {
    const dateKeys = materializeRecurringRuleDates(rule, year);
    for (const dateKey of dateKeys) {
      const date = parseDateInputAsISTDay(dateKey);
      const existing = await Holiday.findOne({ date });
      if (existing) {
        skipped.push({ date: dateKey, name: rule.name, reason: 'exists' });
        continue;
      }
      const holiday = await Holiday.create({
        date,
        name: rule.name,
        type: rule.type ?? 'public',
        createdBy: actorId,
        isActive: true,
      });
      created.push(holiday.toSafeJSON());
    }
  }

  return { created, skipped, year, ruleCount: rules.length };
}
