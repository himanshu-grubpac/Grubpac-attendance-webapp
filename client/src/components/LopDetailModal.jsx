import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { getErrorMessage, salaryApi } from '../services/api.js';
import { formatINRCurrency, formatISTDate } from '../utils/datetime.js';
import { formatMonthLabel } from './MonthField.jsx';
import SelectField from './SelectField.jsx';
import EmptyState, { EMPTY_ICONS } from './EmptyState.jsx';
import { usePortalSync } from '../hooks/usePortalSync.js';
import { PORTAL_TOPICS } from '../utils/portalSync.js';

function TableSkeleton() {
  return (
    <div className="salary-table-skeleton" aria-busy="true" aria-label="Loading LOP deductions">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

export default function LopDetailModal({
  open,
  userId,
  employeeName,
  month,
  asOf,
  yearOptions,
  monthOptions,
  onMonthChange,
  onDetailLoaded,
  onClose,
}) {
  const titleId = useId();
  const previouslyFocused = useRef(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  const loadDetail = useCallback(async () => {
    if (!userId || !month) return;
    setLoading(true);
    setError('');
    try {
      const data = await salaryApi.getLopDetail(userId, { month, asOf });
      setDetail(data);
      onDetailLoaded?.(data);
    } catch (err) {
      setDetail(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [asOf, month, onDetailLoaded, userId]);

  const handleAttendanceSalarySync = useCallback(() => {
    if (!open) return;
    loadDetail();
  }, [loadDetail, open]);

  usePortalSync(handleAttendanceSalarySync, {
    topics: [PORTAL_TOPICS.PAYROLL],
    userId,
    month,
  });

  useEffect(() => {
    if (!open) {
      setDetail(null);
      setError('');
      return;
    }
    loadDetail();
  }, [loadDetail, open]);

  if (!open) return null;

  const displayName = detail?.name ?? employeeName ?? 'Employee';
  const deductions = detail?.deductions ?? [];

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
            LOP detail — {displayName}
          </h2>
          <p className="modal__lead muted">
            Deductions for {formatMonthLabel(month)}
            {detail?.asOfDate ? ` as of ${formatISTDate(detail.asOfDate)}` : ''}. Payable total is
            not shown here — see the list for month-to-date payable.
          </p>
        </header>

        <div className="modal__body salary-detail-modal__body">
          <div className="salary-toolbar__filters filter-bar">
            <div className="filter-bar__field salary-toolbar__field salary-toolbar__field--period">
              <div className="salary-toolbar__period">
                <div className="field-inline">
                  <span className="label">Year</span>
                  <SelectField
                    value={month.split('-')[0]}
                    onChange={(year) => onMonthChange?.(year, month.split('-')[1])}
                    options={yearOptions}
                    aria-label="LOP detail year"
                    disabled={loading}
                  />
                </div>
                <div className="field-inline">
                  <span className="label">Month</span>
                  <SelectField
                    value={month.split('-')[1]}
                    onChange={(monthPart) => onMonthChange?.(month.split('-')[0], monthPart)}
                    options={monthOptions}
                    aria-label="LOP detail month"
                    disabled={loading}
                  />
                </div>
              </div>
            </div>
          </div>

          {error ? <div className="alert alert--error">{error}</div> : null}

          {!loading && detail ? (
            <dl className="detail-list detail-list--grid salary-detail__grid">
              <div>
                <dt>Paid days (out of 30)</dt>
                <dd>{detail.paidDaysOutOf30 ?? '—'}</dd>
              </div>
              <div>
                <dt>Loss of pay (days)</dt>
                <dd>{detail.totalLopDays ?? '—'}</dd>
              </div>
            </dl>
          ) : null}

          {loading ? (
            <TableSkeleton />
          ) : deductions.length === 0 ? (
            <EmptyState
              icon={EMPTY_ICONS.payroll}
              title="No LOP deductions"
              description="No absent, half-day, or unpaid leave deductions for this employee in the selected month and viewing date."
            />
          ) : (
            <div className="table-wrap table-wrap--responsive salary-table-wrap">
              <table className="table data-table salary-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reason</th>
                    <th className="salary-table__num">Amount deducted</th>
                  </tr>
                </thead>
                <tbody>
                  {deductions.map((row) => (
                    <tr key={`${row.date}-${row.reason}-${row.amountDeducted}`}>
                      <td data-label="Date">{formatISTDate(row.date)}</td>
                      <td data-label="Reason">{row.reason}</td>
                      <td data-label="Amount deducted" className="salary-table__num">
                        {formatINRCurrency(row.amountDeducted)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
