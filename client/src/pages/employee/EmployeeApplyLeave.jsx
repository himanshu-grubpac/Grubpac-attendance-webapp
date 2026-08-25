import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createLeaveRequestSchema } from '@shared/validation/leave.js';
import { getISTDateInputValue } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import {
  buildApplyLeaveNotice,
  buildNegativeBalanceWarning,
  resolveLeavePolicyPaid,
  selectLeavePolicyForType,
} from '../../utils/leaveStatusCopy.js';
import {
  isLeaveTypeExemptFromApplyDeadline,
  validateLeaveApplyDeadline,
  LEAVE_APPLY_ADVANCE_ERROR,
  LEAVE_APPLY_DEADLINE_ERROR,
} from '@shared/utils/wfhPolicy.js';
import DateField from '../../components/DateField.jsx';
import FieldError from '../../components/FieldError.jsx';
import SelectField from '../../components/SelectField.jsx';
import { getLocalTimeZone, today } from '@internationalized/date';
const minDate = today(getLocalTimeZone());


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
  const { showSuccess } = useToast();
  const [types, setTypes] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [balances, setBalances] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const editId = searchParams.get('edit');
  const isEditing = Boolean(editId);
  const [loadingRequest, setLoadingRequest] = useState(isEditing);

  useEffect(() => {
    const year = new Date().getFullYear();
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

    leaveApi
      .listPolicies({ year })
      .then((data) => setPolicies(data.policies ?? []))
      .catch(() => setPolicies([]));

    leaveApi
      .getMyBalances({ year })
      .then((data) => setBalances(data.balances ?? []))
      .catch(() => setBalances([]));
  }, []);

  useEffect(() => {
    if (!editId) return;
    setLoadingRequest(true);
    setError('');
    leaveApi
      .getRequest(editId)
      .then((data) => {
        const req = data.request ?? data;
        setForm({
          leaveTypeId: req.leaveTypeId ?? '',
          startDate: getISTDateInputValue(new Date(req.startDate)),
          endDate: getISTDateInputValue(new Date(req.endDate)),
          halfDay: req.halfDay ?? '',
          reason: req.reason ?? '',
          documentUrl: req.documentUrl ?? '',
        });
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoadingRequest(false));
  }, [editId]);

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
      const response = isEditing
        ? await leaveApi.updateRequest(editId, validation.data)
        : await leaveApi.createRequest(validation.data);
      const approvedImmediately = response?.request?.status === 'approved';
      showSuccess(
        isEditing
          ? 'Leave request updated.'
          : approvedImmediately
            ? 'Sick leave approved.'
            : 'Leave request submitted. Your manager will be notified.',
      );
      if (isEditing) {
        navigate('/employee/leave/requests');
        return;
      }
      setForm({ ...emptyForm, leaveTypeId: form.leaveTypeId });
      setPreview(null);
      const year = new Date().getFullYear();
      leaveApi
        .getMyBalances({ year })
        .then((data) => setBalances(data.balances ?? []))
        .catch(() => {});
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedType = types.find((item) => item.id === form.leaveTypeId);
  const policyYear = new Date().getFullYear();
  const selectedPolicy = selectLeavePolicyForType(policies, form.leaveTypeId, policyYear);
  const applyNotice = selectedType
    ? buildApplyLeaveNotice({
        leaveTypeCode: selectedType.code,
        leaveTypeName: selectedType.name,
        policyPaid: resolveLeavePolicyPaid({
          leaveTypeCode: selectedType.code,
          policy: selectedPolicy,
        }),
      })
    : null;

  const selectedBalance = balances.find((item) => item.leaveTypeId === form.leaveTypeId);
  const requestedDays = Number(preview?.days ?? 0);
  const negativeBalanceWarning =
    selectedType && preview && requestedDays > 0
      ? buildNegativeBalanceWarning({
          leaveTypeCode: selectedType.code,
          leaveTypeName: selectedType.name,
          available: selectedBalance?.available ?? 0,
          requestedDays,
        })
      : null;

  const isSlType = selectedType && isLeaveTypeExemptFromApplyDeadline(selectedType.code);

  const applyDeadlineError =
    selectedType && !isSlType && form.startDate && form.endDate
      ? validateLeaveApplyDeadline(form.startDate, form.endDate, selectedType.code)
      : null;

  return (
    <div className="page page--form">
      {error ? (
        <div className="page-alerts">
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <form className="card card--form form-grid form-grid--stacked" onSubmit={handleSubmit}>
        <p className="card__section-title form-grid__full">{isEditing ? 'Edit leave request' : 'Leave details'}</p>

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
          <DateField
            value={form.startDate}
            min={minDate}
            onChange={(value) =>
              setForm((current) => ({
                ...current,
                startDate: value,
                ...(current.halfDay ? { endDate: value } : {}),
              }))
            }
            aria-label="Start date"
          />
          <FieldError message={fieldErrors.startDate} />
        </label>

        <label className="form-field--sm">
          <span className="label">End date (IST)</span>
          <DateField
            value={form.endDate}
            onChange={(value) => setForm({ ...form, endDate: value })}
            min={form.startDate || undefined}
            disabled={Boolean(form.halfDay)}
            aria-label="End date"
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

        {applyNotice ? (
          <div
            className="alert alert--info alert--block leave-status-notice form-grid__full"
            role="note"
            aria-label="Leave approval and pay estimate information"
          >
            <p className="leave-status-notice__title">
              <strong>{applyNotice.title}</strong>
            </p>
            <ul className="leave-status-notice__list">
              {!isSlType ? (
                <>
                  <li>{LEAVE_APPLY_ADVANCE_ERROR}</li>
                  <li>{LEAVE_APPLY_DEADLINE_ERROR}</li>
                </>
              ) : null}
              {applyNotice.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {negativeBalanceWarning ? (
          <div className="alert alert--warning alert--block form-grid__full" role="alert">
            {negativeBalanceWarning}
          </div>
        ) : null}

        {applyDeadlineError ? (
          <div className="alert alert--warning alert--block form-grid__full" role="alert">
            {applyDeadlineError}
          </div>
        ) : null}

        {preview && selectedType?.code !== 'WFH' && (
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
          <button type="submit" className="btn btn-primary" disabled={submitting || loadingRequest || Boolean(applyDeadlineError)}>
            {submitting ? 'Saving…' : isEditing ? 'Save changes' : 'Submit request'}
          </button>
        </div>
      </form>
    </div>
  );
}
