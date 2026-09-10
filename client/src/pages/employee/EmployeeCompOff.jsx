import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCompOffRequestSchema } from '@shared/validation/compOff.js';
import { getISTDateInputValue } from '../../utils/datetime.js';
import { compOffApi, leaveApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import DateField from '../../components/DateField.jsx';
import FieldError from '../../components/FieldError.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';

// Quiet background settle cadence for rows with a staged (undoable) action.
const PENDING_SETTLE_POLL_MS = 5000;
const MAX_SETTLE_POLLS = 24;
const SUBMIT_UNDO_FALLBACK_MS = 10000;
// Staged withdrawals use the 15s decision window, like other staged actions.
const WITHDRAW_UNDO_FALLBACK_MS = 15000;

/** Comp-off status → badge tone (local map; classes already in App.css). */
const COMP_OFF_STATUS_TONE = {
  pending: 'badge-warning',
  approved: 'badge-info',
  worked: 'badge-primary',
  assessed: 'badge-success',
  rejected: 'badge-muted',
  lapsed: 'badge-muted',
  cancelled: 'badge-muted',
};

function formatStatusLabel(status) {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
}

function StatusToneBadge({ status }) {
  return (
    <span className={`badge ${COMP_OFF_STATUS_TONE[status] ?? 'badge-muted'}`.trim()}>
      {formatStatusLabel(status)}
    </span>
  );
}

function dateRangeLabel(item) {
  const start = getISTDateInputValue(new Date(item.startDate));
  const end = getISTDateInputValue(new Date(item.endDate));
  return start === end ? start : `${start} to ${end}`;
}

export default function EmployeeCompOff() {
  const { showToast, showSuccess } = useToast();
  const [coAvailable, setCoAvailable] = useState(null);
  const [eligibleByYear, setEligibleByYear] = useState({});
  const [form, setForm] = useState({
    startDate: getISTDateInputValue(),
    endDate: getISTDateInputValue(),
    reason: '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  async function loadBalances() {
    try {
      const year = new Date().getFullYear();
      const data = await leaveApi.getMyBalances({ year });
      const co = (data.balances ?? []).find((item) => item.leaveTypeCode === 'CO');
      setCoAvailable(co?.available ?? 0);
    } catch {
      setCoAvailable(null);
    }
  }

  // Tracks years with an in-flight eligible-days fetch so month-grid renders
  // (dozens of isDateAllowed calls) don't fan out into a request storm.
  const eligibleLoadingRef = useRef(new Set());
  const loadEligible = useCallback(async (year) => {
    if (!year) return;
    let shouldFetch = false;
    setEligibleByYear((current) => {
      if (current[year] || eligibleLoadingRef.current.has(year)) return current;
      eligibleLoadingRef.current.add(year);
      shouldFetch = true;
      return current;
    });
    if (!shouldFetch) return;
    try {
      const data = await compOffApi.eligibleDays({ year });
      setEligibleByYear((latest) => ({ ...latest, [year]: new Set(data.days ?? []) }));
    } catch {
      setEligibleByYear((latest) => ({ ...latest, [year]: new Set() }));
    } finally {
      eligibleLoadingRef.current.delete(year);
    }
  }, []);

  async function loadRequests(nextPage = page, { quiet = false } = {}) {
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    try {
      const data = await compOffApi.list({ scope: 'mine', page: nextPage, limit: 20 });
      setRequests(data.requests ?? []);
      setPagination(data.pagination ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    loadBalances();
    loadRequests(page);
    const year = new Date().getFullYear();
    loadEligible(year);
  }, [page, loadEligible]);

  // Fetch the eligible sets for the selected years (cross-year ranges span
  // two sets; each picker field is gated by the year of the date shown).
  const startYear = Number((form.startDate ?? '').slice(0, 4));
  const endYear = Number((form.endDate ?? '').slice(0, 4));
  useEffect(() => {
    if (startYear) loadEligible(startYear);
    if (endYear && endYear !== startYear) loadEligible(endYear);
  }, [startYear, endYear, loadEligible]);

  const isDateAllowed = useCallback(
    (dateKey) => {
      const year = Number((dateKey ?? '').slice(0, 4));
      const set = Number.isFinite(year) ? eligibleByYear[year] : null;
      if (!set) {
        // Fail closed while the year's set loads — the server re-validates
        // authoritatively, so this only affects picker affordance.
        if (Number.isFinite(year)) loadEligible(year);
        return false;
      }
      return set.has(dateKey);
    },
    [eligibleByYear, loadEligible],
  );

  // Settle polling while any row carries a staged action.
  const settlePollsRef = useRef(0);
  useEffect(() => {
    if (!requests.some((item) => item.pendingAction)) {
      settlePollsRef.current = 0;
      return undefined;
    }
    if (settlePollsRef.current >= MAX_SETTLE_POLLS) return undefined;
    const timer = setInterval(() => {
      settlePollsRef.current += 1;
      loadRequests(page, { quiet: true });
    }, PENDING_SETTLE_POLL_MS);
    return () => clearInterval(timer);
  }, [requests, page]);

  const selectedYearSets = [startYear, endYear]
    .filter((year, index, all) => year && all.indexOf(year) === index)
    .map((year) => eligibleByYear[year]);
  const emptyEligible =
    selectedYearSets.length > 0 &&
    selectedYearSets.every((set) => set !== undefined && set.size === 0) &&
    !loading;

  // Synchronous in-flight guard: React state alone can't stop a same-tick
  // double click, which would fire a duplicate POST with a fresh idempotency
  // key and surface a confusing overlap error.
  const submittingRef = useRef(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    const payload = { ...form, reason: form.reason.trim() };
    const validation = validateForm(createCompOffRequestSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    setFieldErrors({});

    const idempotencyKey =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    try {
      const response = await compOffApi.create(validation.data, { idempotencyKey });
      const req = response?.request ?? {};
      const snapshot = { ...form };
      setForm((current) => ({ ...current, startDate: getISTDateInputValue(), endDate: getISTDateInputValue(), reason: '' }));
      const serverUndoMs = Date.parse(req.decisionUndoExpiresAt ?? '');
      const undoMs = Number.isFinite(serverUndoMs)
        ? Math.max(0, serverUndoMs - Date.now())
        : SUBMIT_UNDO_FALLBACK_MS;
      if (undoMs > 0) {
        showToast('Comp off request submitted.', {
          variant: 'success',
          durationMs: undoMs,
          action: { label: 'Undo', onClick: () => handleUndoSubmit(req.id, snapshot) },
        });
      } else {
        showSuccess('Comp off request submitted.');
      }
      loadRequests(page);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleUndoSubmit(id, snapshot) {
    if (!id) return;
    try {
      await compOffApi.withdraw(id);
      if (snapshot) setForm(snapshot);
      showToast('Request withdrawn. Edit and submit again when ready.', { variant: 'info' });
      loadRequests(page);
    } catch (err) {
      const message = getErrorMessage(err) || 'Could not withdraw the request.';
      if (err?.response?.status === 409 || err?.response?.status === 410) {
        showToast(`${message} Refreshing your requests.`, { variant: 'error' });
        loadRequests(page);
        return;
      }
      showToast(message, { variant: 'error' });
    }
  }

  async function handleUndoWithdraw(id) {
    if (!id) return;
    try {
      await compOffApi.undoWithdraw(id);
      showToast('Withdrawal undone. Your request is pending again.', { variant: 'info' });
      loadRequests(page);
    } catch (err) {
      const message = getErrorMessage(err) || 'Could not undo the withdrawal.';
      showToast(`${message} Refreshing your requests.`, { variant: 'error' });
      loadRequests(page);
    }
  }

  async function handleWithdraw(item) {
    // No confirm dialog: the Undo toast below is the safety net, same as the
    // submit flow. Withdrawing only stages the cancellation — the request is
    // really gone after the undo window expires with no toast action taken.
    setError('');
    try {
      const response = await compOffApi.withdraw(item.id);
      const req = response?.request ?? {};
      const serverUndoMs = Date.parse(req.decisionUndoExpiresAt ?? '');
      const undoMs = Number.isFinite(serverUndoMs)
        ? Math.max(0, serverUndoMs - Date.now())
        : WITHDRAW_UNDO_FALLBACK_MS;
      if (undoMs > 0) {
        showToast('Withdrawal staged. The request cancels when the timer ends.', {
          variant: 'success',
          durationMs: undoMs,
          action: { label: 'Undo', onClick: () => handleUndoWithdraw(item.id) },
        });
      } else {
        showSuccess('Comp off request withdrawn.');
      }
      loadRequests(page);
    } catch (err) {
      setError(getErrorMessage(err));
      loadRequests(page);
    }
  }

  const canWithdraw = useCallback(
    (item) => {
      if (item.status !== 'pending') return false;
      if (item.pendingAction) return false;
      const expiresAt = Date.parse(item.decisionUndoExpiresAt ?? '');
      return Number.isFinite(expiresAt) && expiresAt > Date.now();
    },
    [],
  );

  const balancePill = useMemo(() => {
    if (coAvailable === null) return null;
    return (
      <span className="leave-balance-pill">
        CO - {coAvailable}
      </span>
    );
  }, [coAvailable]);

  return (
    <div className="page page--form">
      {error ? (
        <div className="page-alerts">
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <div className="card card--form">
        <p className="muted">
          Request approval to work on a weekend or holiday. Credit lands in your CO
          balance only after your manager approves the request, you check out, and
          your work is assessed.
        </p>
        {balancePill}
      </div>

      {emptyEligible ? (
        <div className="card card--form">
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No eligible days"
            description={`No weekends or holidays are configured for ${startYear}. Ask an administrator to add holidays.`}
          />
        </div>
      ) : (
        <form className="card card--form form-grid form-grid--stacked" onSubmit={handleSubmit}>
          <p className="card__section-title form-grid__full">Request details</p>

          <div className="form-grid__full form-grid form-grid--dates">
            <label className="form-field--sm">
              <span className="label">Start date (IST)</span>
              <DateField
                value={form.startDate}
                min={getISTDateInputValue()}
                isDateAllowed={isDateAllowed}
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    startDate: value,
                    endDate: value > current.endDate ? value : current.endDate,
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
                isDateAllowed={isDateAllowed}
                onChange={(value) => setForm({ ...form, endDate: value })}
                min={form.startDate || undefined}
                aria-label="End date"
              />
              <FieldError message={fieldErrors.endDate} />
            </label>
          </div>

          <label className="form-grid__full">
            <span className="label">Reason</span>
            <textarea
              rows={3}
              value={form.reason}
              onChange={(event) => setForm({ ...form, reason: event.target.value })}
              placeholder="Why do you need to work on this weekend or holiday?"
            />
            <FieldError message={fieldErrors.reason} />
          </label>

          <p className="form-grid__full muted small">
            Only Saturdays, Sundays, and active holidays can be selected. The full
            date range must be eligible — weekend/holiday only.
          </p>

          <div className="form-actions form-actions--sticky">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || loading || emptyEligible}
            >
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      )}

      <div className="card card--table">
        <div className="card__toolbar">
          <p className="card__section-title" style={{ marginBottom: 0 }}>My comp off requests</p>
        </div>
        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No comp off requests yet"
            description="Request approval before working a weekend or holiday."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table">
              <thead>
                <tr>
                  <th>Dates</th>
                  <th>Days</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Credit</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Dates">{dateRangeLabel(item)}</td>
                    <td data-label="Days">{item.days}</td>
                    <td data-label="Reason">{item.reason}</td>
                    <td data-label="Status"><StatusToneBadge status={item.status} /></td>
                    <td data-label="Credit">
                      {item.creditedDays > 0 ? `+${item.creditedDays}` : '—'}
                    </td>
                    <td data-label="Action" className="cell-actions">
                      {canWithdraw(item) && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleWithdraw(item)}>
                          Withdraw
                        </button>
                      )}
                      {item.status === 'pending' && item.pendingAction === 'cancelled' && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleUndoWithdraw(item.id)}>
                          Undo withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar pagination={pagination} onPageChange={setPage} />
      </div>
    </div>
  );
}
