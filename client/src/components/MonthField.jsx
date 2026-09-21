import { useMemo } from 'react';
import { shiftYearMonth, parseDateValue, toDateValue } from './DateField.jsx';

const MONTH_NAME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  timeZone: 'UTC',
});

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function parseMonthValue(value) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) return null;
  return { year, month };
}

function toMonthValue(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function formatMonthLabel(value) {
  const parsed = parseMonthValue(value);
  if (!parsed) return 'Select month';
  return MONTH_LABEL_FORMATTER.format(new Date(Date.UTC(parsed.year, parsed.month - 1, 1)));
}

function formatMonthParts(value, fallbackValue) {
  const parsed = parseMonthValue(value) ?? parseMonthValue(fallbackValue);
  if (!parsed) return null;
  return {
    year: parsed.year,
    monthName: MONTH_NAME_FORMATTER.format(new Date(Date.UTC(parsed.year, parsed.month - 1, 1))),
  };
}

function getTodayMonthIst() {
  const today = parseDateValue(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
  );
  if (!today) {
    const now = new Date();
    return toMonthValue(now.getFullYear(), now.getMonth() + 1);
  }
  return toMonthValue(today.year, today.month);
}

/**
 * Enterprise month control (YYYY-MM) with previous / next / current-month actions.
 */
export default function MonthField({
  value,
  onChange,
  disabled = false,
  'aria-label': ariaLabel = 'Select month',
  className = '',
}) {
  const currentMonth = getTodayMonthIst();
  const label = useMemo(() => formatMonthLabel(value), [value]);
  const parts = useMemo(
    () => formatMonthParts(value, currentMonth),
    [value, currentMonth],
  );

  function shift(delta) {
    const parsed = parseMonthValue(value) ?? parseMonthValue(currentMonth);
    if (!parsed) return;
    const next = shiftYearMonth(parsed.year, parsed.month, delta);
    onChange(toMonthValue(next.year, next.month));
  }

  function shiftYear(delta) {
    const parsed = parseMonthValue(value) ?? parseMonthValue(currentMonth);
    if (!parsed) return;
    onChange(toMonthValue(parsed.year + delta, parsed.month));
  }

  return (
    <div
      className={`month-field${disabled ? ' month-field--disabled' : ''}${
        className ? ` ${className}` : ''
      }`}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="month-field__nav"
        aria-label="Previous month"
        disabled={disabled}
        onClick={() => shift(-1)}
      >
        ‹
      </button>
      <div className="month-field__label" aria-live="polite">
        {parts ? (
          <>
            <div className="month-field__year-row">
              <button
                type="button"
                className="month-field__nav month-field__nav--year"
                aria-label="Previous year"
                disabled={disabled}
                onClick={() => shiftYear(-1)}
              >
                ‹
              </button>
              <span className="month-field__year">{parts.year}</span>
              <button
                type="button"
                className="month-field__nav month-field__nav--year"
                aria-label="Next year"
                disabled={disabled}
                onClick={() => shiftYear(1)}
              >
                ›
              </button>
            </div>
            <span className="month-field__month">{parts.monthName}</span>
          </>
        ) : (
          label
        )}
      </div>
      <button
        type="button"
        className="month-field__nav"
        aria-label="Next month"
        disabled={disabled}
        onClick={() => shift(1)}
      >
        ›
      </button>
      {value !== currentMonth ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm month-field__today"
          disabled={disabled}
          onClick={() => onChange(currentMonth)}
        >
          This month
        </button>
      ) : null}
    </div>
  );
}

const SALARY_MONTH_NAME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  timeZone: 'UTC',
});

/** Current calendar year in IST (YYYY). */
function getCurrentIstYear() {
  return Number(getTodayMonthIst().split('-')[0]);
}

/** Current calendar month in IST (MM). */
function getCurrentIstMonthPart() {
  return getTodayMonthIst().split('-')[1];
}

/** Company operations start — salary/LOP year filters use this through current IST year. */
export const COMPANY_ESTABLISH_YEAR = 2024;

/** Normalize API/auth date values to IST YYYY-MM-DD for period bounds. */
function normalizeEmployeeDateInput(value) {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    const isoDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDate) {
      return isoDate[1];
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function hasEmployeePeriodBounds(bounds) {
  return Boolean(bounds?.joiningDate || bounds?.endingDate);
}

/** Resolve inclusive IST year/month bounds for employee-specific pickers. */
function resolveEmployeePeriodBounds(bounds = {}) {
  const currentYear = getCurrentIstYear();
  const currentMonth = Number(getCurrentIstMonthPart());

  let minYear = COMPANY_ESTABLISH_YEAR;
  let minMonth = 1;
  let maxYear = currentYear;
  let maxMonth = currentMonth;

  const joinKey = normalizeEmployeeDateInput(bounds.joiningDate);
  if (joinKey) {
    const joinParts = parseDateValue(joinKey);
    if (joinParts) {
      minYear = Math.max(COMPANY_ESTABLISH_YEAR, joinParts.year);
      minMonth = joinParts.year >= minYear ? joinParts.month : 1;
      if (joinParts.year < COMPANY_ESTABLISH_YEAR) {
        minYear = COMPANY_ESTABLISH_YEAR;
        minMonth = 1;
      }
    }
  }

  const endKey = normalizeEmployeeDateInput(bounds.endingDate);
  if (endKey) {
    const endParts = parseDateValue(endKey);
    if (endParts) {
      maxYear = endParts.year;
      maxMonth = endParts.month;
    }
  }

  if (maxYear > currentYear || (maxYear === currentYear && maxMonth > currentMonth)) {
    maxYear = currentYear;
    maxMonth = currentMonth;
  }

  if (
    minYear > maxYear
    || (minYear === maxYear && minMonth > maxMonth)
  ) {
    minYear = maxYear;
    minMonth = maxMonth;
  }

  return { minYear, minMonth, maxYear, maxMonth };
}

/** Clamp year to company establish year through current IST year. */
function clampYearToCurrentIst(year, bounds) {
  const currentYear = getCurrentIstYear();
  const parsed = Number(year);
  if (!Number.isFinite(parsed)) {
    return String(currentYear);
  }
  let clamped = parsed;
  if (clamped > currentYear) {
    clamped = currentYear;
  }
  if (clamped < COMPANY_ESTABLISH_YEAR) {
    clamped = COMPANY_ESTABLISH_YEAR;
  }
  if (hasEmployeePeriodBounds(bounds)) {
    const { minYear, maxYear } = resolveEmployeePeriodBounds(bounds);
    if (clamped < minYear) {
      clamped = minYear;
    }
    if (clamped > maxYear) {
      clamped = maxYear;
    }
  }
  return String(clamped);
}

/**
 * Salary/LOP year dropdown: current IST year down to company establish year (2024),
 * or join year through ending/current IST when bounds are provided.
 */
function buildSalaryYearOptions(bounds) {
  if (!hasEmployeePeriodBounds(bounds)) {
    const currentYear = getCurrentIstYear();
    const years = [];
    for (let year = currentYear; year >= COMPANY_ESTABLISH_YEAR; year -= 1) {
      years.push({ value: String(year), label: String(year) });
    }
    return years;
  }

  const { minYear, maxYear } = resolveEmployeePeriodBounds(bounds);
  const years = [];
  for (let year = maxYear; year >= minYear; year -= 1) {
    years.push({ value: String(year), label: String(year) });
  }
  return years;
}

/** Month dropdown options for a selected year — omits future months in the current IST year. */
function buildSalaryMonthOptions(selectedYear, bounds) {
  const currentYear = getCurrentIstYear();
  const currentMonth = Number(getCurrentIstMonthPart());
  const year = Number(selectedYear);
  if (!Number.isFinite(year)) {
    return [];
  }

  if (!hasEmployeePeriodBounds(bounds)) {
    const maxMonth = year === currentYear ? currentMonth : 12;
    return Array.from({ length: maxMonth }, (_, index) => ({
      value: String(index + 1).padStart(2, '0'),
      label: SALARY_MONTH_NAME_FORMATTER.format(new Date(Date.UTC(2020, index, 1))),
    }));
  }

  const { minYear, minMonth, maxYear, maxMonth } = resolveEmployeePeriodBounds(bounds);
  if (year < minYear || year > maxYear) {
    return [];
  }

  let startMonth = 1;
  let endMonth = 12;
  if (year === minYear) {
    startMonth = minMonth;
  }
  if (year === maxYear) {
    endMonth = maxMonth;
  }
  if (year === currentYear) {
    endMonth = Math.min(endMonth, currentMonth);
  }
  if (startMonth > endMonth) {
    return [];
  }

  return Array.from({ length: endMonth - startMonth + 1 }, (_, index) => {
    const monthNum = startMonth + index;
    return {
      value: String(monthNum).padStart(2, '0'),
      label: SALARY_MONTH_NAME_FORMATTER.format(new Date(Date.UTC(2020, monthNum - 1, 1))),
    };
  });
}

/** Keep month part within allowed range for the selected year (IST). */
function clampMonthPartForYear(year, monthPart, bounds) {
  const options = buildSalaryMonthOptions(year, bounds);
  if (options.length === 0) {
    if (hasEmployeePeriodBounds(bounds)) {
      const { minYear, minMonth, maxYear, maxMonth } = resolveEmployeePeriodBounds(bounds);
      const parsedYear = Number(year);
      if (parsedYear <= minYear) {
        return String(minMonth).padStart(2, '0');
      }
      if (parsedYear >= maxYear) {
        return String(maxMonth).padStart(2, '0');
      }
    }
    return getCurrentIstMonthPart();
  }
  const allowed = new Set(options.map((option) => option.value));
  if (allowed.has(monthPart)) {
    return monthPart;
  }
  return options[options.length - 1].value;
}

/** Clamp YYYY-MM to global or employee-specific IST bounds. */
function clampMonthValue(value, bounds) {
  const parsed = parseMonthValue(value) ?? parseMonthValue(getTodayMonthIst());
  if (!parsed) {
    return getTodayMonthIst();
  }
  const year = clampYearToCurrentIst(String(parsed.year), bounds);
  const month = clampMonthPartForYear(year, String(parsed.month).padStart(2, '0'), bounds);
  return toMonthValue(Number(year), Number(month));
}

export {
  parseMonthValue,
  toMonthValue,
  formatMonthLabel,
  getTodayMonthIst,
  getCurrentIstYear,
  getCurrentIstMonthPart,
  normalizeEmployeeDateInput,
  resolveEmployeePeriodBounds,
  clampYearToCurrentIst,
  buildSalaryYearOptions,
  buildSalaryMonthOptions,
  clampMonthPartForYear,
  clampMonthValue,
};
