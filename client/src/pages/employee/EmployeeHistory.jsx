import { useEffect, useState } from 'react';
import { attendanceApi, getErrorMessage } from '../../services/api.js';
import { formatISTDateTime } from '../../utils/datetime.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

function statusBadgeClass(status) {
  if (status === 'allowed') return 'badge badge-success';
  if (status === 'rejected') return 'badge badge-warning';
  return 'badge badge-muted';
}

export default function EmployeeHistory() {
  const [records, setRecords] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadHistory(nextPage = 1) {
    setLoading(true);
    setError('');
    try {
      const data = await attendanceApi.getHistory({ page: nextPage, limit: 20 });
      setRecords(data.records);
      setPagination(data.pagination);
      setPage(nextPage);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadHistory(1);
  }, []);

  return (
    <div className="page">
      <div className="card card--table">
        {error && <div className="alert alert--error">{error}</div>}

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : records.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.calendar}
            title="No attendance records yet"
            description="Check in from your dashboard to start building history."
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive">
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Time (IST)</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record._id}>
                      <td data-label="Type">{record.type === 'check_in' ? 'Check-in' : 'Check-out'}</td>
                      <td data-label="Status">
                        <span className={statusBadgeClass(record.status)}>
                          {record.status}
                        </span>
                      </td>
                      <td data-label="Time (IST)">{formatISTDateTime(record.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar pagination={pagination} onPageChange={loadHistory} />
          </>
        )}
      </div>
    </div>
  );
}
