import { useEffect, useState } from 'react';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { formatISTDateTime } from '../../utils/datetime.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';

const ACTION_OPTIONS = [
  { value: '', label: 'All login events' },
  { value: 'login_success', label: 'Login success' },
  { value: 'login_failed', label: 'Login failed' },
];

function statusBadgeClass(status) {
  if (status === 'success') return 'badge badge-success';
  if (status === 'failed') return 'badge badge-warning';
  return 'badge badge-muted';
}

function formatAuditStatus(status) {
  if (status === 'success') return 'Success';
  if (status === 'failed') return 'Failed';
  return status || '—';
}

export default function AdminAuditLogs() {
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadLogs(nextPage = 1) {
    setLoading(true);
    setError('');
    try {
      const params = { page: nextPage, limit: 20 };
      if (action) params.action = action;
      const data = await adminApi.listAuditLogs(params);
      setLogs(data.logs);
      setPagination(data.pagination);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs(1);
  }, [action]);

  return (
    <div className="page">
      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline filter-bar__field">
            <span className="label">Action</span>
            <SelectField
              value={action}
              onChange={setAction}
              options={ACTION_OPTIONS}
              aria-label="Action filter"
            />
          </label>
        </div>

        {error && <div className="alert alert--error">{error}</div>}

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.inbox}
            title="No login logs found"
            description="Auth events will appear here as users sign in."
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time (IST)</th>
                    <th>Email</th>
                    <th>IP address</th>
                    <th>Action</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td data-label="Time (IST)">{formatISTDateTime(log.timestamp)}</td>
                      <td data-label="Email" className="cell-ellipsis" title={log.email || undefined}>
                        {log.email || '—'}
                      </td>
                      <td data-label="IP address" className="cell-ellipsis" title={log.ip || undefined}>
                        {log.ip || '—'}
                      </td>
                      <td data-label="Action">{log.action}</td>
                      <td data-label="Status">
                        <span className={statusBadgeClass(log.status)}>{formatAuditStatus(log.status)}</span>
                      </td>
                      <td data-label="Reason" className="cell-ellipsis" title={log.reason || undefined}>
                        {log.reason || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar pagination={pagination} onPageChange={loadLogs} />
          </>
        )}
      </div>
    </div>
  );
}
