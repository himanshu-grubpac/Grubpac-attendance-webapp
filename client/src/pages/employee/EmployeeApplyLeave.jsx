import { useEffect, useMemo, useState } from 'react';
import { createLeaveRequestSchema } from '@shared/validation/leave.js';
import { getISTDateInputValue } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import SelectField from '../../components/SelectField.jsx';

const emptyForm = {
  leaveTypeId: '',
  startDate: getISTDateInputValue(),
  endDate: getISTDateInputValue(),
  halfDay: '',
  reason: '',
  documentUrl: '',
};

const DURATION_OPTIONS = [
  { value: '', label: 'Full day(s)' },
  { value: 'am', label: 'Half day — AM' },
  { value: 'pm', label: 'Half day — PM' },
];

export default function EmployeeApplyLeave() {
  const [types, setTypes] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    leaveApi
      .listTypes()
      .then((data) => {
        const active = (data.types ?? []).filter((item) => item.isActive);
        setTypes(active);
        if (active[0]) {
          setForm((current) => ({ ...current, leaveTypeId: active[0].id }));
        }
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => {
    if (!form.startDate || !form.endDate || form.endDate < form.startDate) {
      setPreview(null);
      return;
    }

    const timer = setTimeout(() => {
      leaveApi
        .previewDays({
          startDate: form.startDate,
          endDate: form.endDate,
          ...(form.halfDay ? { halfDay: form.halfDay } : {}),
        })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);

    return () => clearTimeout(timer);
  }, [form.startDate, form.endDate, form.halfDay]);

  const leaveTypeOptions = useMemo(
    () => types.map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` })),
    [types],
  );

  function handleHalfDayChange(value) {
    setForm((current) => {
      const next = { ...current, halfDay: value };
      if (value && current.startDate) {
        next.endDate = current.startDate;
      }
      return next;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage('');
    setError('');

    const payload = {
      ...form,
      halfDay: form.halfDay || undefined,
      documentUrl: form.documentUrl?.trim() ? form.documentUrl.trim() : undefined,
    };

    const validation = validateForm(createLeaveRequestSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    try {
      await leaveApi.createRequest(validation.data);
      setMessage('Leave request submitted. Your manager will be notified.');
      setForm({ ...emptyForm, leaveTypeId: form.leaveTypeId });
      setPreview(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedType = types.find((item) => item.id === form.leaveTypeId);

  return (
    <div className="page page--form">
      {(message || error) && (
        <div className="page-alerts">
          {message && <div className="alert alert--success">{message}</div>}
          {error && <div className="alert alert--error">{error}</div>}
        </div>
      )}

      <form className="card card--form form-grid form-grid--stacked" onSubmit={handleSubmit}>
        <p className="card__section-title form-grid__full">Leave details</p>

        <label className="form-grid__full">
          <span className="label">Leave type</span>
          <SelectField
            value={form.leaveTypeId}
            onChange={(value) => setForm({ ...form, leaveTypeId: value })}
            options={leaveTypeOptions}
            placeholder="Select leave type"
            aria-label="Leave type"
          />
          <FieldError message={fieldErrors.leaveTypeId} />
        </label>

        <div className="form-grid__full form-grid form-grid--dates">
        <label className="form-field--sm">
          <span className="label">Start date (IST)</span>
          <input
            className="input--narrow"
            type="date"
            value={form.startDate}
            onChange={(event) => setForm({ ...form, startDate: event.target.value })}
          />
          <FieldError message={fieldErrors.startDate} />
        </label>

        <label className="form-field--sm">
          <span className="label">End date (IST)</span>
          <input
            className="input--narrow"
            type="date"
            value={form.endDate}
            disabled={Boolean(form.halfDay)}
            onChange={(event) => setForm({ ...form, endDate: event.target.value })}
          />
          <FieldError message={fieldErrors.endDate} />
        </label>
        </div>

        <label className="form-grid__full">
          <span className="label">Duration</span>
          <SelectField
            value={form.halfDay}
            onChange={handleHalfDayChange}
            options={DURATION_OPTIONS}
            aria-label="Duration"
          />
          <FieldError message={fieldErrors.halfDay} />
        </label>

        <label className="form-grid__full">
          <span className="label">Reason</span>
          <textarea
            rows={3}
            value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <FieldError message={fieldErrors.reason} />
        </label>

        {preview && (
          <div className="preview-box">
            <strong>{preview.days}</strong> leave day(s)
            {preview.sandwichApplied && (
              <span className="muted small"> (sandwich policy applied)</span>
            )}
            {preview.workingDays?.length > 0 && (
              <span className="muted small"> — {preview.workingDays.join(', ')}</span>
            )}
          </div>
        )}

        {selectedType?.code === 'SL' && (
          <label className="form-grid__full">
            <span className="label">Medical certificate URL (required if &gt;2 consecutive days)</span>
            <input
              type="url"
              placeholder="https://..."
              value={form.documentUrl}
              onChange={(event) => setForm({ ...form, documentUrl: event.target.value })}
            />
            <FieldError message={fieldErrors.documentUrl} />
          </label>
        )}

        <div className="form-actions form-actions--sticky">
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </form>
    </div>
  );
}
