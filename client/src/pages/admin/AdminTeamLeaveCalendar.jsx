import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createHolidaySchema, createHolidayCategorySchema, updateHolidayCategorySchema } from '@shared/validation/holidays.js';
import { getISTDateInputValue } from '../../utils/datetime.js';
import { getErrorMessage, leaveApi } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import DateField from '../../components/DateField.jsx';
import SelectField from '../../components/SelectField.jsx';

const BUILT_IN_CATEGORIES = [
  { value: 'public', label: 'Public holiday', color: 'var(--error)' },
  { value: 'restricted', label: 'Restricted holiday (RH)', color: '#3b82f6' },
  { value: 'event', label: 'Company event', color: 'var(--success)' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const VIEW_TYPES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function currentYear() {
  return Number(getISTDateInputValue().slice(0, 4));
}

function currentMonthIndex() {
  return Number(getISTDateInputValue().slice(5, 7)) - 1;
}

function emptyForm(date = getISTDateInputValue()) {
  return { date, name: '', type: 'public' };
}

function dateKey(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidDateKey(value) {
  if (!value || !DATE_KEY_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function parseDateKey(value) {
  if (!isValidDateKey(value)) return null;
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

function addDaysToKey(value, delta) {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + delta));
  return dateKey(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

function mondayOfWeek(value) {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const jsDay = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const offset = (jsDay + 6) % 7;
  return addDaysToKey(value, -offset);
}

function weekDates(mondayKey) {
  return Array.from({ length: 7 }, (_, index) => addDaysToKey(mondayKey, index));
}

function monthCells(year, monthIndex) {
  const firstWeekday = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
}

function formatDayLabel(value) {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  return `${parsed.day} ${MONTHS[parsed.month - 1].slice(0, 3)}`;
}

function formatDayWithYear(value) {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  return `${parsed.day} ${MONTHS[parsed.month - 1].slice(0, 3)} ${parsed.year}`;
}

export default function AdminTeamLeaveCalendar() {
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [year, setYear] = useState(currentYear);
  const [viewType, setViewType] = useState('monthly');
  const [focusedMonth, setFocusedMonth] = useState(currentMonthIndex);
  const [weekAnchor, setWeekAnchor] = useState(() => mondayOfWeek(getISTDateInputValue()));
  const [holidays, setHolidays] = useState([]);
  const [customCategories, setCustomCategories] = useState([]);
  // Initial selection: today (visible in the default monthly/weekly view).
  // The original yearly view defaulted to Jan 1; that reset is preserved on year changes below.
  const [form, setForm] = useState(() => emptyForm(getISTDateInputValue()));
  const [categoryForm, setCategoryForm] = useState({ name: '', color: '#8b5cf6' });
  const [categoryEditingId, setCategoryEditingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [categoryError, setCategoryError] = useState('');
  const [categoryFieldErrors, setCategoryFieldErrors] = useState({});
  const [addingCategory, setAddingCategory] = useState(false);
  const [recurringRules, setRecurringRules] = useState([]);
  const [recurringForm, setRecurringForm] = useState({
    nth: 2,
    weekday: 6,
    months: 'all',
    type: 'public',
    name: '',
  });
  const [expandedMonth, setExpandedMonth] = useState(null);
  const categoryDialogTitleId = useId();
  const yearsLoadedRef = useRef(new Set());

  const todayKey = getISTDateInputValue();

  function closeCategoryDialog() {
    setAddingCategory(false);
    setCategoryEditingId(null);
    setCategoryError('');
    setCategoryFieldErrors({});
  }

  useEscapeKey(addingCategory, closeCategoryDialog);
  useEscapeKey(expandedMonth != null, () => setExpandedMonth(null));

  function mergeHolidays(current, fetchedYear, fetched) {
    const prefix = `${fetchedYear}-`;
    const kept = current.filter((holiday) => {
      const key = holiday.dateInput ?? '';
      return !key.startsWith(prefix);
    });
    return [...kept, ...fetched];
  }

  async function ensureYearsLoaded(targetYears) {
    const missing = [...new Set(targetYears)].filter((value) => !yearsLoadedRef.current.has(value));
    if (missing.length === 0) return;
    const results = await Promise.all(
      missing.map(async (targetYear) => {
        const data = await leaveApi.listHolidays({ year: targetYear });
        return { targetYear, list: Array.isArray(data.holidays) ? data.holidays : [] };
      }),
    );
    setHolidays((current) => {
      let next = current;
      for (const { targetYear, list } of results) {
        next = mergeHolidays(next, targetYear, list);
        yearsLoadedRef.current.add(targetYear);
      }
      return [...next];
    });
  }

  async function loadHolidays() {
    setLoading(true);
    setError('');
    try {
      const data = await leaveApi.listHolidays({ year });
      const list = Array.isArray(data.holidays) ? data.holidays : [];
      yearsLoadedRef.current.add(year);
      setHolidays((current) => mergeHolidays(current, year, list));
    } catch (err) {
      setHolidays((current) => current.filter((holiday) => !(holiday.dateInput ?? '').startsWith(`${year}-`)));
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadCategories() {
    try {
      const data = await leaveApi.listHolidayCategories();
      setCustomCategories(Array.isArray(data.categories) ? data.categories : []);
    } catch {
      setCustomCategories([]);
    }
  }

  // Pure data loader: selection/focus resets are owned explicitly by the
  // navigation handlers below, so selecting a date in another year (or
  // StrictMode's double-invocation on mount) can never wipe the form.
  useEffect(() => {
    loadHolidays();
  }, [year]);

  useEffect(() => {
    loadCategories();
    leaveApi.listRecurringHolidayRules().then((data) => {
      setRecurringRules(Array.isArray(data.rules) ? data.rules : []);
    }).catch(() => setRecurringRules([]));
  }, []);

  const categoryOptions = useMemo(
    () => [
      ...BUILT_IN_CATEGORIES,
      ...customCategories.map((category) => ({
        value: category.slug,
        label: category.name,
        color: category.color,
        id: category.id,
        isCustom: true,
      })),
    ],
    [customCategories],
  );

  const categoriesByValue = useMemo(
    () => new Map(categoryOptions.map((category) => [category.value, category])),
    [categoryOptions],
  );

  const holidaysByDate = useMemo(
    () => new Map(holidays.map((holiday) => [holiday.dateInput ?? getISTDateInputValue(new Date(holiday.date)), holiday])),
    [holidays],
  );

  const currentWeekKeys = useMemo(() => weekDates(weekAnchor), [weekAnchor]);

  const weekRangeLabel = useMemo(() => {
    const first = currentWeekKeys[0];
    const last = currentWeekKeys[6];
    const start = parseDateKey(first);
    const end = parseDateKey(last);
    if (!start || !end) return `${first} – ${last}`;
    if (start.year !== end.year) return `${formatDayWithYear(first)} – ${formatDayWithYear(last)}`;
    if (start.month !== end.month) return `${formatDayLabel(first)} – ${formatDayWithYear(last)}`;
    return `${start.day}–${end.day} ${MONTHS[start.month - 1]} ${start.year}`;
  }, [currentWeekKeys]);

  const monthHolidays = useMemo(() => {
    const prefix = `${year}-${String(focusedMonth + 1).padStart(2, '0')}-`;
    return holidays
      .filter((holiday) => (holiday.dateInput ?? '').startsWith(prefix))
      .slice()
      .sort((a, b) => (a.dateInput ?? '').localeCompare(b.dateInput ?? ''));
  }, [holidays, year, focusedMonth]);

  const calendarAriaLabel = useMemo(() => {
    if (viewType === 'monthly') return `${MONTHS[focusedMonth]} ${year} company calendar`;
    if (viewType === 'weekly') return `Week of ${weekRangeLabel} company calendar`;
    return `${year} company calendar`;
  }, [viewType, focusedMonth, year, weekRangeLabel]);

  function resetForm(date = `${year}-01-01`) {
    setEditingId(null);
    setFieldErrors({});
    setForm(emptyForm(date));
  }

  function syncFocusToDate(date) {
    const parsed = parseDateKey(date);
    if (!parsed) return;
    setFocusedMonth(parsed.month - 1);
    setWeekAnchor(mondayOfWeek(date));
    if (parsed.year !== year) {
      setYear(parsed.year);
    } else if (viewType === 'weekly') {
      const needed = new Set(weekDates(mondayOfWeek(date)).map((key) => Number(key.slice(0, 4))));
      const missing = [...needed].filter((value) => !yearsLoadedRef.current.has(value));
      if (missing.length > 0) {
        ensureYearsLoaded(missing).catch(() => {});
      }
    }
  }

  function selectDate(date) {
    const holiday = holidaysByDate.get(date);
    setError('');
    setFieldErrors({});
    syncFocusToDate(date);
    if (holiday) {
      setEditingId(holiday.id);
      setForm({
        date: holiday.dateInput,
        name: holiday.name,
        type: holiday.type ?? 'public',
      });
      return;
    }
    resetForm(date);
  }

  function handleFormDateChange(date) {
    setForm((current) => ({ ...current, date }));
    syncFocusToDate(date);
  }

  function goToYear(delta) {
    const next = year + delta;
    resetForm(`${next}-01-01`);
    setYear(next);
  }

  function goToMonth(delta) {
    const absolute = year * 12 + focusedMonth + delta;
    const nextYear = Math.floor(absolute / 12);
    const nextMonth = absolute - nextYear * 12;
    setFocusedMonth(nextMonth);
    if (nextYear !== year) {
      // Land the selection on the first of the newly focused month so it stays visible.
      resetForm(`${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-01`);
      setYear(nextYear);
    }
  }

  function goToWeek(delta) {
    const nextAnchor = addDaysToKey(weekAnchor, delta * 7);
    const nextMondayYear = Number(nextAnchor.slice(0, 4));
    const needed = new Set(
      weekDates(nextAnchor)
        .map((key) => parseDateKey(key))
        .filter(Boolean)
        .map((parsed) => parsed.year),
    );
    setWeekAnchor(nextAnchor);
    const yearChanged = nextMondayYear !== year;
    if (yearChanged) {
      // Land the selection on the newly focused Monday so it stays visible.
      resetForm(nextAnchor);
      // The year effect loads nextMondayYear; silently fetch any straddled second year.
      setYear(nextMondayYear);
    }
    const pendingYear = yearChanged ? nextMondayYear : null;
    const missing = [...needed].filter((value) => value !== pendingYear && !yearsLoadedRef.current.has(value));
    if (missing.length > 0) {
      ensureYearsLoaded(missing).catch(() => {});
    }
  }

  function goToToday() {
    const today = getISTDateInputValue();
    const todayYear = Number(today.slice(0, 4));
    setFocusedMonth(Number(today.slice(5, 7)) - 1);
    setWeekAnchor(mondayOfWeek(today));
    // Today is the default selection: focus and form move together.
    resetForm(today);
    if (todayYear !== year) {
      setYear(todayYear);
    }
  }

  function handleViewTypeChange(next) {
    // Switching views never moves the focused month/week or the form selection:
    // focusedMonth and weekAnchor persist as independent state, so returning to
    // monthly/weekly always lands back where the user was (e.g. September).
    setViewType(next);
    if (next === 'weekly') {
      // Silently fetch the straddled second year when the visible week spans two years.
      const needed = weekDates(weekAnchor)
        .map((key) => parseDateKey(key))
        .filter(Boolean)
        .map((item) => item.year)
        .filter((value) => value !== year && !yearsLoadedRef.current.has(value));
      if (needed.length > 0) {
        ensureYearsLoaded([...new Set(needed)]).catch(() => {});
      }
    }
  }

  function renderDayButton(key, day, onSelect) {
    const holiday = holidaysByDate.get(key);
    const category = categoriesByValue.get(holiday?.type) ?? BUILT_IN_CATEGORIES[0];
    return (
      <button
        key={key}
        type="button"
        className={`calendar-management__day${holiday ? ' calendar-management__day--categorized' : ''}${form.date === key ? ' calendar-management__day--selected' : ''}${key === todayKey ? ' calendar-management__day--today' : ''}`}
        style={holiday ? { '--calendar-category-color': category.color } : undefined}
        onClick={() => {
          selectDate(key);
          onSelect?.(key);
        }}
        title={holiday ? `${holiday.name} — ${category.label}` : `Add calendar entry for ${key}`}
        aria-label={holiday ? `${key}: ${holiday.name}` : `Add calendar entry for ${key}`}
        aria-pressed={form.date === key}
      >
        {day}
      </button>
    );
  }

  function renderMonthGrid(targetYear, monthIndex, { large = false, showModalTrigger = false } = {}) {
    const monthName = MONTHS[monthIndex];
    return (
      <section
        key={`${targetYear}-${monthName}`}
        className={`calendar-management__month${large ? ' calendar-management__month--single' : ''}`}
        aria-label={`${monthName} ${targetYear}`}
      >
        {showModalTrigger ? (
          <button
            type="button"
            className="calendar-management__month-title"
            onClick={() => setExpandedMonth(monthIndex)}
          >
            {monthName}
          </button>
        ) : (
          <h2 className="calendar-management__month-heading">{monthName}</h2>
        )}
        <div className="calendar-management__weekdays" aria-hidden="true">
          {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday.slice(0, 1)}</span>)}
        </div>
        <div className="calendar-management__days">
          {monthCells(targetYear, monthIndex).map((day, index) => {
            if (!day) return <span key={`empty-${index}`} className="calendar-management__day calendar-management__day--empty" />;
            return renderDayButton(dateKey(targetYear, monthIndex, day), day);
          })}
        </div>
      </section>
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    const validation = validateForm(createHolidaySchema, form);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      return;
    }

    setSaving(true);
    setFieldErrors({});
    try {
      let result;
      if (editingId) {
        result = await leaveApi.updateHoliday(editingId, validation.data);
        showSuccess('Calendar entry updated.');
      } else {
        result = await leaveApi.createHoliday(validation.data);
        showSuccess('Calendar entry added.');
      }
      const savedYear = Number((result.holiday.dateInput ?? validation.data.date).slice(0, 4));
      yearsLoadedRef.current.add(savedYear);
      setHolidays((current) => {
        const saved = result.holiday;
        return editingId
          ? current.map((holiday) => (holiday.id === saved.id ? saved : holiday))
          : [...current.filter((holiday) => holiday.id !== saved.id), saved];
      });
      resetForm(validation.data.date);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingId) return;
    const name = form.name || 'this calendar entry';
    await requestConfirm({
      title: 'Delete calendar entry?',
      message: `Delete ${name}? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        await leaveApi.deleteHoliday(editingId);
        showSuccess('Calendar entry deleted.');
        // Default selection is today; fall back to Jan 1 only when today lies
        // outside the currently viewed year, keeping the form coherent with the view.
        const today = getISTDateInputValue();
        resetForm(today.startsWith(`${year}-`) ? today : `${year}-01-01`);
        yearsLoadedRef.current.delete(year);
        await loadHolidays();
      },
    });
  }

  async function handleCategorySubmit(event) {
    event.preventDefault();
    setCategoryError('');
    const schema = categoryEditingId ? updateHolidayCategorySchema : createHolidayCategorySchema;
    const validation = validateForm(schema, categoryForm);
    if (!validation.data) {
      setCategoryFieldErrors(validation.errors);
      return;
    }

    setCategoryFieldErrors({});
    try {
      const data = categoryEditingId
        ? await leaveApi.updateHolidayCategory(categoryEditingId, validation.data)
        : await leaveApi.createHolidayCategory(validation.data);
      await loadCategories();
      setForm((current) => ({ ...current, type: data.category.slug }));
      setCategoryForm({ name: '', color: '#8b5cf6' });
      closeCategoryDialog();
    } catch (err) {
      setCategoryError(getErrorMessage(err));
    }
  }

  function openCategoryDialog(category = null) {
    setCategoryError('');
    setCategoryFieldErrors({});
    setCategoryEditingId(category?.id ?? null);
    setCategoryForm(category ? { name: category.label, color: category.color } : { name: '', color: '#8b5cf6' });
    setAddingCategory(true);
  }

  async function handleCategoryDelete() {
    if (!categoryEditingId) return;
    await requestConfirm({
      title: 'Delete category?',
      message: 'Entries in this category will be moved to Public holiday. This cannot be undone.',
      confirmLabel: 'Delete category',
      variant: 'danger',
      onConfirm: async () => {
        await leaveApi.deleteHolidayCategory(categoryEditingId);
        await loadCategories();
        setForm((current) => ({ ...current, type: 'public' }));
        closeCategoryDialog();
      },
    });
  }

  async function handleMaterializeRecurring() {
    setSaving(true);
    setError('');
    try {
      const result = await leaveApi.materializeRecurringHolidays({ year });
      showSuccess(`Generated ${result.created?.length ?? 0} holiday dates for ${year}.`);
      yearsLoadedRef.current.delete(year);
      await loadHolidays();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveRecurringRules(nextRules) {
    const data = await leaveApi.updateRecurringHolidayRules({ rules: nextRules });
    setRecurringRules(data.rules ?? nextRules);
  }

  async function addRecurringRule(event) {
    event.preventDefault();
    if (!recurringForm.name.trim()) return;
    const nextRules = [...recurringRules, { ...recurringForm, name: recurringForm.name.trim() }];
    await saveRecurringRules(nextRules);
    setRecurringForm({ nth: 2, weekday: 6, months: 'all', type: 'public', name: '' });
    showSuccess('Recurring rule added.');
  }

  return (
    <div className="page page--calendar-management">
      {error ? (
        <div className="page-alerts">
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <div className="calendar-management__layout">
        <section className="calendar-management__calendar card" aria-label={calendarAriaLabel}>
          <div className="calendar-management__toolbar">
            <div className="calendar-management__nav" aria-label={viewType === 'monthly' ? 'Calendar month' : viewType === 'weekly' ? 'Calendar week' : 'Calendar year'}>
              {viewType === 'yearly' ? (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToYear(-1)} aria-label="Previous year">
                    ‹
                  </button>
                  <strong aria-live="polite">{year}</strong>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToYear(1)} aria-label="Next year">
                    ›
                  </button>
                </>
              ) : null}
              {viewType === 'monthly' ? (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToMonth(-1)} aria-label="Previous month">
                    ‹
                  </button>
                  <strong aria-live="polite">{MONTHS[focusedMonth]} {year}</strong>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToMonth(1)} aria-label="Next month">
                    ›
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm calendar-management__today-btn" onClick={goToToday}>
                    Today
                  </button>
                </>
              ) : null}
              {viewType === 'weekly' ? (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToWeek(-1)} aria-label="Previous week">
                    ‹
                  </button>
                  <strong aria-live="polite">{weekRangeLabel}</strong>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToWeek(1)} aria-label="Next week">
                    ›
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm calendar-management__today-btn" onClick={goToToday}>
                    Today
                  </button>
                </>
              ) : null}
            </div>
            <div className="calendar-management__view-switcher" role="tablist" aria-label="Calendar view type">
              <span className="calendar-management__view-label" aria-hidden="true">View:</span>
              {VIEW_TYPES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={viewType === option.value}
                  className={`calendar-management__view-btn${viewType === option.value ? ' calendar-management__view-btn--active' : ''}`}
                  onClick={() => handleViewTypeChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="calendar-management__legend" aria-label="Calendar legend">
              {categoryOptions.map((category) => (
                <button key={category.value} type="button" className={`calendar-management__legend-item${category.isCustom ? ' calendar-management__legend-item--editable' : ''}`} onClick={category.isCustom ? () => openCategoryDialog(category) : undefined} title={category.isCustom ? `Edit ${category.label}` : undefined}>
                  <i className="calendar-management__legend-dot" style={{ background: category.color }} aria-hidden="true" />
                  {category.label}
                </button>
              ))}
              <button type="button" className="calendar-management__add-category" onClick={() => openCategoryDialog()}>+ Add category</button>
            </div>
          </div>

          {loading ? (
            <div className="calendar-management__loading" aria-busy="true">
              <div className="skeleton skeleton--calendar" />
            </div>
          ) : null}
          {!loading && viewType === 'yearly' ? (
            <div className="calendar-management__months">
              {MONTHS.map((monthName, monthIndex) => renderMonthGrid(year, monthIndex, { showModalTrigger: true }))}
            </div>
          ) : null}
          {!loading && viewType === 'monthly' ? (
            <div className="calendar-management__single-view">
              {renderMonthGrid(year, focusedMonth, { large: true })}
              <section className="calendar-management__month-events" aria-label={`Holidays in ${MONTHS[focusedMonth]} ${year}`}>
                <h3 className="calendar-management__month-events-title">
                  {MONTHS[focusedMonth]} entries ({monthHolidays.length})
                </h3>
                {monthHolidays.length === 0 ? (
                  <p className="muted small">No entries this month. Select a date to add one.</p>
                ) : (
                  <ul className="calendar-management__event-list">
                    {monthHolidays.map((holiday) => {
                      const category = categoriesByValue.get(holiday?.type) ?? BUILT_IN_CATEGORIES[0];
                      return (
                        <li key={holiday.id}>
                          <button
                            type="button"
                            className="calendar-management__event-item"
                            onClick={() => selectDate(holiday.dateInput)}
                            title={`${holiday.name} — ${category.label}`}
                          >
                            <i className="calendar-management__legend-dot" style={{ background: category.color }} aria-hidden="true" />
                            <span className="calendar-management__event-date">{formatDayLabel(holiday.dateInput)}</span>
                            <span className="calendar-management__event-name">{holiday.name}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          ) : null}
          {!loading && viewType === 'weekly' ? (
            <div className="calendar-management__week-grid" role="list" aria-label={`Week of ${weekRangeLabel}`}>
              {currentWeekKeys.map((key, index) => {
                const holiday = holidaysByDate.get(key);
                const category = categoriesByValue.get(holiday?.type) ?? BUILT_IN_CATEGORIES[0];
                const parsed = parseDateKey(key);
                return (
                  <div
                    key={key}
                    role="listitem"
                    className={`calendar-management__week-day${key === todayKey ? ' calendar-management__week-day--today' : ''}${form.date === key ? ' calendar-management__week-day--selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="calendar-management__week-day-head"
                      onClick={() => selectDate(key)}
                      title={holiday ? `${holiday.name} — ${category.label}` : `Add calendar entry for ${key}`}
                      aria-label={holiday ? `${WEEKDAYS_FULL[index]} ${key}: ${holiday.name}` : `Add calendar entry for ${WEEKDAYS_FULL[index]} ${key}`}
                      aria-pressed={form.date === key}
                    >
                      <span className="calendar-management__week-day-name">{WEEKDAYS[index]}</span>
                      <span className="calendar-management__week-day-number">{parsed?.day}</span>
                      <span className="calendar-management__week-day-month">{parsed ? MONTHS[parsed.month - 1].slice(0, 3) : ''}</span>
                    </button>
                    {holiday ? (
                      <button
                        type="button"
                        className="calendar-management__week-holiday"
                        style={{ '--calendar-category-color': category.color }}
                        onClick={() => selectDate(key)}
                        title={`${holiday.name} — ${category.label}`}
                      >
                        <i className="calendar-management__legend-dot" style={{ background: category.color }} aria-hidden="true" />
                        <span>{holiday.name}</span>
                      </button>
                    ) : (
                      <span className="calendar-management__week-empty" aria-hidden="true">—</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>

        <aside className="calendar-management__editor card">
          <div>
            <h2 className="card__section-title">{editingId ? 'Edit calendar entry' : 'Add new holiday'}</h2>
            <p className="calendar-management__editor-hint">Add public or restricted holidays and company events.</p>
          </div>
          <form className="calendar-management__form" onSubmit={handleSubmit}>
            <label>
              <span className="label">Date</span>
              <DateField value={form.date} onChange={handleFormDateChange} aria-label="Holiday date" />
              <FieldError message={fieldErrors.date} />
            </label>
            <label>
              <span className="label">Holiday name</span>
              <input type="text" placeholder="e.g. Independence Day" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              <FieldError message={fieldErrors.name} />
            </label>
            <label>
              <span className="label">Holiday type</span>
              <SelectField value={form.type} onChange={(type) => setForm({ ...form, type })} options={categoryOptions.map((category) => ({ value: category.value, label: category.label }))} aria-label="Holiday type" />
              <FieldError message={fieldErrors.type} />
            </label>
            <div className="calendar-management__form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Add holiday'}</button>
              {editingId ? <button type="button" className="btn btn-ghost" onClick={() => resetForm(form.date)}>Cancel</button> : null}
            </div>
            {editingId ? <button type="button" className="calendar-management__delete" onClick={handleDelete}>Delete entry</button> : null}
          </form>

          <div className="calendar-management__recurring">
            <h3 className="card__section-title">Recurring rules</h3>
            <p className="muted small">Rules materialize dates for a year (e.g. 2nd Saturday every month).</p>
            <ul className="calendar-management__recurring-list">
              {recurringRules.map((rule, index) => (
                <li key={`${rule.name}-${index}`}>
                  {rule.name} — {rule.nth === -1 ? 'Last' : `${rule.nth}${rule.nth === 1 ? 'st' : rule.nth === 2 ? 'nd' : rule.nth === 3 ? 'rd' : 'th'}`}{' '}
                  {WEEKDAYS[rule.weekday === 0 ? 6 : rule.weekday - 1]}
                </li>
              ))}
            </ul>
            <form className="calendar-management__recurring-form" onSubmit={addRecurringRule}>
              <input
                type="text"
                placeholder="Holiday name"
                value={recurringForm.name}
                onChange={(event) => setRecurringForm({ ...recurringForm, name: event.target.value })}
              />
              <button type="submit" className="btn btn-ghost btn-sm">Add rule</button>
            </form>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleMaterializeRecurring} disabled={saving}>
              Generate {year} dates
            </button>
          </div>
        </aside>
      </div>
      {expandedMonth != null
        ? createPortal(
            <div className="modal__backdrop" role="presentation" onClick={() => setExpandedMonth(null)}>
              <div className="modal modal--compact" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <header className="modal__header">
                  <h2 className="modal__title">{MONTHS[expandedMonth]} {year}</h2>
                </header>
                <div className="modal__body calendar-management__month-modal">
                  <div className="calendar-management__weekdays" aria-hidden="true">
                    {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday.slice(0, 1)}</span>)}
                  </div>
                  <div className="calendar-management__days calendar-management__days--expanded">
                    {monthCells(year, expandedMonth).map((day, index) => {
                      if (!day) return <span key={`empty-${index}`} className="calendar-management__day calendar-management__day--empty" />;
                      return renderDayButton(dateKey(year, expandedMonth, day), day, () => setExpandedMonth(null));
                    })}
                  </div>
                </div>
                <footer className="modal__footer">
                  <button type="button" className="btn btn-ghost" onClick={() => setExpandedMonth(null)}>Close</button>
                </footer>
              </div>
            </div>,
            document.body,
          )
        : null}
      {addingCategory
        ? createPortal(
            <div className="modal__backdrop" role="presentation" onClick={closeCategoryDialog}>
              <div className="modal modal--compact calendar-management__category-modal" role="dialog" aria-modal="true" aria-labelledby={categoryDialogTitleId} onClick={(event) => event.stopPropagation()}>
                <header className="modal__header">
                  <h2 id={categoryDialogTitleId} className="modal__title">{categoryEditingId ? 'Edit category' : 'Add category'}</h2>
                  <p className="modal__lead muted">Choose a name and color for this calendar category.</p>
                </header>
                <form className="modal__form" onSubmit={handleCategorySubmit}>
                  <div className="modal__body">
                    <label className="modal__field"><span className="label">Category name</span><input autoFocus type="text" placeholder="e.g. Optional holiday" value={categoryForm.name} onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })} /><FieldError message={categoryFieldErrors.name} /></label>
                    <fieldset className="modal__field calendar-management__color-field"><legend className="label">Color</legend><div className="calendar-management__color-palette">{CATEGORY_COLORS.map((color) => <button key={color} type="button" className={`calendar-management__color-swatch${categoryForm.color === color ? ' calendar-management__color-swatch--selected' : ''}`} style={{ background: color }} aria-label={`Choose ${color}`} aria-pressed={categoryForm.color === color} onClick={() => setCategoryForm({ ...categoryForm, color })} />)}</div><FieldError message={categoryFieldErrors.color} /></fieldset>
                    {categoryError ? <p className="field-error">{categoryError}</p> : null}
                  </div>
                  <footer className="modal__footer">{categoryEditingId ? <button type="button" className="btn btn-danger" onClick={handleCategoryDelete}>Delete</button> : null}<span className="calendar-management__modal-spacer" /><button type="button" className="btn btn-ghost" onClick={closeCategoryDialog}>Cancel</button><button type="submit" className="btn btn-primary">{categoryEditingId ? 'Save category' : 'Add category'}</button></footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
      {confirmDialog}
    </div>
  );
}
