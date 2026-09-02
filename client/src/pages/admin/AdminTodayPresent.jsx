import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';

function isPresent(member) {
  return member.status === 'checked_in' || member.status === 'wfh';
}

export default function AdminTodayPresent() {
  const { setMeta } = usePageMetaContext();
  const [teamStatus, setTeamStatus] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    setMeta({
      title: 'Today Present',
      subtitle: 'Live attendance status for all team members',
    });
  }, [setMeta]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await adminApi.getTeamTodayStatus();
      setTeamStatus(data.teamStatus ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
      setTeamStatus([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return teamStatus;
    return teamStatus.filter((member) => {
      const name = (member.name || member.firstName || '').toLowerCase();
      const code = (member.employeeCode || '').toLowerCase();
      const dept = (member.department || '').toLowerCase();
      const role = (member.roleName || '').toLowerCase();
      return (
        name.includes(needle) ||
        code.includes(needle) ||
        dept.includes(needle) ||
        role.includes(needle)
      );
    });
  }, [teamStatus, query]);

  const summary = useMemo(() => {
    let present = 0;
    let absent = 0;
    let onLeave = 0;
    for (const member of teamStatus) {
      if (member.status === 'on_leave') onLeave += 1;
      else if (isPresent(member)) present += 1;
      else absent += 1;
    }
    return { present, absent, onLeave, total: teamStatus.length };
  }, [teamStatus]);

  return (
    <div className="page page--admin-today-present">
      <section className="today-present-summary" aria-label="Today summary">
        <div className="today-present-summary__card today-present-summary__card--present">
          <span className="today-present-summary__value">{summary.present}</span>
          <span className="today-present-summary__label">Present</span>
        </div>
        <div className="today-present-summary__card today-present-summary__card--absent">
          <span className="today-present-summary__value">{summary.absent}</span>
          <span className="today-present-summary__label">Absent</span>
        </div>
        <div className="today-present-summary__card today-present-summary__card--leave">
          <span className="today-present-summary__value">{summary.onLeave}</span>
          <span className="today-present-summary__label">On Leave</span>
        </div>
        <div className="today-present-summary__card">
          <span className="today-present-summary__value">{summary.total}</span>
          <span className="today-present-summary__label">Total</span>
        </div>
      </section>

      <section className="card card--table" aria-label="Team present status">
        <div className="card__header">
          <h2 className="card__title" style={{ textAlign: 'left' }}>Team Attendance Today</h2>
          <div className="search-input">
            <svg className="search-input__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              className="input search-input__field"
              placeholder="Search name, code, department, role"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search team members"
            />
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <div className="employees-table-skeleton" aria-busy="true" aria-label="Loading team status">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table today-present-table">
              <thead>
                <tr>
                  <th scope="col" className="today-present-table__col-num">#</th>
                  <th scope="col">Employee</th>
                  <th scope="col">Department</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted small today-present-table__empty">
                      No team members found.
                    </td>
                  </tr>
                ) : (
                  filtered.map((member, index) => {
                    const present = isPresent(member);
                    return (
                      <tr key={member.userId}>
                        <td className="today-present-table__col-num">{index + 1}</td>
                        <td data-label="Employee" className="today-present-table__employee">
                          <span className="today-present-table__name">
                            {member.firstName ||
                              member.name?.split(' ')[0] ||
                              'Team Member'}
                          </span>
                          {member.employeeCode && (
                            <span className="today-present-table__code muted small">
                              {' '}
                              ({member.employeeCode})
                            </span>
                          )}
                        </td>
                        <td data-label="Department">{member.department ?? '—'}</td>
                        <td data-label="Role">{member.roleName ?? '—'}</td>
                        <td data-label="Status">
                          <span
                            className={`today-present-table__badge today-present-table__badge--${
                              present ? 'present' : 'absent'
                            }`}
                          >
                            {present ? 'Present' : 'Absent'}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
