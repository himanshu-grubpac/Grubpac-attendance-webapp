import { useEffect, useState } from 'react';
import { formatISTDate } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

function leaveTypeLabel(item) {
  if (item.leaveTypeCode && item.leaveTypeName) {
    return `${item.leaveTypeCode} — ${item.leaveTypeName}`;
  }
  return item.leaveTypeCode || item.leaveTypeName || 'Leave';
}

function halfDayLabel(halfDay) {
  if (halfDay === 'am') return 'Morning half-day';
  if (halfDay === 'pm') return 'Afternoon half-day';
  return null;
}

function dateRangeLabel(item) {
  const start = formatISTDate(item.startDate);
  const end = formatISTDate(item.endDate);
  const half = halfDayLabel(item.halfDay);
  const halfSuffix = half ? ` · ${half}` : '';
  if (start === end) return `${start}${halfSuffix}`;
  return `${start} – ${end}${halfSuffix}`;
}

function durationLabel(days) {
  const value = Number(days);
  if (!Number.isFinite(value)) return '—';
  if (value === 1) return '1 day';
  return `${value} days`;
}

export default function AdminLeaveApprovals() {
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [comments, setComments] = useState({});
  const [actingId, setActingId] = useState(null);

  async function loadRequests(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const data = await leaveApi.listRequests({
        scope: 'approvals',
        page: nextPage,
        limit: 20,
      });
      setRequests(data.requests ?? []);
      setPagination(data.pagination ?? null);
      setPage(nextPage);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRequests(1);
  }, []);

  function setCommentFor(id, value) {
    setComments((prev) => ({ ...prev, [id]: value }));
  }

  async function handleDecision(id, decision) {
    const item = requests.find((request) => request.id === id);
    const note = (comments[id] ?? '').trim();
    const payload = note ? { comment: note } : {};

    if (decision === 'reject') {
      await requestConfirm({
        title: 'Decline leave request?',
        message: item
          ? `Decline ${item.userName}'s request for ${leaveTypeLabel(item)} (${dateRangeLabel(item)}). The employee will be notified. This action cannot be reversed from this screen.`
          : 'Decline this leave request? The employee will be notified. This action cannot be reversed from this screen.',
        confirmLabel: 'Decline request',
        variant: 'danger',
        onConfirm: async () => {
          setActingId(id);
          setError('');
          try {
            await leaveApi.rejectRequest(id, payload);
            setMessage('Leave request declined. The employee has been notified.');
            setComments((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
            await loadRequests(page);
          } finally {
            setActingId(null);
          }
        },
      });
      return;
    }

    setActingId(id);
    setError('');
    try {
      await leaveApi.approveRequest(id, payload);
      setMessage('Leave request approved. The employee has been notified.');
      setComments((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await loadRequests(page);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="page page--approvals">
      {(message || error) && (
        <div className="page-alerts">
          {message && <div className="alert alert--success">{message}</div>}
          {error && <div className="alert alert--error">{error}</div>}
        </div>
      )}

      {loading ? (
        <div className="approval-queue" aria-busy="true" aria-label="Loading leave approvals">
          <div className="approval-card approval-card--skeleton">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
          <div className="approval-card approval-card--skeleton">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        </div>
      ) : requests.length === 0 ? (
        <div className="approval-empty card">
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No leave requests pending approval"
            description="New leave requests that require your decision will appear in this queue."
          />
        </div>
      ) : (
        <>
          <div className="approval-queue">
            {requests.map((item) => {
              const busy = actingId === item.id;
              return (
                <article key={item.id} className="approval-card">
                  <header className="approval-card__header">
                    <div className="approval-card__identity">
                      <h2 className="approval-card__name">{item.userName || 'Employee'}</h2>
                      {item.userEmail ? (
                        <p className="approval-card__email" title={item.userEmail}>
                          {item.userEmail}
                        </p>
                      ) : null}
                    </div>
                    <LeaveStatusBadge status={item.status} />
                  </header>

                  <dl className="approval-card__meta">
                    <div className="approval-card__meta-item">
                      <dt>Leave type</dt>
                      <dd>{leaveTypeLabel(item)}</dd>
                    </div>
                    <div className="approval-card__meta-item">
                      <dt>Leave period</dt>
                      <dd>{dateRangeLabel(item)}</dd>
                    </div>
                    <div className="approval-card__meta-item">
                      <dt>Duration</dt>
                      <dd>{durationLabel(item.days)}</dd>
                    </div>
                  </dl>

                  {item.reason ? (
                    <div className="approval-card__reason">
                      <span className="label">Request reason</span>
                      <p>{item.reason}</p>
                    </div>
                  ) : null}

                  {item.documentUrl ? (
                    <a
                      className="approval-card__doc"
                      href={item.documentUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open supporting document
                    </a>
                  ) : null}

                  <label className="approval-card__comment field">
                    <span className="label">Approver comment (optional)</span>
                    <input
                      type="text"
                      value={comments[item.id] ?? ''}
                      onChange={(event) => setCommentFor(item.id, event.target.value)}
                      placeholder="Shared with the employee after your decision"
                      disabled={busy}
                      maxLength={500}
                    />
                  </label>

                  <div className="approval-card__actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => handleDecision(item.id, 'approve')}
                    >
                      {busy ? 'Submitting…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => handleDecision(item.id, 'reject')}
                    >
                      Decline
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="approval-pagination">
            <PaginationBar pagination={pagination} onPageChange={loadRequests} />
          </div>
        </>
      )}

      {confirmDialog}
    </div>
  );
}
