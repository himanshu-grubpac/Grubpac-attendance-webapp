import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import { formatInrInteger } from '@shared/utils/formatInr.js';
import { adminApi, getErrorMessage, preferencesApi } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { IST_TIMEZONE } from '../../utils/datetime.js';
import { mergeAppendUnique } from '../../utils/listMerge.js';
import { filterAllowedColumns } from '../../utils/columns.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import StickyHScrollBar from '../../components/StickyHScrollBar.jsx';
import { usePortalSync } from '../../hooks/usePortalSync.js';
import { broadcastEmployeeSync, PORTAL_TOPICS } from '../../utils/portalSync.js';

const EMPLOYEE_PAGE_SIZE = 10;

const EMPLOYEE_TABLE_KEY = 'employeeList';

const ALL_COLUMNS = [
  { key: 'name', label: 'Name', always: true },
  { key: 'email', label: 'Email' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'department', label: 'Department' },
  { key: 'designation', label: 'Designation' },
  { key: 'role', label: 'Role' },
  { key: 'joiningDate', label: 'Joining date' },
  { key: 'dateOfBirth', label: 'Date of birth' },
  { key: 'endingDate', label: 'Ending date' },
  { key: 'salary', label: 'Salary' },
  { key: 'reportingManager', label: 'Reporting manager' },
  { key: 'managerDepartments', label: 'Manager dept (Team scope)' },
  { key: 'status', label: 'Status' },
  { key: 'lastLogin', label: 'Last login' },
];

const DEFAULT_VISIBLE_COLUMNS = ['name', 'email', 'mobile', 'department', 'status', 'lastLogin'];

const ALL_COLUMN_KEYS = new Set(ALL_COLUMNS.map((column) => column.key));

function normalizeVisibleColumns(keys) {
  if (!Array.isArray(keys)) return DEFAULT_VISIBLE_COLUMNS;
  const filtered = keys.filter((key) => ALL_COLUMN_KEYS.has(key));
  if (!filtered.includes('name')) filtered.unshift('name');
  return filtered.length > 0 ? filtered : DEFAULT_VISIBLE_COLUMNS;
}

function columnsFromPreference(preferenceColumns) {
  if (!Array.isArray(preferenceColumns) || preferenceColumns.length === 0) {
    return DEFAULT_VISIBLE_COLUMNS;
  }
  const sorted = [...preferenceColumns].sort(
    (left, right) => (left.order ?? 0) - (right.order ?? 0),
  );
  return normalizeVisibleColumns(sorted.map((column) => column.key));
}

function visibleColumnsToPayload(visibleKeys) {
  const normalized = normalizeVisibleColumns(visibleKeys);
  return normalized.map((key, order) => ({
    key,
    order,
    width: null,
    pinned: null,
  }));
}

// Filter memory across the details round-trip (per-tab session storage).
const FILTER_STORAGE_KEY = 'grubpac.adminUsers.filters.v1';

function readStoredFilters() {
  try {
    const raw = sessionStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const cleaned = {};
    if (typeof parsed.search === 'string') cleaned.search = parsed.search;
    if (typeof parsed.statusFilter === 'string') cleaned.statusFilter = parsed.statusFilter;
    if (typeof parsed.departmentFilter === 'string') cleaned.departmentFilter = parsed.departmentFilter;
    if (typeof parsed.roleFilter === 'string') cleaned.roleFilter = parsed.roleFilter;
    if (typeof parsed.newThisMonthFilter === 'boolean') {
      cleaned.newThisMonthFilter = parsed.newThisMonthFilter;
    }
    return cleaned;
  } catch {
    // Storage unavailable (private mode) — filters just won't persist.
    return {};
  }
}

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

const STAT_CARDS = [
  {
    key: 'total',
    label: 'TOTAL EMPLOYEES',
    icon: '👤',
    hint: 'Registered across all team',
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
  // Registration-based (createdAt), matching the stat + list predicate —
  // deliberately "registered", not "joined": bulk-imported employees carry
  // historical joining dates but were registered this month.
  if (!monthKey) return 'Registered since month start';
  const [year, month] = monthKey.split('-').map(Number);
  const monthAbbr = new Intl.DateTimeFormat('en-IN', { month: 'short' }).format(
    new Date(year, month - 1, 1),
  );
  return `Registered since ${monthAbbr} 1st`;
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

function shortDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function salaryLabel(value) {
  if (value == null) return '—';
  const formatted = formatInrInteger(value);
  return formatted ? `₹${formatted}` : '—';
}

function managerDepartmentsLabel(employee, managerDeptMap) {
  const depts = managerDeptMap?.get(employee.reportingManagerId);
  if (!Array.isArray(depts) || depts.length === 0) return '—';
  return depts.map((d) => d.name || d.code || '—').join(', ');
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
  const canReadAllAttendance = hasPermission(PERMISSIONS.ATTENDANCE_READ_ALL);
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { showSuccess } = useToast();

  const [employees, setEmployees] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [stats, setStats] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [roles, setRoles] = useState([]);
  const [managers, setManagers] = useState([]);
  const [storedFilters] = useState(readStoredFilters);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(storedFilters.search ?? '');
  const [statusFilter, setStatusFilter] = useState(storedFilters.statusFilter ?? '');
  const [departmentFilter, setDepartmentFilter] = useState(storedFilters.departmentFilter ?? '');
  const [roleFilter, setRoleFilter] = useState(storedFilters.roleFilter ?? '');
  const [newThisMonthFilter, setNewThisMonthFilter] = useState(
    storedFilters.newThisMonthFilter ?? false,
  );
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_VISIBLE_COLUMNS);
  // RBAC-filtered column keys for the editor inventory (null = not loaded yet).
  const [allowedColumnKeys, setAllowedColumnKeys] = useState(null);
  const editorColumns = useMemo(
    () => filterAllowedColumns(ALL_COLUMNS, allowedColumnKeys),
    [allowedColumnKeys],
  );
  const [columnsLoading, setColumnsLoading] = useState(true);
  const [columnsError, setColumnsError] = useState('');
  const [showColumnEditor, setShowColumnEditor] = useState(false);
  // Draft edited inside the panel; only applied to the table on Done.
  const [draftColumns, setDraftColumns] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRef = useRef(null);
  const tableWrapRef = useRef(null);
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

  const managerDeptMap = useMemo(() => {
    const map = new Map();
    for (const mgr of managers) {
      map.set(mgr.id, mgr.managedDepartments ?? []);
    }
    return map;
  }, [managers]);

  const loadColumnPreferences = useCallback(async () => {
    setColumnsLoading(true);
    setColumnsError('');
    try {
      // RBAC-filtered toggle inventory (e.g. hides Salary without salary.read).
      // Fail-open: on error the full list stays visible and the server
      // still enforces per-column permission on save (403 + rollback).
      const allowed = await preferencesApi
        .getAvailableColumns(EMPLOYEE_TABLE_KEY)
        .catch(() => null);
      setAllowedColumnKeys(Array.isArray(allowed) ? allowed : null);
      const response = await preferencesApi.getTablePreference(EMPLOYEE_TABLE_KEY);
      // First visit (no saved preference) shows the compact UI default, not the
      // full server column registry.
      if (response?.data?.saved === false) {
        setVisibleColumns(DEFAULT_VISIBLE_COLUMNS);
      } else {
        setVisibleColumns(columnsFromPreference(response?.data?.columns));
      }
    } catch (err) {
      setColumnsError(getErrorMessage(err));
      setVisibleColumns(DEFAULT_VISIBLE_COLUMNS);
    } finally {
      setColumnsLoading(false);
    }
  }, []);

  const saveColumnPreferences = useCallback(async (nextVisibleColumns) => {
    setColumnsError('');
    try {
      await preferencesApi.updateTablePreference(EMPLOYEE_TABLE_KEY, {
        columns: visibleColumnsToPayload(nextVisibleColumns),
      });
    } catch (err) {
      setColumnsError(getErrorMessage(err));
      throw err;
    }
  }, []);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError('');
    try {
      const data = await adminApi.getEmployeeStats();
      setStats(data.stats ?? null);
      return data.stats ?? null;
    } catch (err) {
      setStats(null);
      setStatsError(getErrorMessage(err));
      return null;
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
      setEmployees((current) => {
        const fresh = data.employees ?? [];
        if (!append) return fresh;
        // Dedupe by id: concurrent writes (register/deactivate) can shift
        // offsets between page fetches, returning overlapping rows.
        return mergeAppendUnique(current, fresh);
      });
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
    loadColumnPreferences();
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch(() => {
        // Department filter remains optional.
      });
    adminApi
      .listRoles()
      .then((data) => setRoles(data.roles ?? []))
      .catch(() => { });
    adminApi
      .listManagers()
      .then((data) => setManagers(data.managers ?? []))
      .catch(() => { });
    // Stats first: the persisted month filter needs monthKey, which only
    // the stats response provides. Loading employees before it resolves
    // would silently drop the month predicate.
    (async () => {
      const monthStats = await loadStats();
      loadEmployees({
        query: search,
        nextPage: 1,
        nextStatus: statusFilter,
        nextDepartment: departmentFilter,
        nextRole: roleFilter,
        nextNewThisMonth: newThisMonthFilter,
        monthKey: monthStats?.monthKey ?? null,
      });
    })();
    // Intentionally runs once: restores the persisted filter set (if any).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadColumnPreferences, loadEmployees, loadStats]);

  const syncListReload = useCallback(() => {
    void loadStats();
    loadEmployees({
      query: search,
      nextPage: page,
      nextStatus: statusFilter,
      nextDepartment: departmentFilter,
      nextRole: roleFilter,
      nextNewThisMonth: newThisMonthFilter,
      monthKey: statsRef.current?.monthKey ?? null,
    });
  }, [
    departmentFilter,
    loadEmployees,
    loadStats,
    newThisMonthFilter,
    page,
    roleFilter,
    search,
    statusFilter,
  ]);

  usePortalSync(syncListReload, {
    topics: [PORTAL_TOPICS.EMPLOYEE, PORTAL_TOPICS.DEPARTMENT],
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(
        FILTER_STORAGE_KEY,
        JSON.stringify({
          search,
          statusFilter,
          departmentFilter,
          roleFilter,
          newThisMonthFilter,
        }),
      );
    } catch {
      // Storage unavailable — filters just won't persist.
    }
  }, [search, statusFilter, departmentFilter, roleFilter, newThisMonthFilter]);

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


  function handleStatCardClick(key) {
    switch (key) {
      case 'total':
        // Clear all employee filters (state AND request): leaving stale
        // status/department/role/search state behind desyncs the dropdowns
        // from the rows, and the infinite-scroll observer would then append
        // with the old status and clobber pagination ("Showing 10 of 5").
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
        break;

      case 'active':
        // active employees
        setNewThisMonthFilter(false);
        handleStatusChange('true');
        break;

      case 'inactive':
        setNewThisMonthFilter(false);
        handleStatusChange('false');
        break;

      case 'newThisMonth':
        handleNewThisMonthToggle();
        break;

      default:
        break;
    }
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
        broadcastEmployeeSync({ userId: employee.id });
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
        showSuccess(
          nextActive
            ? `${employee.name} activated. They can sign in again.`
            : `${employee.name} deactivated. They can no longer sign in.`,
        );
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

  function isColumnVisible(key) {
    return visibleColumns.includes(key);
  }

  function isDraftColumnVisible(key) {
    return (draftColumns ?? visibleColumns).includes(key);
  }

  function openColumnEditor() {
    setDraftColumns([...visibleColumns]);
    setShowColumnEditor(true);
  }

  function cancelColumnEdit() {
    setDraftColumns(null);
    setShowColumnEditor(false);
  }

  function handleDraftColumnToggle(key) {
    const column = ALL_COLUMNS.find((c) => c.key === key);
    if (column?.always) return;
    setDraftColumns((prev) => {
      const base = prev ?? visibleColumns;
      const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
      return normalizeVisibleColumns(next);
    });
  }

  function applyColumnPreferences() {
    const normalized = normalizeVisibleColumns(draftColumns ?? visibleColumns);
    const previous = visibleColumns;
    // Optimistic apply + close; rollback only if the server persist fails.
    setVisibleColumns(normalized);
    setDraftColumns(null);
    setShowColumnEditor(false);
    saveColumnPreferences(normalized).catch(() => {
      setVisibleColumns(previous);
    });
  }

  const hasActiveFilters = Boolean(
    search || statusFilter || departmentFilter || roleFilter || newThisMonthFilter,
  );
  const newThisMonthHint = formatJoinedSinceHint(stats?.monthKey);
  // Filters combine (AND): with e.g. Status=Inactive also active, the table
  // is the intersection — spell that out so the stat count (116) vs the
  // table count (4) never looks like a data bug again.
  const hasOtherFilters = Boolean(search || statusFilter || departmentFilter || roleFilter);
  const pageSize = pagination?.limit ?? EMPLOYEE_PAGE_SIZE;

  return (
    <div className="page page--employees">
      <section className="employees-stats" aria-label="Workforce summary">
        {statsError ? <div className="alert alert--error">{statsError}</div> : null}
        <div className="employees-stats__grid">
          {statsLoading
            ? STAT_CARDS.map((card) => (
              <StatCardSkeleton key={card.key} />
            ))
            : STAT_CARDS.map((card) => {
              const hint =
                typeof card.hint === 'function'
                  ? card.hint(stats)
                  : card.hint;

              const value = stats?.[card.statKey];

              const isSelected =
                card.key === 'newThisMonth' && newThisMonthFilter;

              const cardClassName = [
                'employees-stat card employees-stat--clickable surface--clickable',
                isSelected ? 'employees-stat--selected' : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <button
                  key={card.key}
                  type="button"
                  className={cardClassName}
                  onClick={() => handleStatCardClick(card.key)}
                  aria-pressed={isSelected}
                >
                  <div className="employees-stat__head">
                    <span className="employees-stat__label">
                      {card.label}
                    </span>

                    <span
                      className="employees-stat__icon"
                      aria-hidden="true"
                    >
                      {card.icon}
                    </span>
                  </div>

                  <strong className="employees-stat__value">
                    {typeof value === 'number' ? value : '—'}
                  </strong>

                  <p className="employees-stat__hint muted small">
                    {hint}
                  </p>
                </button>
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

            {canReadAllAttendance && (
              <label className="field-inline filter-bar__field employees-toolbar__field">
                <span className="label">Department</span>
                <SelectField
                  value={departmentFilter}
                  onChange={handleDepartmentChange}
                  options={departmentOptions}
                  aria-label="Department filter"
                />
              </label>
            )}

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

            <div className="employees-toolbar__editcol">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={openColumnEditor}
              >
                Edit columns
              </button>
              {canWriteUsers ? (
                <Link to="/admin/users/register" className="btn btn-primary btn-sm">
                  + Add Employee
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        {listError ? <div className="alert alert--error">{listError}</div> : null}
        {columnsError ? <div className="alert alert--error">{columnsError}</div> : null}

        {newThisMonthFilter ? (
          <p className="employees-filter-notice muted small" role="status">
            {hasOtherFilters && pagination && stats?.newThisMonth != null
              ? `Showing ${pagination.total} of ${stats.newThisMonth} employees ${newThisMonthHint.toLowerCase()} — other filters applied.`
              : `Showing employees ${newThisMonthHint.toLowerCase()}.`}
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
            <div ref={tableWrapRef} className="table-wrap table-wrap--responsive employees-table-wrap">
              <table className="table data-table employees-table">
                <thead>
                  <tr>
                    <th scope="col" className="employees-table__col-row-num">
                      #
                    </th>
                    {isColumnVisible('name') && <th>Name</th>}
                    {isColumnVisible('email') && <th>Email</th>}
                    {isColumnVisible('mobile') && <th>Mobile</th>}
                    {isColumnVisible('department') && <th>Department</th>}
                    {isColumnVisible('designation') && <th>Designation</th>}
                    {isColumnVisible('role') && <th>Role</th>}
                    {isColumnVisible('joiningDate') && <th>Joining date</th>}
                    {isColumnVisible('dateOfBirth') && <th>Date of birth</th>}
                    {isColumnVisible('endingDate') && <th>Ending date</th>}
                    {isColumnVisible('salary') && <th>Salary</th>}
                    {isColumnVisible('reportingManager') && <th>Reporting manager</th>}
                    {isColumnVisible('managerDepartments') && <th>Manager dept</th>}
                    {isColumnVisible('status') && <th>Status</th>}
                    {isColumnVisible('lastLogin') && <th>Last login</th>}
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
                        {isColumnVisible('name') && (
                          <td data-label="Name" className="employees-table__name">
                            <Link
                              to={`/admin/users/${employee.id}`}
                              className="table-link employees-table__name-link"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {employee.name}
                            </Link>
                          </td>
                        )}
                        {isColumnVisible('email') && (
                          <td
                            data-label="Email"
                            className="cell-ellipsis"
                            title={employee.email || undefined}
                          >
                            {employee.email || '—'}
                          </td>
                        )}
                        {isColumnVisible('mobile') && (
                          <td data-label="Mobile">{employee.mobile || '—'}</td>
                        )}
                        {isColumnVisible('department') && (
                          <td data-label="Department">{departmentLabel(employee)}</td>
                        )}
                        {isColumnVisible('designation') && (
                          <td data-label="Designation">{employee.designation || '—'}</td>
                        )}
                        {isColumnVisible('role') && (
                          <td data-label="Role">{employee.roleName || '—'}</td>
                        )}
                        {isColumnVisible('joiningDate') && (
                          <td data-label="Joining date">{shortDate(employee.joiningDate)}</td>
                        )}
                        {isColumnVisible('dateOfBirth') && (
                          <td data-label="Date of birth">{shortDate(employee.dateOfBirth)}</td>
                        )}
                        {isColumnVisible('endingDate') && (
                          <td data-label="Ending date">{shortDate(employee.endingDate)}</td>
                        )}
                        {isColumnVisible('salary') && (
                          <td data-label="Salary">{salaryLabel(employee.monthlySalary)}</td>
                        )}
                        {isColumnVisible('reportingManager') && (
                          <td data-label="Reporting manager">{employee.reportingManagerName || '—'}</td>
                        )}
                        {isColumnVisible('managerDepartments') && (
                          <td data-label="Manager dept">{managerDepartmentsLabel(employee, managerDeptMap)}</td>
                        )}
                        {isColumnVisible('status') && (
                          <td data-label="Status">
                            <StatusBadge active={employee.isActive} />
                          </td>
                        )}
                        {isColumnVisible('lastLogin') && (
                          <td data-label="Last login" className="cell-datetime">
                            {lastLoginLabel(employee.lastLoginAt)}
                          </td>
                        )}
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
            <StickyHScrollBar targetRef={tableWrapRef} syncKey={employees.length} />

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

      {showColumnEditor ? (
        <>
          <div
            className="slide-panel-backdrop"
            onClick={cancelColumnEdit}
            onKeyDown={(e) => e.key === 'Escape' && cancelColumnEdit()}
          />
          <div
            className="slide-panel"
            role="dialog"
            aria-label="Edit columns"
            style={{ width: '20rem' }}
            onKeyDown={(e) => e.key === 'Escape' && cancelColumnEdit()}
          >
            <div className="slide-panel__header">
              <div className="slide-panel__titles">
                <h2 className="slide-panel__title">Edit columns</h2>
                <p className="slide-panel__subtitle">
                  Choose which columns to display in the table.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={cancelColumnEdit}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="slide-panel__body">
              {columnsLoading ? (
                <p className="muted small" role="status">
                  Loading column preferences…
                </p>
              ) : (
                <ul className="column-editor-list">
                  {editorColumns.map((col) => (
                    <li key={col.key} className="column-editor-list__item">
                      <label
                        className={`column-editor-list__label${col.always ? ' column-editor-list__label--locked' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="column-editor-list__checkbox"
                          checked={isDraftColumnVisible(col.key)}
                          onChange={() => handleDraftColumnToggle(col.key)}
                          disabled={col.always || columnsLoading}
                        />
                        <span className="column-editor-list__text">{col.label}</span>
                        {col.always ? (
                          <span className="column-editor-list__badge">Always shown</span>
                        ) : null}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="slide-panel__footer">
              <div className="slide-panel__actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={applyColumnPreferences}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {confirmDialog}
    </div>
  );
}
