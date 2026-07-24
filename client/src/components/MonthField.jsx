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

export { parseMonthValue, toMonthValue, formatMonthLabel, getTodayMonthIst };
