import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, getErrorMessage } from '../../services/api.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useToast } from '../../context/ToastContext.jsx';

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
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [resetting, setResetting] = useState(false);
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { showSuccess, showError } = useToast();

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
      setSelectedIds((prev) => {
        const valid = new Set(employeeList.map((employee) => String(employee.id)));
        return new Set([...prev].filter((id) => valid.has(id)));
      });
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

  const rowIds = useMemo(() => rows.map(({ employee }) => String(employee.id)), [rows]);
  const selectedCount = selectedIds.size;
  const allSelected = rowIds.length > 0 && rowIds.every((id) => selectedIds.has(id));
  const someSelected = selectedCount > 0 && !allSelected;

  const quarterLabel = summary.quarter?.label ?? 'Current quarter';

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(rowIds));
  }

  function toggleSelect(userId) {
    const id = String(userId);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runReset(userIds, label) {
    const ids = [...new Set(userIds.map((id) => String(id)))];
    if (!ids.length) return;

    await requestConfirm({
      title: ids.length === 1 ? 'Reset Late Warning?' : 'Reset Late Warnings?',
      message:
        ids.length === 1
          ? `Clear ${label}'s late-check-in warnings for ${quarterLabel}? This only affects the current quarter and cannot be undone from this screen.`
          : `Clear late-check-in warnings for ${ids.length} selected employees for ${quarterLabel}? This only affects the current quarter and cannot be undone from this screen.`,
      confirmLabel: ids.length === 1 ? 'Reset Late Warning' : 'Reset selected',
      variant: 'danger',
      busyLabel: 'Resetting…',
      onConfirm: async () => {
        setResetting(true);
        setError('');
        try {
          const result = await adminApi.resetQuarterWarnings(ids);
          if (result?.summary) {
            setSummary((prev) => ({
              ...prev,
              ...result.summary,
              byUser: {
                ...(prev.byUser ?? {}),
                ...(result.summary.byUser ?? {}),
              },
            }));
          } else {
            await load();
          }
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.delete(id);
            return next;
          });
          showSuccess(
            ids.length === 1
              ? `Late Warning reset for ${label} (${quarterLabel}).`
              : `Late Warnings reset for ${ids.length} employees (${quarterLabel}).`,
          );
        } catch (err) {
          showError(getErrorMessage(err));
          throw err;
        } finally {
          setResetting(false);
        }
      },
    });
  }

  return (
    <div className="page page--streaks">
      {confirmDialog}
      <section className="streaks-panel card card--table" aria-label="Quarter Late Warnings">
        <div className="streaks-toolbar">
          <p className="muted small streaks-toolbar__hint">
            {quarterLabel} — quarterly late-check-in warnings used and remaining per employee.
          </p>
          <div className="streaks-toolbar__actions">
            {selectedCount > 0 ? (
              <span className="muted small streaks-toolbar__selected">{selectedCount} selected</span>
            ) : null}
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={selectedCount < 1 || loading || resetting}
              onClick={() => runReset([...selectedIds], `${selectedCount} employees`)}
            >
              Bulk Reset
            </button>
          </div>
        </div>

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
                  <th scope="col" className="streaks-table__col-select">
                    <input
                      type="checkbox"
                      className="streaks-table__checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={toggleSelectAll}
                      aria-label="Select all employees on this page"
                      disabled={resetting}
                    />
                  </th>
                  <th scope="col" className="streaks-table__col-row-num">
                    #
                  </th>
                  <th>Employee</th>
                  <th>Used</th>
                  <th>Remaining</th>
                  <th>Total</th>
                  <th scope="col" className="streaks-table__col-actions">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ employee, stats }, index) => {
                  const id = String(employee.id);
                  const isSelected = selectedIds.has(id);
                  return (
                    <tr key={id} className={isSelected ? 'is-selected' : undefined}>
                      <td className="streaks-table__select" data-label="Select">
                        <input
                          type="checkbox"
                          className="streaks-table__checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(id)}
                          aria-label={`Select ${employee.name}`}
                          disabled={resetting}
                        />
                      </td>
                      <td className="streaks-table__row-num">{index + 1}</td>
                      <td data-label="Employee">
                        <Link to={`/admin/users/${employee.id}`} className="table-link">
                          {employee.name}
                        </Link>
                      </td>
                      <td data-label="Used">{stats.used}</td>
                      <td data-label="Remaining">{stats.remaining}</td>
                      <td data-label="Total">{stats.allowance}</td>
                      <td data-label="Actions" className="streaks-table__actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={resetting}
                          onClick={() => runReset([id], employee.name)}
                        >
                          Reset
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
