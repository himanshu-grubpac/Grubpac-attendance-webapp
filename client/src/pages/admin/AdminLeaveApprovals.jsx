import { useEffect, useState } from 'react';
import { formatISTDate } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

export default function AdminLeaveApprovals() {
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [comment, setComment] = useState('');
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

  async function handleDecision(id, decision) {
    const item = requests.find((request) => request.id === id);
    const payload = comment.trim() ? { comment: comment.trim() } : {};

    if (decision === 'reject') {
      await requestConfirm({
        title: 'Reject leave request?',
        message: item
          ? `Reject ${item.userName}'s ${item.leaveTypeCode} leave (${formatISTDate(item.startDate)} – ${formatISTDate(item.endDate)})? This cannot be undone from this screen.`
          : 'Reject this leave request? This cannot be undone from this screen.',
        confirmLabel: 'Reject',
        variant: 'danger',
        onConfirm: async () => {
          setActingId(id);
          setError('');
          try {
            await leaveApi.rejectRequest(id, payload);
            setMessage('Leave request rejected.');
            setComment('');
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
      setMessage('Leave request approved.');
      setComment('');
      await loadRequests(page);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="page">
      {(message || error) && (
        <div className="page-alerts">
          {message && <div className="alert alert--success">{message}</div>}
          {error && <div className="alert alert--error">{error}</div>}
        </div>
      )}

      <div className="card card--table">
        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No pending leave requests"
            description="When employees submit leave, requests will appear here for approval."
          />
        ) : (
          <>
            <div className="card__toolbar">
              <label className="field-inline full-width">
                <span className="label">Decision comment (optional)</span>
                <input
                  type="text"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Reason or note for employee"
                />
              </label>
            </div>
            <div className="table-wrap table-wrap--responsive">
              <table className="table data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Days</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((item) => (
                    <tr key={item.id}>
                      <td data-label="Employee">
                        <strong>{item.userName}</strong>
                        <div className="muted small cell-ellipsis" title={item.userEmail}>
                          {item.userEmail}
                        </div>
                      </td>
                      <td data-label="Type">{item.leaveTypeCode}</td>
                      <td data-label="Dates">
                        {formatISTDate(item.startDate)} – {formatISTDate(item.endDate)}
                        {item.halfDay ? ` (${item.halfDay.toUpperCase()})` : ''}
                      </td>
                      <td data-label="Days">{item.days}</td>
                      <td data-label="Status">
                        <LeaveStatusBadge status={item.status} />
                      </td>
                      <td data-label="Actions" className="cell-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={actingId === item.id}
                          onClick={() => handleDecision(item.id, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={actingId === item.id}
                          onClick={() => handleDecision(item.id, 'reject')}
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar pagination={pagination} onPageChange={loadRequests} />
          </>
        )}
      </div>

      {confirmDialog}
    </div>
  );
}
