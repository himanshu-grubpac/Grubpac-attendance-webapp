import { useEffect, useMemo, useState } from 'react';
import { formatISTDate, getISTDateInputValue } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PageLoading from '../../components/PageLoading.jsx';

function currentMonthInput() {
  const value = getISTDateInputValue();
  return value.slice(0, 7);
}

function buildTeamLeaveGrid(month, entries) {
  const [year, monthNum] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, monthNum - 1, 1));
  const startWeekday = (firstDay.getUTCDay() + 6) % 7;

  const counts = {};
  for (const entry of entries) {
    if (entry.status !== 'approved' && entry.status !== 'pending') continue;
    const start = new Date(entry.startDate);
    const end = new Date(entry.endDate);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dayKey = `${month}-${String(day).padStart(2, '0')}`;
      const dayDate = new Date(Date.UTC(year, monthNum - 1, day, 12, 0, 0));
      if (dayDate >= start && dayDate <= end) {
        counts[dayKey] = (counts[dayKey] ?? 0) + 1;
      }
    }
  }

  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${month}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  return { cells, counts };
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function AdminTeamLeaveCalendar() {
  const [month, setMonth] = useState(currentMonthInput());
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadCalendar() {
    setLoading(true);
    setError('');
    try {
      const data = await leaveApi.getTeamCalendar({ month });
      setEntries(data.entries ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCalendar();
  }, [month]);

  const teamGrid = useMemo(() => buildTeamLeaveGrid(month, entries), [month, entries]);

  return (
    <div className="page">
      {error && <div className="alert alert--error">{error}</div>}

      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline form-field--sm">
            <span className="label">Month</span>
            <input
              className="input--narrow"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </label>
        </div>

        <div className="card__section">
          <div className="team-leave-calendar">
            <p className="card__section-title">Team away (approved + pending)</p>
            {loading ? (
              <PageLoading compact text="Loading calendar…" />
            ) : (
              <>
                <div className="team-leave-grid" aria-hidden="true">
                {WEEKDAY_LABELS.map((label) => (
                  <span key={label} className="team-leave-grid__head">
                    {label}
                  </span>
                ))}
                {teamGrid.cells.map((dayKey, index) => {
                  if (!dayKey) {
                    return (
                      <span
                        key={`empty-${index}`}
                        className="team-leave-grid__cell team-leave-grid__cell--empty"
                      />
                    );
                  }
                  const count = teamGrid.counts[dayKey] ?? 0;
                  const dayNum = Number(dayKey.slice(-2));
                  return (
                    <span
                      key={dayKey}
                      className={`team-leave-grid__cell${count > 0 ? ' team-leave-grid__cell--busy' : ''}`}
                      title={count > 0 ? `${count} away on ${dayKey}` : dayKey}
                    >
                      {count > 0 ? count : dayNum}
                    </span>
                  );
                })}
                </div>
                <div className="team-leave-calendar__legend" aria-label="Calendar legend">
                  <span className="team-leave-calendar__legend-item">
                    <span className="team-leave-calendar__swatch" aria-hidden="true" />
                    Day number
                  </span>
                  <span className="team-leave-calendar__legend-item">
                    <span className="team-leave-calendar__swatch team-leave-calendar__swatch--busy" aria-hidden="true" />
                    Employees away
                  </span>
                </div>
              {entries.length === 0 ? (
                <EmptyState
                  compact
                  icon={EMPTY_ICONS.leave}
                  title="No team leave this month"
                  description="Approved and pending leave will show on the grid and list below."
                />
              ) : (
                <div className="table-wrap table-wrap--responsive">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Type</th>
                        <th>Dates</th>
                        <th>Days</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((item) => (
                        <tr key={item.id}>
                          <td data-label="Employee">{item.userName}</td>
                          <td data-label="Type">{item.leaveTypeCode}</td>
                          <td data-label="Dates">
                            {formatISTDate(item.startDate)} – {formatISTDate(item.endDate)}
                          </td>
                          <td data-label="Days">{item.days}</td>
                          <td data-label="Status">
                            <LeaveStatusBadge status={item.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
