import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { IST_TIMEZONE } from '../../utils/datetime.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

const STAT_CARDS = [
  {
    key: 'total',
    label: 'TOTAL EMPLOYEES',
    hint: 'Registered across all teams',
    icon: '👤',
    statKey: 'total',
  },
  {
    key: 'active',
    label: 'ACTIVE',
    hint: 'Checked in or active status',
    icon: '✓',
    statKey: 'active',
  },
  {
    key: 'inactive',
    label: 'INACTIVE',
    hint: 'On leave or off-boarded',
    icon: '✕',
    statKey: 'inactive',
  },
  {
    key: 'newThisMonth',
    label: 'NEW THIS MONTH',
    hint: (stats) => formatJoinedSinceHint(stats?.monthKey),
    icon: '+',
    statKey: 'newThisMonth',
  },
];

function formatJoinedSinceHint(monthKey) {
  if (!monthKey) return 'Joined since month start';
  const [year, month] = monthKey.split('-').map(Number);
  const monthAbbr = new Intl.DateTimeFormat('en-IN', { month: 'short' }).format(
    new Date(year, month - 1, 1),
  );
  return `Joined since ${monthAbbr} 1st`;
}

function departmentLabel(employee) {
  return employee.departmentName || employee.department || '—';
}

function lastLoginLabel(value) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function StatCardSkeleton() {
  return (
    <div className="employees-stat card employees-stat--skeleton" aria-hidden="true">
      <div className="employees-stat__head">
        <div className="skeleton employees-stat__skeleton-label" />
        <div className="skeleton employees-stat__skeleton-icon" />
      </div>
      <div className="skeleton employees-stat__skeleton-value" />
      <div className="skeleton employees-stat__skeleton-hint" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="employees-table-skeleton" aria-busy="true" aria-label="Loading employees">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

export default function AdminUsers() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWriteUsers = hasPermission(PERMISSIONS.USERS_WRITE);
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

  const [employees, setEmployees] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [stats, setStats] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const skipDebouncedSearchRef = useRef(true);
  const requestKeyRef = useRef('');
  const statusFilterRef = useRef(statusFilter);
  const departmentFilterRef = useRef(departmentFilter);
  statusFilterRef.current = statusFilter;
  departmentFilterRef.current = departmentFilter;
  const [listError, setListError] = useState('');
  const [statsError, setStatsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);

  const departmentOptions = useMemo(
    () => [
      { value: '', label: 'All' },
      ...departments.map((department) => ({
        value: department.id,
        label: department.name,
      })),
    ],
    [departments],
  );

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError('');
    try {
      const data = await adminApi.getEmployeeStats();
      setStats(data.stats ?? null);
    } catch (err) {
      setStats(null);
      setStatsError(getErrorMessage(err));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadEmployees = useCallback(async ({
    query = '',
    nextPage = 1,
    nextStatus = '',
    nextDepartment = '',
  } = {}) => {
    const requestKey = `${query ?? ''}|${nextPage}|${nextStatus}|${nextDepartment}`;
    requestKeyRef.current = requestKey;
    setLoading(true);
    try {
      const params = {
        search: query || undefined,
        page: nextPage,
        limit: 20,
      };
      if (nextStatus) params.isActive = nextStatus;
      if (nextDepartment) params.departmentId = nextDepartment;

      const data = await adminApi.listEmployees(params);
      if (requestKeyRef.current !== requestKey) return;
      setEmployees(data.employees);
      setPagination(data.pagination);
      setPage(nextPage);
      setListError('');
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setListError(getErrorMessage(err));
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadStats();
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch(() => {
        // Department filter remains optional.
      });
    loadEmployees({ query: '', nextPage: 1, nextStatus: '', nextDepartment: '' });
  }, [loadEmployees, loadStats]);

  useEffect(() => {
    if (skipDebouncedSearchRef.current) {
      skipDebouncedSearchRef.current = false;
      return;
    }
    loadEmployees({
      query: debouncedSearch,
      nextPage: 1,
      nextStatus: statusFilterRef.current,
      nextDepartment: departmentFilterRef.current,
    });
  }, [debouncedSearch, loadEmployees]);

  function handleStatusChange(value) {
    setStatusFilter(value);
    loadEmployees({ query: search, nextPage: 1, nextStatus: value });
  }

  function handleDepartmentChange(value) {
    setDepartmentFilter(value);
    loadEmployees({ query: search, nextPage: 1, nextDepartment: value });
  }

  function goToEmployee(employee) {
    navigate(`/admin/users/${employee.id}`);
  }

  async function toggleStatus(employee) {
    const nextActive = !employee.isActive;
    await requestConfirm({
      title: nextActive ? 'Activate employee?' : 'Deactivate employee?',
      message: nextActive
        ? `Activate ${employee.name}? They will be able to sign in again.`
        : `Deactivate ${employee.name}? They will no longer be able to sign in.`,
      confirmLabel: nextActive ? 'Activate' : 'Deactivate',
      variant: nextActive ? 'default' : 'danger',
      onConfirm: async () => {
        await adminApi.updateEmployeeStatus(employee.id, nextActive);
        await Promise.all([
          loadEmployees({
            query: search,
            nextPage: page,
            nextStatus: statusFilter,
            nextDepartment: departmentFilter,
          }),
          loadStats(),
        ]);
      },
    });
  }

  function getActionItems(employee) {
    const items = [
      {
        key: 'view',
        label: 'View details',
        onClick: () => navigate(`/admin/users/${employee.id}`),
      },
    ];

    if (!canWriteUsers) return items;

    return [
      ...items,
      {
        key: 'employment',
        label: 'Edit employment details',
        onClick: () => navigate(`/admin/users/${employee.id}?edit=employment`),
      },
      {
        key: 'reset',
        label: 'Reset password',
        onClick: () => navigate(`/admin/users/${employee.id}?edit=reset`),
      },
      {
        key: 'toggle',
        label: employee.isActive ? 'Deactivate' : 'Activate',
        variant: employee.isActive ? 'danger' : 'default',
        onClick: () => toggleStatus(employee),
      },
    ];
  }

  function handleRowClick(employee, event) {
    if (event.target.closest('button, a, [role="menu"], .employees-table__manage')) return;
    goToEmployee(employee);
  }

  function handleRowKeyDown(employee, event) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      goToEmployee(employee);
    }
  }

  function stopActionsBubble(event) {
    event.stopPropagation();
  }

  const hasActiveFilters = Boolean(search || statusFilter || departmentFilter);

  return (
    <div className="page page--employees">
      <section className="employees-stats" aria-label="Workforce summary">
        {statsError ? <div className="alert alert--error">{statsError}</div> : null}
        <div className="employees-stats__grid">
          {statsLoading
            ? STAT_CARDS.map((card) => <StatCardSkeleton key={card.key} />)
            : STAT_CARDS.map((card) => {
                const hint =
                  typeof card.hint === 'function' ? card.hint(stats) : card.hint;
                const value = stats?.[card.statKey];
                return (
                  <article key={card.key} className="employees-stat card">
                    <div className="employees-stat__head">
                      <span className="employees-stat__label">{card.label}</span>
                      <span className="employees-stat__icon" aria-hidden="true">
                        {card.icon}
                      </span>
                    </div>
                    <strong className="employees-stat__value">
                      {typeof value === 'number' ? value : '—'}
                    </strong>
                    <p className="employees-stat__hint muted small">{hint}</p>
                  </article>
                );
              })}
        </div>
      </section>

      <section className="employees-panel card card--table">
        <div className="employees-toolbar card__toolbar">
          <div className="employees-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search employees-toolbar__search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employee name, code…"
              ariaLabel="Search employees"
              onEnter={() => loadEmployees({ query: search, nextPage: 1 })}
            />

            <label className="field-inline filter-bar__field employees-toolbar__field">
              <span className="label">Department</span>
              <SelectField
                value={departmentFilter}
                onChange={handleDepartmentChange}
                options={departmentOptions}
                aria-label="Department filter"
              />
            </label>

            <label className="field-inline filter-bar__field employees-toolbar__field">
              <span className="label">Status</span>
              <SelectField
                value={statusFilter}
                onChange={handleStatusChange}
                options={STATUS_OPTIONS}
                aria-label="Status filter"
              />
            </label>
          </div>

          {canWriteUsers ? (
            <div className="employees-toolbar__actions">
              <Link to="/admin/users/register" className="btn btn-primary btn-sm">
                + Add Employee
              </Link>
            </div>
          ) : null}
        </div>

        {listError ? <div className="alert alert--error">{listError}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : employees.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.users}
            title={hasActiveFilters ? 'No employees match these filters' : 'No employees yet'}
            description={
              hasActiveFilters
                ? 'Try adjusting search or filters, or clear them to browse the full directory.'
                : 'Register an employee to build your directory and manage access from here.'
            }
            action={
              !hasActiveFilters && canWriteUsers ? (
                <Link to="/admin/users/register" className="btn btn-primary btn-sm">
                  Register employee
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive employees-table-wrap">
              <table className="table data-table employees-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Mobile</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Last login</th>
                    <th className="cell-actions-col cell-actions-col--text">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((employee) => {
                    const actionItems = getActionItems(employee);
                    return (
                      <tr
                        key={employee.id}
                        className="table-row--clickable employees-table__row"
                        onClick={(event) => handleRowClick(employee, event)}
                        onKeyDown={(event) => handleRowKeyDown(employee, event)}
                        tabIndex={0}
                        role="link"
                        aria-label={`Open ${employee.name}`}
                      >
                        <td data-label="Name" className="employees-table__name">
                          <Link
                            to={`/admin/users/${employee.id}`}
                            className="table-link employees-table__name-link"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {employee.name}
                          </Link>
                        </td>
                        <td
                          data-label="Email"
                          className="cell-ellipsis"
                          title={employee.email || undefined}
                        >
                          {employee.email || '—'}
                        </td>
                        <td data-label="Mobile">{employee.mobile || '—'}</td>
                        <td data-label="Department">{departmentLabel(employee)}</td>
                        <td data-label="Status">
                          <StatusBadge active={employee.isActive} />
                        </td>
                        <td data-label="Last login" className="cell-datetime">
                          {lastLoginLabel(employee.lastLoginAt)}
                        </td>
                        <td
                          data-label="Actions"
                          className="cell-actions cell-actions--text employees-table__actions"
                          onPointerDown={stopActionsBubble}
                          onMouseDown={stopActionsBubble}
                          onClick={stopActionsBubble}
                        >
                          {actionItems.length > 0 ? (
                            <div className="employees-table__manage">
                              <ActionMenu
                                label={`Manage ${employee.name}`}
                                items={actionItems}
                              />
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationBar
              pagination={pagination}
              onPageChange={(nextPage) =>
                loadEmployees({
                  query: search,
                  nextPage,
                  nextStatus: statusFilter,
                  nextDepartment: departmentFilter,
                })
              }
              entityLabel="employees"
            />
          </>
        )}
      </section>

      {confirmDialog}
    </div>
  );
}
