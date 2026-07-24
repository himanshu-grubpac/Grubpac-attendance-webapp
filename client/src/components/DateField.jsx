import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

const VIEWPORT_PADDING = 8;
const GAP = 4;
/** Fixed compact panel — never stretch to trigger width (wide triggers blew up day cells). */
const PANEL_WIDTH = 228;
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const MONTH_NAME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  timeZone: 'UTC',
});

const DISPLAY_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function parseDateValue(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function toDateValue(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function shiftYearMonth(year, month, delta) {
  const absolute = year * 12 + (month - 1) + delta;
  return {
    year: Math.floor(absolute / 12),
    month: (absolute % 12) + 1,
  };
}

export function getTodayIstValue() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return toDateValue(get('year'), get('month'), get('day'));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mondayFirstWeekday(year, month, day) {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (jsDay + 6) % 7;
}

function formatDisplayValue(value) {
  const parsed = parseDateValue(value);
  if (!parsed) return null;
  return DISPLAY_FORMATTER.format(
    new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12)),
  );
}

export function buildMonthCells(year, month) {
  const totalDays = daysInMonth(year, month);
  const offset = mondayFirstWeekday(year, month, 1);
  const cells = [];

  for (let i = 0; i < offset; i += 1) {
    cells.push({ key: `pad-${year}-${month}-${i}`, empty: true });
  }

  for (let day = 1; day <= totalDays; day += 1) {
    cells.push({
      key: toDateValue(year, month, day),
      empty: false,
      day,
      value: toDateValue(year, month, day),
    });
  }

  return cells;
}

/**
 * Themed date picker (YYYY-MM-DD). Interaction model matches SelectField:
 * - options/days activate on click
 * - outside dismiss on document mousedown (bubble)
 * - portal panel so parents cannot clip or intercept
 */
export default function DateField({
  value,
  onChange,
  placeholder = 'Select date',
  disabled = false,
  id: idProp,
  min,
  max,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className = '',
}) {
  const reactId = useId();
  const id = idProp ?? reactId;
  const dialogId = `${id}-dialog`;

  const [open, setOpen] = useState(false);
  const [todayValue, setTodayValue] = useState(getTodayIstValue);
  const [position, setPosition] = useState({ top: 0, left: 0, width: PANEL_WIDTH, ready: false });

  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const ignoreTriggerClickRef = useRef(false);
  const onChangeRef = useRef(onChange);

  const selected = parseDateValue(value);
  const initial = selected ?? parseDateValue(todayValue) ?? {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
  };
  const [viewYear, setViewYear] = useState(initial.year);
  const [viewMonth, setViewMonth] = useState(initial.month);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const close = useCallback(() => {
    setOpen(false);
    setPosition((prev) => ({ ...prev, ready: false }));
  }, []);

  const openPicker = useCallback(() => {
    if (disabled) return;
    const today = getTodayIstValue();
    setTodayValue(today);
    const next = parseDateValue(value) ?? parseDateValue(today);
    if (next) {
      setViewYear(next.year);
      setViewMonth(next.month);
    }
    setPosition((prev) => ({ ...prev, ready: false }));
    setOpen(true);
  }, [disabled, value]);

  useEscapeKey(open, close);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return undefined;

    const rect = triggerRef.current.getBoundingClientRect();
    const width = PANEL_WIDTH;
    const panelHeight = panelRef.current.offsetHeight;

    let left = rect.left;
    left = Math.max(VIEWPORT_PADDING, left);
    if (left + width > window.innerWidth - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
    }

    let top = rect.bottom + GAP;
    if (top + panelHeight > window.innerHeight - VIEWPORT_PADDING) {
      const above = rect.top - panelHeight - GAP;
      if (above >= VIEWPORT_PADDING) {
        top = above;
      } else {
        top = Math.max(VIEWPORT_PADDING, window.innerHeight - panelHeight - VIEWPORT_PADDING);
      }
    }

    setPosition({ top, left, width, ready: true });
    return undefined;
  }, [open, viewYear, viewMonth]);

  useEffect(() => {
    if (!open) return undefined;

    function handleMouseDown(event) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      close();
    }

    function handleScroll() {
      close();
    }

    // Bubble phase — same proven pattern as SelectField (not capture).
    document.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open, close]);

  const cells = useMemo(() => buildMonthCells(viewYear, viewMonth), [viewYear, viewMonth]);
  const monthName = MONTH_NAME_FORMATTER.format(new Date(Date.UTC(viewYear, viewMonth - 1, 1)));
  const displayLabel = formatDisplayValue(value) ?? placeholder;

  function isOutOfRange(dateValue) {
    if (min && dateValue < min) return true;
    if (max && dateValue > max) return true;
    return false;
  }

  function commitDate(dateValue) {
    if (disabled || isOutOfRange(dateValue)) return;

    // Prevent the synthetic click from hitting the trigger after the panel unmounts.
    ignoreTriggerClickRef.current = true;
    window.setTimeout(() => {
      ignoreTriggerClickRef.current = false;
    }, 100);

    onChangeRef.current(dateValue);
    setOpen(false);
  }

  function handleShiftMonth(delta) {
    const next = shiftYearMonth(viewYear, viewMonth, delta);
    setViewYear(next.year);
    setViewMonth(next.month);
  }

  function handleShiftYear(delta) {
    setViewYear((year) => year + delta);
  }

  function handleTriggerClick() {
    if (disabled || ignoreTriggerClickRef.current) return;
    if (open) close();
    else openPicker();
  }

  function handleTriggerKeyDown(event) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) openPicker();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={[
          'date-field',
          open ? 'date-field--open' : '',
          disabled ? 'date-field--disabled' : '',
          !selected ? 'date-field--placeholder' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="date-field__value">{displayLabel}</span>
        <span className="date-field__icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M2 6.5h12" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M5 1.5v3M11 1.5v3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </span>
      </button>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={dialogId}
              role="dialog"
              aria-modal="true"
              aria-label="Choose date"
              className="date-field__panel"
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                visibility: position.ready ? 'visible' : 'hidden',
              }}
            >
              <div className="date-field__toolbar">
                <div className="date-field__toolbar-row">
                  <button
                    type="button"
                    className="date-field__nav date-field__nav--compact"
                    aria-label="Previous year"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleShiftYear(-1)}
                  >
                    ‹
                  </button>
                  <span className="date-field__year" aria-live="polite">
                    {viewYear}
                  </span>
                  <button
                    type="button"
                    className="date-field__nav date-field__nav--compact"
                    aria-label="Next year"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleShiftYear(1)}
                  >
                    ›
                  </button>
                </div>
                <div className="date-field__toolbar-row">
                  <button
                    type="button"
                    className="date-field__nav date-field__nav--compact"
                    aria-label="Previous month"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleShiftMonth(-1)}
                  >
                    ‹
                  </button>
                  <span className="date-field__month" aria-live="polite">
                    {monthName}
                  </span>
                  <button
                    type="button"
                    className="date-field__nav date-field__nav--compact"
                    aria-label="Next month"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleShiftMonth(1)}
                  >
                    ›
                  </button>
                </div>
              </div>

              <div className="date-field__weekdays" aria-hidden="true">
                {WEEKDAYS.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>

              <div className="date-field__grid">
                {cells.map((cell) =>
                  cell.empty ? (
                    <span key={cell.key} className="date-field__day date-field__day--empty" />
                  ) : (
                    <button
                      key={cell.key}
                      type="button"
                      className={[
                        'date-field__day',
                        cell.value === value ? 'date-field__day--selected' : '',
                        cell.value === todayValue ? 'date-field__day--today' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      disabled={isOutOfRange(cell.value)}
                      aria-label={cell.value}
                      aria-pressed={cell.value === value}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => commitDate(cell.value)}
                    >
                      {cell.day}
                    </button>
                  ),
                )}
              </div>

              <div className="date-field__footer">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={isOutOfRange(todayValue)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commitDate(todayValue)}
                >
                  Today
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
