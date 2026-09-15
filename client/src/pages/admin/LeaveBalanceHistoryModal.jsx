import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getErrorMessage, leaveApi } from '../../services/api.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { formatISTDate } from '../../utils/datetime.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';

function formatDays(value) {
  const numeric = Number(value) || 0;
  return Number.isInteger(numeric) ? String(numeric) : String(numeric);
}

// A missing balance row is "no record", not a zero balance — render an
// em dash so it can never be mistaken for exhausted leave.
function HistoryCell({ label, value, hasRecord }) {
  if (!hasRecord) {
    return (
      <td data-label={label}>
        <span className="leave-history-table__no-record" title="No balance record for this year">
          —
        </span>
      </td>
    );
  }
  return <td data-label={label}>{formatDays(value)}</td>;
}

export default function LeaveBalanceHistoryModal({ userId, userName, policyYear, onClose }) {
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const previouslyFocused = useRef(null);
  // End year of the 3-year window — admin can look further back than the
  // policy year the drawer was opened from.
  const [year, setYear] = useState(() => String(policyYear ?? new Date().getFullYear()));

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, index) => {
      const value = String(currentYear - index);
      return { value, label: value };
    });
  }, []);

  useEscapeKey(Boolean(userId), onClose);

  useEffect(() => {
    if (!userId) return undefined;
    previouslyFocused.current = document.activeElement;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [userId]);

  useEffect(() => {
    setYear(String(policyYear ?? new Date().getFullYear()));
  }, [userId, policyYear]);

  useEffect(() => {
    if (!userId || !year) return;
    setLoading(true);
    setError('');
    setHistory(null);
    leaveApi
      .getAdjustmentHistory(userId, { year: Number(year) })
      .then((data) => setHistory(data))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [userId, year]);

  if (!userId) return null;

  return createPortal(
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wide modal--compact"
        role="dialog"
        aria-modal="true"
        aria-label={`Leave balance history for ${history?.user?.name ?? userName ?? 'employee'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h3 className="modal__title">
            Leave history — {history?.user?.name ?? userName ?? 'Employee'}
          </h3>
          <p className="muted small modal__lead">
            {history?.user?.employeeCode ? `${history.user.employeeCode} · ` : ''}
            {history?.user?.contractStartDate
              ? `Joined ${formatISTDate(history.user.contractStartDate)} · `
              : ''}
            Entitled, carried and available stock per leave type for the selected balance year.
          </p>
          <label className="field-inline modal__year-field">
            <span className="label">Balance year</span>
            <SelectField
              value={year}
              onChange={setYear}
              options={yearOptions}
              aria-label="Balance history end year"
            />
          </label>
        </div>
        <div className="modal__body">
          {loading ? (
            <div className="skeleton-stack">
              <div className="skeleton skeleton--row" />
              <div className="skeleton skeleton--row" />
              <div className="skeleton skeleton--row" />
            </div>
          ) : error ? (
            <div className="alert alert--error">{error}</div>
          ) : !history || history.years?.length === 0 ? (
            <EmptyState
              icon={EMPTY_ICONS.leave}
              title="No history found"
              description="No leave balances exist for this employee yet."
            />
          ) : (
            history.years.map((yearEntry) => {
              const hasAnyRecord = (yearEntry.balances ?? []).some((item) => item.hasRecord);
              return (
                <section key={yearEntry.year} aria-label={`Balance year ${yearEntry.year}`}>
                  <p className="card__section-title">Balance year {yearEntry.year}</p>
                  {!hasAnyRecord ? (
                    <p className="muted small">No balance record for {yearEntry.year}.</p>
                  ) : null}
                  <div className="table-wrap">
                    <table className="table data-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Entitled</th>
                          <th>Carried</th>
                          <th>Used</th>
                          <th>Pending</th>
                          <th>Available</th>
                        </tr>
                      </thead>
                      <tbody>
                        {yearEntry.balances.map((balance) => (
                          <tr key={balance.leaveTypeId}>
                            <td data-label="Type">
                              {balance.leaveTypeCode} — {balance.leaveTypeName}
                            </td>
                            <HistoryCell label="Entitled" value={balance.entitled} hasRecord={balance.hasRecord} />
                            <HistoryCell label="Carried" value={balance.carried} hasRecord={balance.hasRecord} />
                            <HistoryCell label="Used" value={balance.used} hasRecord={balance.hasRecord} />
                            <HistoryCell label="Pending" value={balance.pending} hasRecord={balance.hasRecord} />
                            <HistoryCell label="Available" value={balance.available} hasRecord={balance.hasRecord} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })
          )}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
