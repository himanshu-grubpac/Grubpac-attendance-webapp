import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { IST_TIMEZONE } from '../../utils/datetime.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const EMPLOYEE_PAGE_SIZE = 10;

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
  const [roles, setRoles] = useState([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [newThisMonthFilter, setNewThisMonthFilter] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRef = useRef(null);
  const debouncedSearch = useDebouncedValue(search, 350);
  const skipDebouncedSearchRef = useRef(true);
  const requestKeyRef = useRef('');
  const statusFilterRef = useRef(statusFilter);
  const departmentFilterRef = useRef(departmentFilter);
  const newThisMonthFilterRef = useRef(newThisMonthFilter);
  const statsRef = useRef(stats);
  statusFilterRef.current = statusFilter;
  departmentFilterRef.current = departmentFilter;
  const roleFilterRef = useRef(roleFilter);
  roleFilterRef.current = roleFilter;
  statsRef.current = stats;
  const [listError, setListError] = useState('');
  const [statsError, setStatsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);

  const roleOptions = useMemo(
    () => [
      { value: '', label: 'All roles' },
      ...roles.map((role) => ({ value: role.id, label: role.name })),
    ],
    [roles],
  );

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
    nextRole = '',
    nextNewThisMonth = false,
    monthKey = null,
    append = false,
  } = {}) => {
    const effectiveMonthKey = monthKey ?? statsRef.current?.monthKey;
    const createdAfter =
      nextNewThisMonth && effectiveMonthKey ? `${effectiveMonthKey}-01` : undefined;
    const requestKey = `${query ?? ''}|${nextPage}|${nextStatus}|${nextDepartment}|${nextRole}|${createdAfter ?? ''}|${append}`;
    requestKeyRef.current = requestKey;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const params = {
        search: query || undefined,
        page: nextPage,
        limit: EMPLOYEE_PAGE_SIZE,
      };
      if (nextStatus) params.isActive = nextStatus;
      if (nextDepartment) params.departmentId = nextDepartment;
      if (nextRole) params.roleId = nextRole;
      if (createdAfter) params.createdAfter = createdAfter;

      const data = await adminApi.listEmployees(params);
      if (requestKeyRef.current !== requestKey) return;
      setEmployees((current) =>
        append ? [...current, ...(data.employees ?? [])] : (data.employees ?? []),
      );
      setPagination(data.pagination);
      setPage(nextPage);
      setListError('');
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setListError(getErrorMessage(err));
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
        setLoadingMore(false);
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
    adminApi
      .listRoles()
      .then((data) => setRoles(data.roles ?? []))
      .catch(() => {});
    loadEmployees({ query: '', nextPage: 1, nextStatus: '', nextDepartment: '', nextRole: '' });
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
      nextRole: roleFilterRef.current,
      nextNewThisMonth: newThisMonthFilterRef.current,
    });
  }, [debouncedSearch, loadEmployees]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || loading || loadingMore) return;
        if (!pagination || page >= pagination.totalPages) return;
        loadEmployees({
          query: search,
          nextPage: page + 1,
          nextStatus: statusFilter,
          nextDepartment: departmentFilter,
          nextRole: roleFilter,
          nextNewThisMonth: newThisMonthFilter,
          append: true,
        });
      },
      { rootMargin: '120px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [
    departmentFilter,
    loadEmployees,
    loading,
    loadingMore,
    newThisMonthFilter,
    page,
    pagination,
    roleFilter,
    search,
    statusFilter,
  ]);

  function clearFilters() {
    setSearch('');
    setStatusFilter('');
    setDepartmentFilter('');
    setRoleFilter('');
    setNewThisMonthFilter(false);
    skipDebouncedSearchRef.current = true;
    loadEmployees({
      query: '',
      nextPage: 1,
      nextStatus: '',
      nextDepartment: '',
      nextRole: '',
      nextNewThisMonth: false,
    });
  }

  function handleRoleChange(value) {
    setRoleFilter(value);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: statusFilter,
      nextDepartment: departmentFilter,
      nextRole: value,
      nextNewThisMonth: newThisMonthFilter,
    });
  }

  function handleStatusChange(value) {
    setStatusFilter(value);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: value,
      nextDepartment: departmentFilter,
      nextNewThisMonth: newThisMonthFilter,
    });
  }

  function handleDepartmentChange(value) {
    setDepartmentFilter(value);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: statusFilter,
      nextDepartment: value,
      nextNewThisMonth: newThisMonthFilter,
    });
  }

  function handleNewThisMonthToggle() {
    const next = !newThisMonthFilter;
    setNewThisMonthFilter(next);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: statusFilter,
      nextDepartment: departmentFilter,
      nextNewThisMonth: next,
    });
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
            nextNewThisMonth: newThisMonthFilter,
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

  const hasActiveFilters = Boolean(
    search || statusFilter || departmentFilter || roleFilter || newThisMonthFilter,
  );
  const newThisMonthHint = formatJoinedSinceHint(stats?.monthKey);
  const pageSize = pagination?.limit ?? EMPLOYEE_PAGE_SIZE;

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
                const isNewThisMonthCard = card.key === 'newThisMonth';
                const isSelected = isNewThisMonthCard && newThisMonthFilter;
                const cardClassName = [
                  'employees-stat card',
                  isNewThisMonthCard ? 'employees-stat--clickable surface--clickable' : '',
                  isSelected ? 'employees-stat--selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                if (isNewThisMonthCard) {
                  return (
                    <button
                      key={card.key}
                      type="button"
                      className={cardClassName}
                      onClick={handleNewThisMonthToggle}
                      disabled={statsLoading || !stats?.monthKey}
                      aria-pressed={newThisMonthFilter}
                      aria-label={`${card.label}: ${typeof value === 'number' ? value : 'unknown'}. ${hint}. ${
                        newThisMonthFilter
                          ? 'Showing new employees in the list below. Click to show all employees.'
                          : 'Click to show new employees in the list below.'
                      }`}
                    >
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
                    </button>
                  );
                }

                return (
                  <article key={card.key} className={cardClassName}>
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
              onEnter={() =>
                loadEmployees({
                  query: search,
                  nextPage: 1,
                  nextStatus: statusFilter,
                  nextDepartment: departmentFilter,
                  nextNewThisMonth: newThisMonthFilter,
                })
              }
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
              <span className="label">Role</span>
              <SelectField
                value={roleFilter}
                onChange={handleRoleChange}
                options={roleOptions}
                aria-label="Role filter"
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

            {hasActiveFilters ? (
              <div className="filter-bar__field employees-toolbar__clear">
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            ) : null}
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

        {newThisMonthFilter ? (
          <p className="employees-filter-notice muted small" role="status">
            Showing employees {newThisMonthHint.toLowerCase()}.
          </p>
        ) : null}

        {loading ? (
          <TableSkeleton />
        ) : employees.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.users}
            title={
              newThisMonthFilter && !search && !statusFilter && !departmentFilter
                ? 'No new employees this month'
                : hasActiveFilters
                  ? 'No employees match these filters'
                  : 'No employees yet'
            }
            description={
              newThisMonthFilter && !search && !statusFilter && !departmentFilter
                ? `No employees were registered ${newThisMonthHint.toLowerCase()}.`
                : hasActiveFilters
                  ? 'Try adjusting search or filters, or clear them to browse the full directory.'
                  : 'Register an employee to build your directory and manage access from here.'
            }
            action={
              hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={clearFilters}>
                  {newThisMonthFilter && !search && !statusFilter && !departmentFilter
                    ? 'Show all employees'
                    : 'Clear filters'}
                </button>
              ) : !hasActiveFilters && canWriteUsers ? (
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
                    <th scope="col" className="employees-table__col-row-num">
                      #
                    </th>
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
                  {employees.map((employee, index) => {
                    const actionItems = getActionItems(employee);
                    const rowNumber = index + 1;
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
                        <td
                          data-label="#"
                          className="employees-table__row-num"
                          aria-label={`Row ${rowNumber}`}
                        >
                          {rowNumber}
                        </td>
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

            {pagination && employees.length > 0 ? (
              <p className="employees-scroll-hint muted small" role="status">
                Showing {employees.length} of {pagination.total} employees
                {loadingMore ? ' · Loading more…' : ''}
              </p>
            ) : null}
            <div ref={loadMoreRef} className="employees-scroll-sentinel" aria-hidden="true" />
          </>
        )}
      </section>

      {confirmDialog}
    </div>
  );
}
