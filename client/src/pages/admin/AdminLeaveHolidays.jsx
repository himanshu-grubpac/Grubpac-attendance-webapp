import { useEffect, useState } from 'react';
import { createHolidaySchema } from '@shared/validation/holidays.js';
import { formatISTDate, getISTDateInputValue } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import DateField from '../../components/DateField.jsx';
import FieldError from '../../components/FieldError.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

const emptyForm = {
  date: getISTDateInputValue(),
  name: '',
  description: '',
};

export default function AdminLeaveHolidays() {
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [year, setYear] = useState(new Date().getFullYear());
  const [holidays, setHolidays] = useState([]);
  const [note, setNote] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadHolidays() {
    setLoading(true);
    setError('');
    try {
      const data = await leaveApi.listHolidays({ year });
      setHolidays(data.holidays ?? []);
      setNote(data.note ?? '');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadHolidays();
  }, [year]);

  async function handleCreate(event) {
    event.preventDefault();
    setError('');

    const validation = validateForm(createHolidaySchema, form);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      return;
    }

    setFieldErrors({});
    try {
      await leaveApi.createHoliday(validation.data);
      setForm(emptyForm);
      showSuccess('Holiday added.');
      await loadHolidays();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDelete(id) {
    const holiday = holidays.find((item) => item.id === id);
    await requestConfirm({
      title: 'Delete holiday?',
      message: holiday
        ? `Delete “${holiday.name}” on ${formatISTDate(holiday.date)}? This cannot be undone.`
        : 'Delete this holiday? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        await leaveApi.deleteHoliday(id);
        await loadHolidays();
      },
    });
  }

  return (
    <div className="page">
      {(note || error) && (
        <div className="page-alerts">
          {note && <div className="alert alert--info">{note}</div>}
          {error && <div className="alert alert--error">{error}</div>}
        </div>
      )}

      <form className="card card--form form-grid" onSubmit={handleCreate}>
        <p className="card__section-title form-grid__full">Add holiday</p>
        <label className="form-field--sm">
          <span className="label">Date (IST)</span>
          <DateField
            value={form.date}
            onChange={(value) => setForm({ ...form, date: value })}
            aria-label="Holiday date"
          />
          <FieldError message={fieldErrors.date} />
        </label>
        <label>
          <span className="label">Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <FieldError message={fieldErrors.name} />
        </label>
        <div className="form-actions form-actions--sticky">
          <button type="submit" className="btn btn-primary">
            Add holiday
          </button>
        </div>
      </form>

      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline form-field--sm">
            <span className="label">Year</span>
            <input
              className="input--narrow"
              type="number"
              min="2020"
              max="2100"
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
            />
          </label>
        </div>

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : holidays.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.calendar}
            title={`No holidays for ${year}`}
            description="Add a holiday above to populate the calendar."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Name</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {holidays.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Date">{formatISTDate(item.date)}</td>
                    <td data-label="Name">{item.name}</td>
                    <td data-label="Action" className="cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleDelete(item.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmDialog}
    </div>
  );
}
