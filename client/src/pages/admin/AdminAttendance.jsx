import { useEffect, useState } from 'react';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { formatISTDateTime, getISTDateInputValue } from '../../utils/datetime.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';

function statusBadgeClass(status) {
  if (status === 'allowed') return 'badge badge-success';
  if (status === 'rejected') return 'badge badge-warning';
  return 'badge badge-muted';
}

export default function AdminAttendance() {
  const [records, setRecords] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [userId, setUserId] = useState('');
  const [date, setDate] = useState(getISTDateInputValue());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    adminApi
      .listEmployees({ limit: 100 })
      .then((data) => setEmployees(data.employees))
      .catch(() => {});
  }, []);

  async function loadRecords(nextPage = 1) {
    setLoading(true);
    setError('');
    try {
      const params = { page: nextPage, limit: 20 };
      if (userId) params.userId = userId;
      if (date) params.date = date;
      const data = await adminApi.listAttendance(params);
      setRecords(data.records);
      setPagination(data.pagination);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRecords(1);
  }, [userId, date]);

  return (
    <div className="page">
      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline filter-bar__field">
            <span className="label">Date (IST)</span>
            <input
              className="input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="field-inline filter-bar__field">
            <span className="label">Employee</span>
            <SelectField
              value={userId}
              onChange={setUserId}
              options={[
                { value: '', label: 'All employees' },
                ...employees.map((employee) => ({ value: employee.id, label: employee.name })),
              ]}
              aria-label="Employee filter"
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
        ) : records.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.calendar}
            title="No attendance records"
            description="Try a different date or employee filter."
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive">
              <table className="table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Time (IST)</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record._id}>
                      <td data-label="Employee">{record.userId?.name ?? '—'}</td>
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
            <PaginationBar pagination={pagination} onPageChange={loadRecords} />
          </>
        )}
      </div>
    </div>
  );
}
