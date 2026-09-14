import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createLeaveRequestSchema } from '@shared/validation/leave.js';
import { WFH_LEAVE_TYPE_CODE } from '@shared/utils/wfhPolicy.js';
import { getISTDateInputValue } from '../../utils/datetime.js';
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
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
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

/**
 * Shared apply form used by Apply Leave (mode='leave') and Apply WFH
 * (mode='wfh'). Behavior is byte-for-byte identical to the original page
 * except for type scoping: leave mode never offers/submits WFH, WFH mode is
 * pinned to the WFH type with the selector hidden.
 */
export default function ApplyLeaveForm({ mode = 'leave' }) {
  const { showToast, showSuccess } = useToast();
  const isWfhMode = mode === 'wfh';
  const [types, setTypes] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [balances, setBalances] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  // Admin-declared holidays (YYYY-MM-DD → name) for greying out non-working
  // days in the pickers. Both modes: the server rejects zero-working-day
  // ranges for WFH exactly like leave. Fail-open: an empty set disables nothing.
  const [holidayDates, setHolidayDates] = useState([]);
  const [holidayNames, setHolidayNames] = useState({});
  const [submitting, setSubmitting] = useState(false);
  // Synchronous in-flight guard: React state updates don't block a second
  // click in the same tick, which would otherwise fire a duplicate POST with
  // a fresh idempotency key and surface a confusing overlap 400.
  const submittingRef = useRef(false);
  const alertRef = useRef(null);
  const [wfhDisabled, setWfhDisabled] = useState(false);
  const UNDO_WINDOW_MS = 10000;
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
        if (isWfhMode) {
          const wfh = active.find((item) => item.code === WFH_LEAVE_TYPE_CODE);
          if (!wfh) {
            setWfhDisabled(true);
            setTypes(active);
            return;
          }
          setTypes([wfh]);
          setForm((current) => ({ ...current, leaveTypeId: wfh.id }));
          return;
        }
        // Apply Leave never offers WFH — the type is hidden and cannot submit.
        const nonWfh = active.filter((item) => item.code !== WFH_LEAVE_TYPE_CODE);
        setTypes(nonWfh);
        if (nonWfh[0]) {
          setForm((current) => ({ ...current, leaveTypeId: nonWfh[0].id }));
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

    // Ranges may span the year boundary, so cover this year and next — in
    // both modes (WFH weekends/holidays are rejected server-side too).
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
  }, [isWfhMode]);

  useEffect(() => {
    if (!editId) return;
    setLoadingRequest(true);
    setError('');
    leaveApi
      .getRequest(editId)
      .then((data) => {
        const req = data.request ?? data;
        const requestTypeCode = String(req.leaveTypeCode ?? '').toUpperCase();
        // Cross-mode guard: a WFH request cannot be edited on the leave page
        // and a non-WFH request cannot be edited on the WFH page.
        if (isWfhMode && requestTypeCode !== WFH_LEAVE_TYPE_CODE) {
          navigate(`/employee/leave/apply?edit=${editId}`, { replace: true });
          return;
        }
        if (!isWfhMode && requestTypeCode === WFH_LEAVE_TYPE_CODE) {
          navigate(`/employee/leave/apply-wfh?edit=${editId}`, { replace: true });
          return;
        }
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
  }, [editId, isWfhMode, navigate]);

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
          const t = types.find((item) => item.id === b.leaveTypeId);
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

    // WFH can never be submitted through the Apply Leave path (server keeps
    // the admin/exception API flow; the UI enforces the split client-side).
    const selectedCode = types.find((item) => item.id === form.leaveTypeId)?.code ?? '';
    if (!isWfhMode && String(selectedCode).toUpperCase() === WFH_LEAVE_TYPE_CODE) {
      showFormError({
        setError,
        alertRef,
        message: 'Work From Home requests must be submitted from Apply WFH.',
      });
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    if (isWfhMode && !form.leaveTypeId) {
      setFieldErrors({ leaveTypeId: 'Select a type to continue.' });
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

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

    // The debounced preview may be stale or missing at submit time (fast
    // date-pick → submit, or a failed preview fetch). Refresh synchronously
    // so a weekend-only range can never slip through to a dead server round
    // trip. On refresh failure fall through: the server remains the source of
    // truth and its message surfaces via showFormError below. Applies to both
    // modes — the server rejects zero-working-day WFH ranges identically.
    let checkPreview = preview;
    let checkCurrent = previewIsCurrent;
    if (form.startDate && form.endDate && form.endDate >= form.startDate) {
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
    if (checkCurrent && Number(checkPreview?.days ?? 0) === 0) {
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
      isWfhMode,
      leaveTypeCode: selectedCode,
      threshold: selectedPolicy?.requireDocAfterConsecutiveDays ?? null,
      requestedDays: Number(checkPreview?.days ?? 0),
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
        showSuccess(isWfhMode ? 'WFH request updated.' : 'Leave request updated.');
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
        showToast(isWfhMode ? 'WFH request submitted.' : 'Leave request submitted.', {
          variant: 'success',
          durationMs: undoMs,
          action: { label: 'Undo', onClick: () => handleUndo(req.id, snapshot) },
        });
      } else {
        showSuccess(isWfhMode ? 'WFH request submitted.' : 'Leave request submitted.');
      }
      const year = new Date().getFullYear();
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

  if (isWfhMode && wfhDisabled) {
    return (
      <div className="page page--form">
        <EmptyState
          icon={EMPTY_ICONS.leave}
          title="WFH is not enabled"
          description="Work From Home is currently unavailable for your organization."
        />
      </div>
    );
  }

  return (
    <div className="page page--form">
      {error ? (
        <div className="page-alerts" ref={alertRef} tabIndex={-1}>
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <form className="card card--form form-grid form-grid--stacked" onSubmit={handleSubmit}>
        <p className="card__section-title form-grid__full">{isEditing ? (isWfhMode ? 'Edit WFH request' : 'Edit leave request') : isWfhMode ? 'WFH details' : 'Leave details'}</p>

        <div className="form-grid__full leave-type-row">
          {isWfhMode ? (
            <div className="leave-type-row__type">
              <span className="label">Leave type</span>
              <span className="leave-type-static" aria-label="Leave type">
                {selectedType ? `${selectedType.code} — ${selectedType.name}` : 'WFH — Work From Home'}
              </span>
              <FieldError message={fieldErrors.leaveTypeId} />
            </div>
          ) : (
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
          )}
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

        {selectedType?.description ? (
          <p className="form-grid__full muted small" role="note" aria-label={`${selectedType.code} policy description`}>
            {selectedType.description}
          </p>
        ) : null}

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
            disableWeekends
            disabledDates={holidayDates}
            disabledDateTitles={holidayNames}
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
            disableWeekends
            disabledDates={holidayDates}
            disabledDateTitles={holidayNames}
          />
          <FieldError message={fieldErrors.endDate} />
        </label>
        </div>
        <p className="muted small form-grid__full" role="note">
          Weekends and company holidays are disabled — requests can only start or end on a working day.
        </p>

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
