import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { formatINRCurrency } from '../utils/datetime.js';

/**
 * Fluid modal for pay-estimate breakdown + leave balances.
 * Matches AutoCheckoutModal pattern: portal, Esc, backdrop click,
 * body scroll lock, focus restore, no horizontal overflow on mobile.
 */
export default function SalaryDetailModal({
  open,
  month,
  summary,
  balances,
  loading,
  error,
  onClose,
}) {
  const titleId = useId();
  const previouslyFocused = useRef(null);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const hasSummary = Boolean(summary);

  return createPortal(
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wide salary-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header salary-detail-modal__header">
          <h2 id={titleId} className="modal__title">
            {month ? `${month} breakdown` : 'Pay estimate details'}
          </h2>
          <p className="modal__lead muted">
            Month figures plus leave balances for the year — negative balances are LOP-driven minus.
          </p>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal__body salary-detail-modal__body">
          {error ? <div className="alert alert--error modal__alert">{error}</div> : null}

          {loading ? (
            <div className="salary-table-skeleton" aria-busy="true" aria-label="Loading month breakdown">
              <div className="skeleton skeleton--row" />
              <div className="skeleton skeleton--row" />
              <div className="skeleton skeleton--row" />
            </div>
          ) : hasSummary ? (
            <>
              <dl className="detail-list detail-list--grid salary-detail__grid">
                <div>
                  <dt>Gross salary (INR)</dt>
                  <dd>{formatINRCurrency(summary.monthlySalary)}</dd>
                </div>
                <div>
                  <dt>Working days</dt>
                  <dd>{summary.workingDaysInMonth}</dd>
                </div>
                <div>
                  <dt>Present days</dt>
                  <dd>{summary.presentDays}</dd>
                </div>
                <div>
                  <dt>Paid leave days</dt>
                  <dd>{summary.paidLeaveDays}</dd>
                </div>
                <div>
                  <dt>Payable days</dt>
                  <dd>{summary.payableDays}</dd>
                </div>
                <div>
                  <dt>LOP days</dt>
                  <dd>{summary.lopDays}</dd>
                </div>
                <div>
                  <dt>LOP dates</dt>
                  <dd className="salary-detail__lop-dates">
                    {(summary.lopDates ?? []).length === 0
                      ? 'None'
                      : (summary.lopDates ?? [])
                          .map((entry) =>
                            entry?.unpaidDays != null && Number(entry.unpaidDays) !== 1
                              ? `${entry.date} (${entry.unpaidDays})`
                              : String(entry.date ?? entry),
                          )
                          .join(', ')}
                  </dd>
                </div>
                <div>
                  <dt>LOP amount (INR)</dt>
                  <dd>{formatINRCurrency(summary.lopDeduction)}</dd>
                </div>
                <div>
                  <dt>Net payable (INR)</dt>
                  <dd>{formatINRCurrency(summary.payableEstimate)}</dd>
                </div>
              </dl>

              <h3 className="label">Leave balances ({String(month).split('-')[0]})</h3>
              {(balances ?? []).length === 0 ? (
                <p className="muted small">No leave balances for this year.</p>
              ) : (
                <div className="table-wrap table-wrap--responsive salary-table-wrap">
                  <table className="table data-table salary-table">
                    <thead>
                      <tr>
                        <th>Leave type</th>
                        <th className="salary-table__num">Entitled</th>
                        <th className="salary-table__num">Used</th>
                        <th className="salary-table__num">Pending</th>
                        <th className="salary-table__num">Carried</th>
                        <th className="salary-table__num">Available</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(balances ?? []).map((balance) => {
                        const available = Number(balance.available ?? 0);
                        return (
                          <tr key={balance.leaveTypeId ?? balance.leaveTypeCode}>
                            <td data-label="Leave type">
                              {balance.leaveTypeCode ?? balance.leaveTypeName ?? '—'}
                            </td>
                            <td data-label="Entitled" className="salary-table__num">
                              {balance.entitled ?? '—'}
                            </td>
                            <td data-label="Used" className="salary-table__num">
                              {balance.used ?? '—'}
                            </td>
                            <td data-label="Pending" className="salary-table__num">
                              {balance.pending ?? '—'}
                            </td>
                            <td data-label="Carried" className="salary-table__num">
                              {balance.carried ?? '—'}
                            </td>
                            <td data-label="Available" className="salary-table__num">
                              {available}{' '}
                              {available < 0 ? (
                                <span className="badge badge-warning salary-status">Minus</span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
