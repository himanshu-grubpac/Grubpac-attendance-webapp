import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createLeaveRequestSchema } from '@shared/validation/leave.js';
import { getISTDateInputValue, getISTYear } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage, getFieldErrors } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import { showFormError, buildDocCertificateError } from '../../utils/formErrors.js';
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
  const { showToast, showSuccess } = useToast();
  const [types, setTypes] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [balances, setBalances] = useState([]);
  // Admin-declared holidays (YYYY-MM-DD → name) for greying out non-working
  // days in the pickers. Fail-open: an empty set simply disables nothing.
  const [holidayDates, setHolidayDates] = useState([]);
  const [holidayNames, setHolidayNames] = useState({});
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Synchronous in-flight guard: React state updates don't block a second
  // click in the same tick, which would otherwise fire a duplicate POST with
  // a fresh idempotency key and surface a confusing overlap 400.
  const submittingRef = useRef(false);
  const alertRef = useRef(null);
  const UNDO_WINDOW_MS = 10000;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const editId = searchParams.get('edit');
  const isEditing = Boolean(editId);
  const [loadingRequest, setLoadingRequest] = useState(isEditing);

  useEffect(() => {
    const year = getISTYear();
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

    // Leave ranges may span the year boundary, so cover this year and next.
    // Non-working-day blocking is leave-mode only (WFH follows its own flow).
    Promise.all([
      leaveApi.listHolidays({ year }).catch(() => ({ holidays: [] })),
      leaveApi.listHolidays({ year: year + 1 }).catch(() => ({ holidays: [] })),
    ])
      .then(([current, next]) => {
        const names = {};
        const dates = [];
        for (const item of [...(current.holidays ?? []), ...(next.holidays ?? [])]) {
          const key = item.dateInput ?? getISTDateInputValue(new Date(item.date));
          if (!key || dates.includes(key)) continue;
          dates.push(key);
          if (item.name) names[key] = item.name;
        }
        setHolidayDates(dates);
        setHolidayNames(names);
      })
      .catch(() => {
        setHolidayDates([]);
        setHolidayNames({});
      });
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

    const rangeKey = `${form.startDate}|${form.endDate}|${form.halfDay || ''}`;
    const timer = setTimeout(() => {
      leaveApi
        .previewDays({
          startDate: form.startDate,
          endDate: form.endDate,
          ...(form.halfDay ? { halfDay: form.halfDay } : {}),
        })
        // Tag which range this preview belongs to: while debouncing or in
        // flight, `preview` may still describe the previous range, so callers
        // must check currency via previewIsCurrent below before acting on it.
        .then((data) => setPreview({ ...data, _rangeKey: rangeKey }))
        .catch(() => setPreview(null));
    }, 300);

    return () => clearTimeout(timer);
  }, [form.startDate, form.endDate, form.halfDay]);

  const leaveTypeOptions = useMemo(
    () => types.map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` })),
    [types],
  );

  const balanceItems = useMemo(
    () =>
      balances
        .filter((b) => types.some((t) => t.id === b.leaveTypeId))
        .map((b) => {
          const t = types.find((t) => t.id === b.leaveTypeId);
          return { code: t?.code ?? '?', available: b.available ?? 0 };
        }),
    [balances, types],
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
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    setFieldErrors({});

    const payload = {
      ...form,
      halfDay: form.halfDay || undefined,
      documentUrl: form.documentUrl?.trim() ? form.documentUrl.trim() : undefined,
    };

    const validation = validateForm(createLeaveRequestSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    const selectedCode = types.find((item) => item.id === form.leaveTypeId)?.code ?? '';
    const isNonWfhSubmit = String(selectedCode).toUpperCase() !== 'WFH';

    // The debounced preview may be stale or missing at submit time (fast
    // date-pick → submit, or a failed preview fetch) — and both guards below
    // require current day-count data. Refresh synchronously so a Saturday-only
    // range can never slip through to a dead server round trip. If the refresh
    // itself fails, fall through: the server remains the source of truth and
    // its message surfaces via showFormError below.
    let checkPreview = preview;
    let checkCurrent = previewIsCurrent;
    if (
      isNonWfhSubmit &&
      !previewIsCurrent &&
      form.startDate &&
      form.endDate &&
      form.endDate >= form.startDate
    ) {
      try {
        const fresh = await leaveApi.previewDays({
          startDate: form.startDate,
          endDate: form.endDate,
          ...(form.halfDay ? { halfDay: form.halfDay } : {}),
        });
        checkPreview = {
          ...fresh,
          _rangeKey: `${form.startDate}|${form.endDate}|${form.halfDay || ''}`,
        };
        setPreview(checkPreview);
        checkCurrent = true;
      } catch {
        // Preview unavailable — proceed to server validation.
      }
    }
    const checkDays = Number(checkPreview?.days ?? 0);

    // Defense in depth behind the disabled submit button: never send a range
    // with zero working days. WFH requests follow their own flow and are exempt.
    if (isNonWfhSubmit && checkCurrent && checkDays === 0) {
      showFormError({
        setError,
        alertRef,
        message:
          'The selected dates contain no working days. Leave can only be applied on working days (Mon–Fri, excluding holidays).',
      });
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    // Client mirror of the server's medical-certificate rule: long sick leave
    // without a certificate URL is always rejected. Block early with the
    // requirement inline instead of a dead submit round trip.
    const docBlockMessage = buildDocCertificateError({
      leaveTypeCode: selectedCode,
      threshold: selectedPolicy?.requireDocAfterConsecutiveDays ?? null,
      requestedDays: checkDays,
      previewIsCurrent: checkCurrent,
      halfDay: form.halfDay,
      hasDocument: Boolean(form.documentUrl?.trim()),
    });
    if (docBlockMessage) {
      showFormError({ setError, alertRef, message: docBlockMessage });
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    // Fresh idempotency key per logical submit: transport retries replay the
    // stored response instead of creating duplicate requests.
    const idempotencyKey =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    try {
      const response = isEditing
        ? await leaveApi.updateRequest(editId, validation.data, { idempotencyKey })
        : await leaveApi.createRequest(validation.data, { idempotencyKey });
      const req = response?.request ?? {};

      if (isEditing) {
        showSuccess('Leave request updated.');
        navigate('/employee/leave/requests');
        return;
      }

      const snapshot = { ...form };
      setForm({ ...emptyForm, leaveTypeId: form.leaveTypeId });
      setPreview(null);
      // Undo countdown follows the server-authoritative expiry when present
      // (backend remains correct across refresh/close); local fallback only.
      const serverUndoMs = Date.parse(req.decisionUndoExpiresAt ?? '');
      const undoMs = Number.isFinite(serverUndoMs)
        ? Math.max(0, serverUndoMs - Date.now())
        : UNDO_WINDOW_MS;
      // A zero/negative window (expiry already passed or clock skew) would
      // render an instantly-vanishing Undo toast — fall back to plain success.
      if (undoMs > 0) {
        showToast('Leave request submitted.', {
          variant: 'success',
          durationMs: undoMs,
          action: { label: 'Undo', onClick: () => handleUndo(req.id, snapshot) },
        });
      } else {
        showSuccess('Leave request submitted.');
      }
      const year = getISTYear();
      leaveApi
        .getMyBalances({ year })
        .then((data) => setBalances(data.balances ?? []))
        .catch(() => {});
    } catch (err) {
      // Server field errors (e.g. Zod shape) map onto fields; the top alert
      // is scrolled into view so the failure is never silently below the fold.
      showFormError({
        setError,
        setFieldErrors,
        alertRef,
        message: getErrorMessage(err),
        fieldErrors: getFieldErrors(err),
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleUndo(id, snapshot) {
    if (!id) return;
    try {
      await leaveApi.withdrawSubmitted(id);
      if (snapshot) {
        setForm(snapshot);
      }
      showToast('Request reverted. Edit and submit again when ready.', { variant: 'info' });
    } catch (err) {
      const message = getErrorMessage(err) || 'Could not undo the request.';
      // Finalized requests (undo window expired / already notified) still
      // exist as live pending requests — send the employee to edit that
      // request instead of restoring a stale new-submit snapshot.
      if (err?.response?.status === 409 || err?.response?.status === 410) {
        showToast(`${message} Opening your requests to edit it there.`, { variant: 'error' });
        navigate('/employee/leave/requests');
        return;
      }
      if (snapshot) setForm(snapshot);
      showToast(message, { variant: 'error' });
    }
  }

  const selectedType = types.find((item) => item.id === form.leaveTypeId);
  const policyYear = getISTYear();
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
  // WFH follows its own day-count flow on the server (exempt from the
  // zero-working-days rule), so non-working-day blocking applies to leave
  // types only — never strand a WFH submit behind a disabled calendar.
  const isWfhSelected = String(selectedType?.code ?? '').toUpperCase() === 'WFH';
  const pickerDisabledDates = isWfhSelected ? [] : holidayDates;
  const pickerDisabledTitles = isWfhSelected ? {} : holidayNames;
  const requestedDays = Number(preview?.days ?? 0);
  // True only when the resolved preview belongs to the currently selected
  // range: a stale (previous-range) preview must never warn or block.
  const rangeKey = `${form.startDate ?? ''}|${form.endDate ?? ''}|${form.halfDay ?? ''}`;
  const previewIsCurrent = Boolean(
    preview &&
      preview._rangeKey === rangeKey &&
      form.startDate &&
      form.endDate &&
      form.endDate >= form.startDate,
  );
  // Weekend/holiday-only ranges (e.g. CO on a Saturday) carry zero working
  // days and are always rejected server-side — surface it inline instead.
  // WFH requests follow their own flow and are exempt.
  const zeroWorkingDays =
    String(selectedType?.code ?? '').toUpperCase() !== 'WFH' &&
    previewIsCurrent &&
    Number(preview.days ?? 0) === 0;
  const isCoType = String(selectedType?.code ?? '').toUpperCase() === 'CO';
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
        <div className="page-alerts" ref={alertRef} tabIndex={-1}>
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <form className="card card--form form-grid form-grid--stacked" onSubmit={handleSubmit}>
        <p className="card__section-title form-grid__full">{isEditing ? 'Edit leave request' : 'Leave details'}</p>

        <div className="form-grid__full leave-type-row">
          <label className="leave-type-row__type">
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
          {balanceItems.length > 0 && (
            <div className="leave-type-row__balance">
              <span className="label">Remaining</span>
              <span className="leave-balance-summary">
                {balanceItems.map((item) => (
                  <span key={item.code} className="leave-balance-pill">
                    {item.code} - {item.available}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>

        <div className="form-grid__full form-grid form-grid--dates">
        <label className="form-field--sm">
          <span className="label">Start date (IST)</span>
          <DateField
            value={form.startDate}
            min={minDate}
            disableWeekends={!isWfhSelected}
            disabledDates={pickerDisabledDates}
            disabledDateTitles={pickerDisabledTitles}
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
            disableWeekends={!isWfhSelected}
            disabledDates={pickerDisabledDates}
            disabledDateTitles={pickerDisabledTitles}
            aria-label="End date"
          />
          <FieldError message={fieldErrors.endDate} />
        </label>
        </div>
        {!isWfhSelected ? (
          <p className="muted small form-grid__full" role="note">
            Weekends and company holidays are disabled — leave can only start or end on a working day.
          </p>
        ) : null}

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

        {zeroWorkingDays ? (
          <div className="alert alert--warning alert--block form-grid__full" role="alert">
            No working days in the selected dates — leave can only be applied on
            working days (Mon–Fri, excluding holidays). Please pick a range that
            includes at least one working day.
            {isCoType ? ' Comp-off credit can only be availed on working days.' : null}
          </div>
        ) : null}

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
          <button type="submit" className="btn btn-primary" disabled={submitting || loadingRequest || Boolean(applyDeadlineError) || zeroWorkingDays}>
            {submitting ? 'Saving…' : isEditing ? 'Save changes' : 'Submit request'}
          </button>
        </div>
      </form>

    </div>
  );
}
