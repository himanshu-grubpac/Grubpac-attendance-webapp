import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, getErrorMessage } from '../../services/api.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

async function fetchActiveEmployees() {
  const employees = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await adminApi.listEmployees({ page, limit: 100, isActive: 'true' });
    employees.push(...(data.employees ?? []));
    totalPages = data.pagination?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return employees;
}

export default function AdminStreaks() {
  const [employees, setEmployees] = useState([]);
  const [summary, setSummary] = useState({ byUser: {}, quarter: null, allowance: 3 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [employeeList, warningData] = await Promise.all([
        fetchActiveEmployees(),
        adminApi.getQuarterWarnings(),
      ]);
      setEmployees(employeeList);
      setSummary(warningData);
    } catch (err) {
      setError(getErrorMessage(err));
      setEmployees([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    return employees
      .map((employee) => {
        const stats = summary.byUser?.[String(employee.id)] ?? {
          used: 0,
          allowance: summary.allowance ?? 3,
          remaining: summary.allowance ?? 3,
        };
        return { employee, stats };
      })
      .sort((a, b) => b.stats.used - a.stats.used || a.employee.name.localeCompare(b.employee.name));
  }, [employees, summary]);

  const quarterLabel = summary.quarter?.label ?? 'Current quarter';

  return (
    <div className="page page--streaks">
      <section className="streaks-panel card card--table" aria-label="Quarter warning streaks">
        <p className="muted small streaks-toolbar__hint">
          {quarterLabel} — quarterly late-check-in warnings used and remaining per employee.
        </p>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.users}
            title="No employees to display"
            description="Active employees with team access will appear here."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table streaks-table">
              <thead>
                <tr>
                  <th scope="col" className="streaks-table__col-row-num">
                    #
                  </th>
                  <th>Employee</th>
                  <th>Used</th>
                  <th>Remaining</th>
                  <th>Allowance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ employee, stats }, index) => (
                  <tr key={employee.id}>
                    <td className="streaks-table__row-num">{index + 1}</td>
                    <td data-label="Employee">
                      <Link to={`/admin/users/${employee.id}`} className="table-link">
                        {employee.name}
                      </Link>
                    </td>
                    <td data-label="Used">{stats.used}</td>
                    <td data-label="Remaining">{stats.remaining}</td>
                    <td data-label="Allowance">{stats.allowance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
