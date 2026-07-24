import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatISTDate } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useToast } from '../../context/ToastContext.jsx';

export default function EmployeeMyLeaveRequests() {
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { showSuccess, showError } = useToast();
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

  async function handleCancel(id) {
    await requestConfirm({
      title: 'Cancel leave request?',
      message: 'Cancel this pending leave request? Your manager will no longer see it as pending.',
      confirmLabel: 'Cancel request',
      variant: 'danger',
      onConfirm: async () => {
        await leaveApi.cancelRequest(id);
        showSuccess('Leave request cancelled.');
        await loadRequests(page);
      },
    });
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
                        {item.status === 'pending' && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleCancel(item.id)}>
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

      {confirmDialog}
    </div>
  );
}
