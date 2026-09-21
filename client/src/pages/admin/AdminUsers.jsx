import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '@shared/permissions.js';
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
import DateField from '../../components/DateField.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import StickyHScrollBar from '../../components/StickyHScrollBar.jsx';
import { usePortalSync } from '../../hooks/usePortalSync.js';
import { broadcastEmployeeSync, PORTAL_TOPICS } from '../../utils/portalSync.js';

const EMPLOYEE_PAGE_SIZE = 10;

const EMPLOYEE_TABLE_KEY = 'employeeList';

const ALL_COLUMNS = [
  { key: 'name', label: 'Name', always: true },
  { key: 'employeeCode', label: 'Emp code' },
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
  { key: 'updatedAt', label: 'Updated at' },
];

const DEFAULT_VISIBLE_COLUMNS = ['name', 'employeeCode', 'email', 'mobile', 'department', 'status', 'updatedAt', 'lastLogin'];

const ALL_COLUMN_KEYS = new Set(ALL_COLUMNS.map((column) => column.key));

function isSystemAdminRow(employee) {
  return employee?.roleSlug === SYSTEM_ROLE_SLUGS.ADMIN;
}

const SYSTEM_ADMIN_LOCKED_TITLE = 'System admin — managed elsewhere';

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
    if (typeof parsed.joiningFrom === 'string') cleaned.joiningFrom = parsed.joiningFrom;
    if (typeof parsed.joiningTo === 'string') cleaned.joiningTo = parsed.joiningTo;
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
  const { hasPermission, hasAnyPermission, user } = useAuth();
  const canWriteUsers = hasPermission(PERMISSIONS.USERS_WRITE);
  const canFilterByDepartment = hasAnyPermission([
    PERMISSIONS.EMPLOYEES_STATS_R,
    PERMISSIONS.EMPLOYEES_RECORD_R,
  ]);
  const canAddTeamEmployee = user?.roleSlug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER;
  const canAddEmployee = canWriteUsers || canAddTeamEmployee;
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
  const [searchParams] = useSearchParams();
  // Dashboard deep-links (?status= / ?role=) win over the remembered filters
  // so opening the list from the dashboard always lands on the linked view.
  const queryStatus = searchParams.get('status');
  const initialStatus =
    queryStatus === 'true' || queryStatus === 'false' || queryStatus === ''
      ? queryStatus
      : null;
  const queryRole = searchParams.get('role');
  const initialRole = queryRole && /^[a-f\d]{24}$/i.test(queryRole) ? queryRole : null;
  const [search, setSearch] = useState(storedFilters.search ?? '');
  const [statusFilter, setStatusFilter] = useState(initialStatus ?? storedFilters.statusFilter ?? 'true');
  const [joiningFrom, setJoiningFrom] = useState(storedFilters.joiningFrom ?? '');
  const [joiningTo, setJoiningTo] = useState(storedFilters.joiningTo ?? '');
  const [departmentFilter, setDepartmentFilter] = useState(storedFilters.departmentFilter ?? '');
  const [roleFilter, setRoleFilter] = useState(initialRole ?? storedFilters.roleFilter ?? '');
  const [newThisMonthFilter, setNewThisMonthFilter] = useState(
    storedFilters.newThisMonthFilter ?? false,
  );
  // Which stat card the user last clicked (null = derive from the filter set
  // below). Needed because Total and Active show the SAME Active-filtered
  // list — a pure predicate can't tell which card to highlight.
  const [selectedStat, setSelectedStat] = useState(null);
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
  const debouncedSearch = useDebouncedValue(search, 200);
  const skipDebouncedSearchRef = useRef(true);
  // Programmatic loads (stat cards / Clear / Enter) already fetch directly:
  // suppress only that exact debounced value once so it doesn't double-fetch.
  // Never arm the mount-skip flag here — when search is already '' no
  // debounced change follows, the flag stays armed and swallows the user's
  // next keystrokes (search looks "not working").
  const suppressDebouncedQueryRef = useRef(null);
  const requestKeyRef = useRef('');
  const statusFilterRef = useRef(statusFilter);
  const departmentFilterRef = useRef(departmentFilter);
  const newThisMonthFilterRef = useRef(newThisMonthFilter);
  const statsRef = useRef(stats);
  statusFilterRef.current = statusFilter;
  departmentFilterRef.current = departmentFilter;
  newThisMonthFilterRef.current = newThisMonthFilter;
  const roleFilterRef = useRef(roleFilter);
  roleFilterRef.current = roleFilter;
  const joiningFromRef = useRef(joiningFrom);
  joiningFromRef.current = joiningFrom;
  const joiningToRef = useRef(joiningTo);
  joiningToRef.current = joiningTo;
  statsRef.current = stats;
  const [listError, setListError] = useState('');
  const [statsError, setStatsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);

  // The Admin option is visible only to viewers who can administer roles —
  // everyone else gets the assignable/filterable set (register + detail
  // pages hide it unconditionally).
  const canSeeAdminRole = user?.roleSlug === SYSTEM_ROLE_SLUGS.ADMIN
    || hasPermission(PERMISSIONS.ROLES_MANAGE);
  const roleOptions = useMemo(
    () => [
      { value: '', label: 'All roles' },
      ...roles
        .filter((role) => canSeeAdminRole || role.slug !== SYSTEM_ROLE_SLUGS.ADMIN)
        .map((role) => ({ value: role.id, label: role.name })),
    ],
    [roles, canSeeAdminRole],
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
    nextJoiningFrom = '',
    nextJoiningTo = '',
    append = false,
    // Quiet keystroke refreshes keep the current rows on screen and swap in
    // results when they land — no skeleton flash per keystroke.
    quiet = false,
  } = {}) => {
    const effectiveMonthKey = monthKey ?? statsRef.current?.monthKey;
    const createdAfter =
      nextNewThisMonth && effectiveMonthKey ? `${effectiveMonthKey}-01` : undefined;
    const requestKey = `${query ?? ''}|${nextPage}|${nextStatus}|${nextDepartment}|${nextRole}|${createdAfter ?? ''}|${nextJoiningFrom}|${nextJoiningTo}|${append}`;
    requestKeyRef.current = requestKey;
    if (append) {
      setLoadingMore(true);
    } else if (!quiet) {
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
      if (nextJoiningFrom) params.joiningFrom = nextJoiningFrom;
      if (nextJoiningTo) params.joiningTo = nextJoiningTo;

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
      .catch((err) => {
        console.warn('Employee list: failed to load departments', getErrorMessage(err));
        setDepartments([]);
      });
    adminApi
      .listRoles({ includeSystem: true })
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
        nextJoiningFrom: joiningFrom,
        nextJoiningTo: joiningTo,
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
          joiningFrom,
          joiningTo,
        }),
      );
    } catch {
      // Storage unavailable — filters just won't persist.
    }
  }, [search, statusFilter, departmentFilter, roleFilter, newThisMonthFilter, joiningFrom, joiningTo]);

  useEffect(() => {
    if (skipDebouncedSearchRef.current) {
      skipDebouncedSearchRef.current = false;
      return;
    }
    // Single-use: drop the debounced echo of a query we already loaded
    // directly (card click / Clear / Enter). Any other value is a real
    // keystroke and must still search.
    const suppressed = suppressDebouncedQueryRef.current;
    suppressDebouncedQueryRef.current = null;
    if (suppressed !== null && debouncedSearch === suppressed) return;
    loadEmployees({
      query: debouncedSearch,
      nextPage: 1,
      nextStatus: statusFilterRef.current,
      nextDepartment: departmentFilterRef.current,
      nextRole: roleFilterRef.current,
      nextNewThisMonth: newThisMonthFilterRef.current,
      nextJoiningFrom: joiningFromRef.current,
      nextJoiningTo: joiningToRef.current,
      quiet: true,
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
          nextJoiningFrom: joiningFrom,
          nextJoiningTo: joiningTo,
          append: true,
        });
      },
      { rootMargin: '120px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [
    departmentFilter,
    joiningFrom,
    joiningTo,
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
    setStatusFilter('true');
    setDepartmentFilter('');
    setRoleFilter('');
    setNewThisMonthFilter(false);
    setJoiningFrom('');
    setJoiningTo('');
    suppressDebouncedQueryRef.current = '';
    loadEmployees({
      query: '',
      nextPage: 1,
      nextStatus: 'true',
      nextDepartment: '',
      nextRole: '',
      nextNewThisMonth: false,
      nextJoiningFrom: '',
      nextJoiningTo: '',
    });
    // Back to the default view → Active card lit (same as fresh load).
    setSelectedStat('active');
  }

  function handleRoleChange(value) {
    setRoleFilter(value);
    // Hand-tuned view: drop the card highlight, predicate decides below.
    setSelectedStat(null);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: statusFilter,
      nextDepartment: departmentFilter,
      nextRole: value,
      nextNewThisMonth: newThisMonthFilter,
      nextJoiningFrom: joiningFrom,
      nextJoiningTo: joiningTo,
    });
  }

  function handleStatusChange(value) {
    setStatusFilter(value);
    setSelectedStat(null);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: value,
      nextDepartment: departmentFilter,
      nextRole: roleFilter,
      nextNewThisMonth: newThisMonthFilter,
      nextJoiningFrom: joiningFrom,
      nextJoiningTo: joiningTo,
    });
  }

  function handleDepartmentChange(value) {
    setDepartmentFilter(value);
    setSelectedStat(null);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: statusFilter,
      nextDepartment: value,
      nextRole: roleFilter,
      nextNewThisMonth: newThisMonthFilter,
      nextJoiningFrom: joiningFrom,
      nextJoiningTo: joiningTo,
    });
  }

  function handleJoiningFromChange(value) {
    setJoiningFrom(value);
    setSelectedStat(null);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: statusFilter,
      nextDepartment: departmentFilter,
      nextRole: roleFilter,
      nextNewThisMonth: newThisMonthFilter,
      nextJoiningFrom: value,
      nextJoiningTo: joiningTo,
    });
  }

  function handleJoiningToChange(value) {
    setJoiningTo(value);
    setSelectedStat(null);
    loadEmployees({
      query: search,
      nextPage: 1,
      nextStatus: statusFilter,
      nextDepartment: departmentFilter,
      nextRole: roleFilter,
      nextNewThisMonth: newThisMonthFilter,
      nextJoiningFrom: joiningFrom,
      nextJoiningTo: value,
    });
  }

  function handleStatCardClick(key) {
    switch (key) {
      case 'total':
        // Total opens the default Active list but keeps the TOTAL card lit
        // (status stays Active — never All). Showing inactive rows here
        // would break the default-view contract.
        setSearch('');
        setStatusFilter('true');
        setDepartmentFilter('');
        setRoleFilter('');
        setNewThisMonthFilter(false);
        setJoiningFrom('');
        setJoiningTo('');
        setSelectedStat('total');
        suppressDebouncedQueryRef.current = '';
        loadEmployees({
          query: '',
          nextPage: 1,
          nextStatus: 'true',
          nextDepartment: '',
          nextRole: '',
          nextNewThisMonth: false,
          nextJoiningFrom: '',
          nextJoiningTo: '',
        });
        break;

      case 'active':
        // Active employees: own predicate only — stale search/department/
        // role/date/month state would otherwise intersect and hide rows.
        setSearch('');
        setStatusFilter('true');
        setDepartmentFilter('');
        setRoleFilter('');
        setNewThisMonthFilter(false);
        setJoiningFrom('');
        setJoiningTo('');
        setSelectedStat('active');
        suppressDebouncedQueryRef.current = '';
        loadEmployees({
          query: '',
          nextPage: 1,
          nextStatus: 'true',
          nextDepartment: '',
          nextRole: '',
          nextNewThisMonth: false,
          nextJoiningFrom: '',
          nextJoiningTo: '',
        });
        break;

      case 'inactive':
        // Inactive employees: own predicate only (same reset rationale).
        setSearch('');
        setStatusFilter('false');
        setDepartmentFilter('');
        setRoleFilter('');
        setNewThisMonthFilter(false);
        setJoiningFrom('');
        setJoiningTo('');
        setSelectedStat('inactive');
        suppressDebouncedQueryRef.current = '';
        loadEmployees({
          query: '',
          nextPage: 1,
          nextStatus: 'false',
          nextDepartment: '',
          nextRole: '',
          nextNewThisMonth: false,
          nextJoiningFrom: '',
          nextJoiningTo: '',
        });
        break;

      case 'newThisMonth':
        if (newThisMonthFilter) {
          // Toggle off → back to the default view.
          setSearch('');
          setStatusFilter('true');
          setDepartmentFilter('');
          setRoleFilter('');
          setNewThisMonthFilter(false);
          setJoiningFrom('');
          setJoiningTo('');
          setSelectedStat(null);
          suppressDebouncedQueryRef.current = '';
          loadEmployees({
            query: '',
            nextPage: 1,
            nextStatus: 'true',
            nextDepartment: '',
            nextRole: '',
            nextNewThisMonth: false,
            nextJoiningFrom: '',
            nextJoiningTo: '',
          });
        } else {
          // New-this-month lists exactly what the card counts (all statuses
          // registered since the 1st): forcing Active here would hide inactive
          // new joiners and desync the card count from the table total.
          // Users can still narrow via the Status dropdown afterwards.
          setSearch('');
          setStatusFilter('');
          setDepartmentFilter('');
          setRoleFilter('');
          setNewThisMonthFilter(true);
          setJoiningFrom('');
          setJoiningTo('');
          setSelectedStat('newThisMonth');
          suppressDebouncedQueryRef.current = '';
          loadEmployees({
            query: '',
            nextPage: 1,
            nextStatus: '',
            nextDepartment: '',
            nextRole: '',
            nextNewThisMonth: true,
            nextJoiningFrom: '',
            nextJoiningTo: '',
          });
        }
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
            nextRole: roleFilter,
            nextNewThisMonth: newThisMonthFilter,
            nextJoiningFrom: joiningFrom,
            nextJoiningTo: joiningTo,
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
    const isAdmin = employee.roleSlug === 'admin';
    // System admin rows are visible but locked: every one of these actions
    // is rejected server-side, so the menu explains instead of failing.
    if (isSystemAdminRow(employee)) {
      const locked = (item) => ({ ...item, disabled: true, title: SYSTEM_ADMIN_LOCKED_TITLE });
      return [
        locked({
          key: 'view',
          label: 'View details',
          onClick: () => {},
        }),
        ...(canWriteUsers
          ? [
              locked({
                key: 'employment',
                label: 'Edit employment details',
                onClick: () => {},
              }),
              locked({
                key: 'reset',
                label: 'Reset password',
                onClick: () => {},
              }),
              locked({
                key: 'toggle',
                label: employee.isActive ? 'Deactivate' : 'Activate',
                variant: employee.isActive ? 'danger' : 'default',
                onClick: () => {},
              }),
            ]
          : []),
      ];
    }

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
      ...(isAdmin ? [] : [{
        key: 'toggle',
        label: employee.isActive ? 'Deactivate' : 'Activate',
        variant: employee.isActive ? 'danger' : 'default',
        onClick: () => toggleStatus(employee),
      }]),
    ];
  }

  function handleRowClick(employee, event) {
    if (event.target.closest('button, a, [role="menu"], .employees-table__manage')) return;
    if (isSystemAdminRow(employee)) return;
    goToEmployee(employee);
  }

  function handleRowKeyDown(employee, event) {
    if (event.target !== event.currentTarget) return;
    if (isSystemAdminRow(employee)) return;
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

  // Active is the default status: only a non-default status counts as filtering.
  const hasNonDefaultStatus = Boolean(statusFilter && statusFilter !== 'true');
  const hasActiveFilters = Boolean(
    search ||
      hasNonDefaultStatus ||
      departmentFilter ||
      roleFilter ||
      newThisMonthFilter ||
      joiningFrom ||
      joiningTo,
  );
  const newThisMonthHint = formatJoinedSinceHint(stats?.monthKey);
  // Filters combine (AND): with e.g. Status=Inactive also active, the table
  // is the intersection — spell that out so a stat count vs the table
  // count never looks like a data bug again.
  const hasOtherFilters = Boolean(
    search || hasNonDefaultStatus || departmentFilter || roleFilter || joiningFrom || joiningTo,
  );
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

              // Selected = the card the user last clicked. Falls back to the
              // filter-set predicate when the view was hand-tuned instead
              // (dropdowns/search/dates, or fresh load with restored filters).
              // Default landing is the Active view; Total shows that same
              // Active list but keeps TOTAL lit via the explicit override.
              const isAllView =
                !newThisMonthFilter &&
                statusFilter === '' &&
                !search &&
                !departmentFilter &&
                !roleFilter &&
                !joiningFrom &&
                !joiningTo;
              const predicateSelected =
                card.key === 'newThisMonth'
                  ? newThisMonthFilter
                  : card.key === 'active'
                    ? !newThisMonthFilter &&
                      statusFilter === 'true' &&
                      !search &&
                      !departmentFilter &&
                      !roleFilter &&
                      !joiningFrom &&
                      !joiningTo
                    : card.key === 'inactive'
                      ? !newThisMonthFilter &&
                        statusFilter === 'false' &&
                        !search &&
                        !departmentFilter &&
                        !roleFilter &&
                        !joiningFrom &&
                        !joiningTo
                      : card.key === 'total'
                        ? isAllView
                        : false;
              const isSelected = selectedStat
                ? card.key === selectedStat
                : predicateSelected;

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
            <div className="employees-toolbar__group employees-toolbar__group--filters">
              <SearchInput
                className="filter-bar__search employees-toolbar__search"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSelectedStat(null); }}
                placeholder="Search employee name, code…"
                ariaLabel="Search employees"
                onEnter={() => {
                  // Enter fetches immediately; suppress the matching debounced
                  // echo so it doesn't refetch the same query.
                  suppressDebouncedQueryRef.current = search;
                  loadEmployees({
                    query: search,
                    nextPage: 1,
                    nextStatus: statusFilter,
                    nextDepartment: departmentFilter,
                    nextRole: roleFilter,
                    nextNewThisMonth: newThisMonthFilter,
                    nextJoiningFrom: joiningFrom,
                    nextJoiningTo: joiningTo,
                  });
                }}
              />

              {canFilterByDepartment ? (
                <label className="field-inline filter-bar__field employees-toolbar__field">
                  <span className="label">Department</span>
                  <SelectField
                    value={departmentFilter}
                    onChange={handleDepartmentChange}
                    options={departmentOptions}
                    aria-label="Department filter"
                  />
                </label>
              ) : null}

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

              <label className="field-inline filter-bar__field employees-toolbar__field">
                <span className="label">Joined from</span>
                <DateField
                  value={joiningFrom}
                  onChange={handleJoiningFromChange}
                  aria-label="Filter by joining date from"
                />
              </label>

              <label className="field-inline filter-bar__field employees-toolbar__field">
                <span className="label">Joined to</span>
                <DateField
                  value={joiningTo}
                  onChange={handleJoiningToChange}
                  aria-label="Filter by joining date to"
                />
              </label>
            </div>

            <div className="employees-toolbar__group employees-toolbar__group--actions">
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
                {canAddEmployee ? (
                  <Link to="/admin/users/register" className="btn btn-primary btn-sm">
                    + Add Employee
                  </Link>
                ) : null}
              </div>
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
              newThisMonthFilter && !hasOtherFilters
                ? 'No new employees this month'
                : hasActiveFilters
                  ? 'No employees match these filters'
                  : 'No employees yet'
            }
            description={
              newThisMonthFilter && !hasOtherFilters
                ? `No employees were registered ${newThisMonthHint.toLowerCase()}.`
                : hasActiveFilters
                  ? 'Try adjusting search or filters, or clear them to browse the full directory.'
                  : 'Register an employee to build your directory and manage access from here.'
            }
            action={
              hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={clearFilters}>
                  {newThisMonthFilter && !hasOtherFilters
                    ? 'Show all employees'
                    : 'Clear filters'}
                </button>
              ) : !hasActiveFilters && canAddEmployee ? (
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
                        {isColumnVisible('employeeCode') && <th>Emp code</th>}
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
                    {isColumnVisible('updatedAt') && <th>Updated at</th>}
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
                            {isSystemAdminRow(employee) ? (
                              <span
                                className="employees-table__name-link"
                                title={SYSTEM_ADMIN_LOCKED_TITLE}
                              >
                                {employee.name}
                              </span>
                            ) : (
                              <Link
                                to={`/admin/users/${employee.id}`}
                                className="table-link employees-table__name-link"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {employee.name}
                              </Link>
                            )}
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
                        {isColumnVisible('employeeCode') && (
                          <td data-label="Emp code">{employee.employeeCode || '—'}</td>
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
                        {isColumnVisible('updatedAt') && (
                          <td data-label="Updated at" className="cell-datetime">
                            {lastLoginLabel(employee.updatedAt)}
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
