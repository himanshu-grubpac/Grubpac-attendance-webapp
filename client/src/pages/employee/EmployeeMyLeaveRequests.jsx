import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatISTDate, getISTDateInputValue } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useActionPopup } from '../../context/ActionPopupContext.jsx';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

/** True when the leave request can still be cancelled (end date has not passed, IST). */
function canCancelLeaveRequest(item) {
  if (item.status !== 'pending' && item.status !== 'approved') return false;
  const todayKey = getISTDateInputValue();
  const endKey = typeof item.endDate === 'string' ? item.endDate.slice(0, 10) : null;
  if (!endKey) return false;
  return endKey >= todayKey;
}

export default function EmployeeMyLeaveRequests() {
  const { showSuccess, showError } = useToast();
  const { showActionPopup } = useActionPopup();
  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadRequests(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const data = await leaveApi.listRequests({ scope: 'mine', page: nextPage, limit: 20 });
      setRequests(data.requests ?? []);
      setPagination(data.pagination ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRequests(page);
  }, [page]);

  async function handleCancel(item) {
    const isApproved = item.status === 'approved';
    const message = isApproved
      ? 'Cancel this approved leave? The leave days will be returned to your balance.'
      : 'Cancel this leave request? It will be removed.';
    if (!window.confirm(message)) {
      return;
    }
    try {
      const response = await leaveApi.cancelRequest(item.id);
      if (isApproved) {
        const durationMs = response?.request?.decisionUndoExpiresAt
          ? Math.max(0, new Date(response.request.decisionUndoExpiresAt).getTime() - Date.now())
          : 0;
        if (durationMs > 0) {
          showActionPopup({
            message: 'Approved leave cancelled. If done by mistake, click Undo to revert.',
            undoLabel: 'Undo',
            onUndo: async () => {
              try {
                await leaveApi.undoCancellation(item.id);
                showSuccess('Cancellation undone. Leave restored.');
                loadRequests(page);
              } catch (err) {
                showError(getErrorMessage(err));
              }
            },
            durationMs,
          });
        } else {
          showSuccess('Approved leave cancelled. The days were returned to your balance.');
        }
      } else {
        showSuccess('Leave request cancelled.');
      }
      loadRequests(page);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div className="page">
      {error && <div className="alert alert--error">{error}</div>}

      <div className="card card--table">
        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No leave requests yet"
            description="Submit a leave application when you need time off."
            action={
              <Link to="/employee/leave/apply" className="btn btn-primary btn-sm">
                Apply leave
              </Link>
            }
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Days</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((item) => (
                    <tr key={item.id}>
                      <td data-label="Type">{item.leaveTypeCode}</td>
                      <td data-label="Dates">
                        {formatISTDate(item.startDate)} – {formatISTDate(item.endDate)}
                        {item.halfDay ? ` (${item.halfDay.toUpperCase()})` : ''}
                      </td>
                      <td data-label="Days">{item.days}</td>
                      <td data-label="Status">
                        <LeaveStatusBadge status={item.status} />
                      </td>
                      <td data-label="Action" className="cell-actions">
                        {canCancelLeaveRequest(item) && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleCancel(item)}>
                            Cancel
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
