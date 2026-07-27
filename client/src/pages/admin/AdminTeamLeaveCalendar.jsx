import { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createHolidaySchema } from '@shared/validation/holidays.js';
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
const CATEGORY_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899'];

function currentYear() {
  return Number(getISTDateInputValue().slice(0, 4));
}

function emptyForm(date = getISTDateInputValue()) {
  return { date, name: '', type: 'public' };
}

function dateKey(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthCells(year, monthIndex) {
  const firstWeekday = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
}

export default function AdminTeamLeaveCalendar() {
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [year, setYear] = useState(currentYear);
  const [holidays, setHolidays] = useState([]);
  const [customCategories, setCustomCategories] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [categoryForm, setCategoryForm] = useState({ name: '', color: '#8b5cf6' });
  const [categoryEditingId, setCategoryEditingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [categoryError, setCategoryError] = useState('');
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

  function closeCategoryDialog() {
    setAddingCategory(false);
    setCategoryEditingId(null);
    setCategoryError('');
  }

  useEscapeKey(addingCategory, closeCategoryDialog);
  useEscapeKey(expandedMonth != null, () => setExpandedMonth(null));

  async function loadHolidays() {
    setLoading(true);
    setError('');
    try {
      const data = await leaveApi.listHolidays({ year });
      setHolidays(Array.isArray(data.holidays) ? data.holidays : []);
    } catch (err) {
      setHolidays([]);
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

  useEffect(() => {
    setEditingId(null);
    setFieldErrors({});
    setForm(emptyForm(`${year}-01-01`));
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

  function resetForm(date = `${year}-01-01`) {
    setEditingId(null);
    setFieldErrors({});
    setForm(emptyForm(date));
  }

  function selectDate(date) {
    const holiday = holidaysByDate.get(date);
    setError('');
    setFieldErrors({});
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
        resetForm(`${year}-01-01`);
        await loadHolidays();
      },
    });
  }

  async function handleCategorySubmit(event) {
    event.preventDefault();
    setCategoryError('');
    try {
      const data = categoryEditingId
        ? await leaveApi.updateHolidayCategory(categoryEditingId, categoryForm)
        : await leaveApi.createHolidayCategory(categoryForm);
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
        <section className="calendar-management__calendar card" aria-label={`${year} company calendar`}>
          <div className="calendar-management__toolbar">
            <div className="calendar-management__year-nav" aria-label="Calendar year">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setYear((value) => value - 1)} aria-label="Previous year">
                ‹
              </button>
              <strong>{year}</strong>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setYear((value) => value + 1)} aria-label="Next year">
                ›
              </button>
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
          ) : (
            <div className="calendar-management__months">
              {MONTHS.map((monthName, monthIndex) => (
                <section key={monthName} className="calendar-management__month" aria-label={`${monthName} ${year}`}>
                  <button
                    type="button"
                    className="calendar-management__month-title"
                    onClick={() => setExpandedMonth(monthIndex)}
                  >
                    {monthName}
                  </button>
                  <div className="calendar-management__weekdays" aria-hidden="true">
                    {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday.slice(0, 1)}</span>)}
                  </div>
                  <div className="calendar-management__days">
                    {monthCells(year, monthIndex).map((day, index) => {
                      if (!day) return <span key={`empty-${index}`} className="calendar-management__day calendar-management__day--empty" />;
                      const key = dateKey(year, monthIndex, day);
                      const holiday = holidaysByDate.get(key);
                      const category = categoriesByValue.get(holiday?.type) ?? BUILT_IN_CATEGORIES[0];
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`calendar-management__day${holiday ? ' calendar-management__day--categorized' : ''}${form.date === key ? ' calendar-management__day--selected' : ''}`}
                          style={holiday ? { '--calendar-category-color': category.color } : undefined}
                          onClick={() => selectDate(key)}
                          title={holiday ? `${holiday.name} — ${category.label}` : `Add calendar entry for ${key}`}
                          aria-label={holiday ? `${key}: ${holiday.name}` : `Add calendar entry for ${key}`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>

        <aside className="calendar-management__editor card">
          <div>
            <h2 className="card__section-title">{editingId ? 'Edit calendar entry' : 'Add new holiday'}</h2>
            <p className="calendar-management__editor-hint">Add public or restricted holidays and company events.</p>
          </div>
          <form className="calendar-management__form" onSubmit={handleSubmit}>
            <label>
              <span className="label">Date</span>
              <DateField value={form.date} onChange={(date) => setForm({ ...form, date })} aria-label="Holiday date" />
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
                      const key = dateKey(year, expandedMonth, day);
                      const holiday = holidaysByDate.get(key);
                      const category = categoriesByValue.get(holiday?.type) ?? BUILT_IN_CATEGORIES[0];
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`calendar-management__day${holiday ? ' calendar-management__day--categorized' : ''}${form.date === key ? ' calendar-management__day--selected' : ''}`}
                          style={holiday ? { '--calendar-category-color': category.color } : undefined}
                          onClick={() => {
                            selectDate(key);
                            setExpandedMonth(null);
                          }}
                        >
                          {day}
                        </button>
                      );
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
                    <label className="modal__field"><span className="label">Category name</span><input autoFocus type="text" placeholder="e.g. Optional holiday" value={categoryForm.name} onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })} /></label>
                    <fieldset className="modal__field calendar-management__color-field"><legend className="label">Color</legend><div className="calendar-management__color-palette">{CATEGORY_COLORS.map((color) => <button key={color} type="button" className={`calendar-management__color-swatch${categoryForm.color === color ? ' calendar-management__color-swatch--selected' : ''}`} style={{ background: color }} aria-label={`Choose ${color}`} aria-pressed={categoryForm.color === color} onClick={() => setCategoryForm({ ...categoryForm, color })} />)}</div></fieldset>
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
