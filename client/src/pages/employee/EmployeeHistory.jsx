import { useEffect, useState } from 'react';
import { attendanceApi, getErrorMessage } from '../../services/api.js';
import { formatISTDateTime, getISTDateInputValue } from '../../utils/datetime.js';
import { formatHistoryModeShort, formatHistoryShortCode, formatQuarterWarningBalance } from '../../utils/attendanceOutcome.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

function statusBadgeClass(status) {
  if (status === 'allowed') return 'badge badge-success';
  if (status === 'rejected') return 'badge badge-warning';
  return 'badge badge-muted';
}

function attendanceModeLabel(mode) {
  return mode === 'wfh' ? 'Work from Home' : 'Office';
}

function buildAllowedCheckInByIstDay(records) {
  const map = new Map();
  for (const record of records) {
    if (record.type === 'check_in' && record.status === 'allowed') {
      const dayKey = getISTDateInputValue(new Date(record.timestamp));
      if (!map.has(dayKey)) {
        map.set(dayKey, record);
      }
    }
  }
  return map;
}

export default function EmployeeHistory() {
  const [records, setRecords] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [quarterWarnings, setQuarterWarnings] = useState(null);

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
    attendanceApi.getQuarterWarnings().then(setQuarterWarnings).catch(() => setQuarterWarnings(null));
  }, []);

  const checkInByIstDay = records.length > 0 ? buildAllowedCheckInByIstDay(records) : null;

  return (
    <div className="page">
      <div className="card card--table">
        {quarterWarnings ? (
          <p className="employee-history__quarter muted small">
            {formatQuarterWarningBalance(quarterWarnings)}
          </p>
        ) : null}
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
                    <th>Outcome</th>
                    <th>Mode</th>
                    <th>Time (IST)</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => {
                    const outcomeCode = formatHistoryShortCode(record, {
                      sameDayCheckIn:
                        record.type === 'check_out'
                          ? checkInByIstDay?.get(getISTDateInputValue(new Date(record.timestamp)))
                          : undefined,
                    });
                    return (
                      <tr key={record._id}>
                        <td data-label="Type">{record.type === 'check_in' ? 'Check-in' : 'Check-out'}</td>
                        <td data-label="Status">
                          <span className={statusBadgeClass(record.status)}>
                            {record.status}
                          </span>
                        </td>
                        <td data-label="Outcome">
                          {outcomeCode ? (
                            <span className="badge badge-muted">{outcomeCode}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td data-label="Mode">
                          <span
                            className={`attendance-mode-badge attendance-mode-badge--${record.attendanceMode === 'wfh' ? 'wfh' : 'office'}${
                              record.type === 'check_in' &&
                              record.attendanceMode === 'wfh' &&
                              record.leaveStatus === 'pending'
                                ? ' attendance-mode-badge--wfh-pending'
                                : ''
                            }`}
                            title={
                              record.type === 'check_in' &&
                              record.attendanceMode === 'wfh' &&
                              record.leaveStatus === 'pending'
                                ? 'WFH approval pending — shown in red until approved'
                                : undefined
                            }
                          >
                            {formatHistoryModeShort(record) ?? attendanceModeLabel(record.attendanceMode)}
                          </span>
                        </td>
                        <td data-label="Time (IST)">{formatISTDateTime(record.timestamp)}</td>
                      </tr>
                    );
                  })}
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
