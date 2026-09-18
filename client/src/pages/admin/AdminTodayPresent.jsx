import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '@shared/permissions.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import { useTableColumns } from '../../hooks/useTableColumns.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { mergeAppendUnique } from '../../utils/listMerge.js';
import ColumnEditorPanel from '../../components/ColumnEditorPanel.jsx';
import StickyHScrollBar from '../../components/StickyHScrollBar.jsx';
import TodayPresentRoster from '../../components/TodayPresentRoster.jsx';

const TODAY_PRESENT_TABLE_KEY = 'attendanceToday';
const TODAY_PRESENT_PAGE_SIZE = 25;

// Keys must exist in the backend attendanceToday registry (validateColumns
// rejects unknown keys on save) — `name` renders as the Employee column.
const TODAY_PRESENT_COLUMNS = [
  { key: 'name', label: 'Employee', always: true },
  { key: 'department', label: 'Department' },
  { key: 'role', label: 'Role' },
  { key: 'status', label: 'Status' },
];

const TODAY_PRESENT_DEFAULT_COLUMNS = ['name', 'department', 'role', 'status'];
const EMPTY_SUMMARY = { present: 0, absent: 0, onLeave: 0, inactive: 0, total: 0 };

export default function AdminTodayPresent() {
  const { setMeta } = usePageMetaContext();
  const { hasPermission, user } = useAuth();
  // Department filter mirrors the Employee List (full-read only), except
  // team viewers with several managed departments get a dropdown limited
  // to their scoped departments; a single scoped department locks the
  // table (no dropdown). The role filter is available to every scoped
  // viewer, limited to the roles of the people under them. Server-side
  // team scope applies on top, so no filter can widen visibility.
  const canSeeFullRoster = hasPermission(PERMISSIONS.ATTENDANCE_READ_ALL);
  const canSeeTeamRoster =
    canSeeFullRoster || hasPermission(PERMISSIONS.ATTENDANCE_READ_TEAM);
  const managedDepartmentIds = useMemo(() => {
    const raw = user?.managedDepartmentIds;
    return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
  }, [user]);
  const [teamStatus, setTeamStatus] = useState([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const debouncedSearch = useDebouncedValue(query, 200);
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [departments, setDepartments] = useState([]);
  const [roles, setRoles] = useState([]);
  // Scope facets arrive with every response: the distinct
  // departments/roles across the viewer's whole scoped membership. Team
  // viewers build both dropdowns from these (never the directory lists).
  const [scopeFacets, setScopeFacets] = useState({ departments: [], roles: [] });
  // Scoped department options for team viewers: the UNION of assigned
  // managed departments (intersected with the directory for names) and
  // facet departments — a managed department with no people yet still
  // lists. Options can only narrow: the server enforces the same scope.
  // A single scoped department locks the table (no dropdown).
  const scopedDeptOptions = useMemo(() => {
    const byId = new Map();
    for (const dept of departments) {
      if (managedDepartmentIds.includes(String(dept.id))) {
        byId.set(String(dept.id), { id: dept.id, name: dept.name });
      }
    }
    const facets = Array.isArray(scopeFacets.departments) ? scopeFacets.departments : [];
    for (const dept of facets) {
      const key = String(dept?.id ?? '');
      if (key && !byId.has(key)) byId.set(key, { id: dept.id, name: dept.name });
    }
    return [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [departments, managedDepartmentIds, scopeFacets]);
  const showDepartmentFilter = canSeeFullRoster || (canSeeTeamRoster && scopedDeptOptions.length > 1);
  const departmentOptions = useMemo(() => {
    const list = canSeeFullRoster ? departments : scopedDeptOptions;
    return [
      { value: '', label: canSeeFullRoster ? 'All departments' : 'All managed departments' },
      ...list.map((dept) => ({ value: dept.id, label: dept.name })),
    ];
  }, [canSeeFullRoster, departments, scopedDeptOptions]);
  // The Admin role option is visible only to viewers who can administer
  // roles — team viewers never see it in any role dropdown.
  const canSeeAdminRole = user?.roleSlug === SYSTEM_ROLE_SLUGS.ADMIN
    || hasPermission(PERMISSIONS.ROLES_MANAGE);
  const withoutAdminRole = (role) => canSeeAdminRole || role.slug !== SYSTEM_ROLE_SLUGS.ADMIN;
  const scopedRoleOptions = useMemo(() => {
    const fromFacets = Array.isArray(scopeFacets.roles) ? scopeFacets.roles : [];
    return [
      { value: '', label: 'All roles' },
      ...fromFacets
        .filter(withoutAdminRole)
        .map((role) => ({ value: role.id, label: role.name })),
    ];
  }, [scopeFacets, canSeeAdminRole]);
  // Team viewers cannot list roles (ROLES_MANAGE/USERS_WRITE only), so
  // without scope roles the filter would be a dead select — hide it.
  const showRoleFilter = canSeeFullRoster || (canSeeTeamRoster && scopedRoleOptions.length > 1);
  const roleOptions = useMemo(() => (
    canSeeFullRoster
      ? [{ value: '', label: 'All roles' }, ...roles.filter(withoutAdminRole).map((role) => ({ value: role.id, label: role.name }))]
      : scopedRoleOptions
  ), [canSeeFullRoster, roles, scopedRoleOptions, canSeeAdminRole]);
  const loadMoreRef = useRef(null);
  const tableWrapRef = useRef(null);
  const requestKeyRef = useRef('');
  const skipDebouncedSearchRef = useRef(true);
  const {
    visibleColumns,
    columnsLoading,
    columnsError,
    editorOpen,
    openColumnEditor,
    cancelColumnEdit,
    isDraftColumnVisible,
    handleDraftColumnToggle,
    applyColumnPreferences,
  } = useTableColumns({
    tableKey: TODAY_PRESENT_TABLE_KEY,
    allColumns: TODAY_PRESENT_COLUMNS,
    defaultVisible: TODAY_PRESENT_DEFAULT_COLUMNS,
  });

  useEffect(() => {
    setMeta({
      title: 'Today Present',
      subtitle: 'Live attendance status for all team members',
    });
  }, [setMeta]);

  const load = useCallback(async ({
    search = '',
    nextPage = 1,
    append = false,
    nextDepartment = '',
    nextRole = '',
    // Quiet keystroke refreshes keep the current rows on screen and swap in
    // results when they land — no skeleton flash per keystroke (same as the
    // Employee List search bar).
    quiet = false,
  } = {}) => {
    const requestKey = `${search}|${nextPage}|${append}|${nextDepartment}|${nextRole}`;
    requestKeyRef.current = requestKey;
    if (append) {
      setLoadingMore(true);
    } else if (!quiet) {
      setLoading(true);
    }
    setError('');
    try {
      const params = { page: nextPage, limit: TODAY_PRESENT_PAGE_SIZE };
      if (search.trim()) params.search = search.trim();
      if (nextDepartment) params.departmentId = nextDepartment;
      if (nextRole) params.roleId = nextRole;
      const data = await adminApi.getTeamTodayStatus(params);
      if (requestKeyRef.current !== requestKey) return;
      setTeamStatus((current) => {
        const fresh = data.teamStatus ?? [];
        if (!append) return fresh;
        // Dedupe by userId: newly registered members can shift offsets
        // between page fetches, returning overlapping rows.
        return mergeAppendUnique(current, fresh, (item) => item?.userId);
      });
      setSummary(data.summary ?? EMPTY_SUMMARY);
      setPagination(data.pagination ?? null);
      setPage(data.pagination?.page ?? nextPage);
      setScopeFacets(data.scopeFacets ?? { departments: [], roles: [] });
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setError(getErrorMessage(err));
      if (!append) {
        setTeamStatus([]);
        setSummary(EMPTY_SUMMARY);
        setPagination(null);
        setScopeFacets({ departments: [], roles: [] });
      }
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    load({ search: '', nextPage: 1 });
  }, [load]);

  // Refs mirror the Employee List pattern: the debounced keystroke effect
  // must not refire for dropdown changes (those load directly below).
  const departmentFilterRef = useRef(departmentFilter);
  departmentFilterRef.current = departmentFilter;
  const roleFilterRef = useRef(roleFilter);
  roleFilterRef.current = roleFilter;

  useEffect(() => {
    if (skipDebouncedSearchRef.current) {
      skipDebouncedSearchRef.current = false;
      return;
    }
    load({
      search: debouncedSearch,
      nextPage: 1,
      nextDepartment: departmentFilterRef.current,
      nextRole: roleFilterRef.current,
      quiet: true,
    });
  }, [debouncedSearch, load]);

  function handleDepartmentChange(value) {
    setDepartmentFilter(value);
    load({ search: query, nextPage: 1, nextDepartment: value, nextRole: roleFilter });
  }

  function handleRoleChange(value) {
    setRoleFilter(value);
    load({ search: query, nextPage: 1, nextDepartment: departmentFilter, nextRole: value });
  }

  useEffect(() => {
    // Department/role option lists mirror the Employee List sources;
    // fail silent so scoped viewers without list rights still get the table.
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch(() => setDepartments([]));
    adminApi
      .listRoles()
      .then((data) => setRoles(data.roles ?? []))
      .catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || loading || loadingMore) return;
        if (!pagination || page >= pagination.totalPages) return;
        load({
          search: debouncedSearch,
          nextPage: page + 1,
          append: true,
          nextDepartment: departmentFilterRef.current,
          nextRole: roleFilterRef.current,
        });
      },
      { rootMargin: '120px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [debouncedSearch, load, loading, loadingMore, page, pagination]);

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
        <div className="today-present-summary__card today-present-summary__card--inactive">
          <span className="today-present-summary__value">{summary.inactive ?? 0}</span>
          <span className="today-present-summary__label">Inactive</span>
        </div>
        <div className="today-present-summary__card">
          <span className="today-present-summary__value">{summary.total}</span>
          <span className="today-present-summary__label">Total</span>
        </div>
      </section>

      <section className="card card--table" aria-label="Team present status">
        <div className="card__toolbar today-present-toolbar" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <h2 className="card__title">Team Attendance Today</h2>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}
        {columnsError ? <div className="alert alert--error">{columnsError}</div> : null}

        <TodayPresentRoster
          rows={teamStatus}
          loading={loading}
          search={query}
          onSearchChange={setQuery}
          visibleColumns={visibleColumns}
          tableWrapRef={tableWrapRef}
          hasActiveSearch={Boolean(query.trim())}
          onDepartmentChange={handleDepartmentChange}
          departmentValue={departmentFilter}
          showDepartmentFilter={showDepartmentFilter}
          departmentOptions={departmentOptions}
          onRoleChange={showRoleFilter ? handleRoleChange : null}
          roleValue={roleFilter}
          roleOptions={roleOptions}
          toolbarActions={(
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={openColumnEditor}
            >
              Edit columns
            </button>
          )}
          footer={(
            <>
              <StickyHScrollBar targetRef={tableWrapRef} syncKey={teamStatus.length} />
              {pagination && teamStatus.length > 0 ? (
                <p className="employees-scroll-hint muted small" role="status">
                  Showing {teamStatus.length} of {pagination.total} team members
                  {loadingMore ? ' · Loading more…' : ''}
                </p>
              ) : null}
            </>
          )}
        />
        <div ref={loadMoreRef} className="employees-scroll-sentinel" aria-hidden="true" />
      </section>

      <ColumnEditorPanel
        open={editorOpen}
        columns={TODAY_PRESENT_COLUMNS}
        isColumnVisible={isDraftColumnVisible}
        onToggle={handleDraftColumnToggle}
        loading={columnsLoading}
        onClose={applyColumnPreferences}
        onCancel={cancelColumnEdit}
      />
    </div>
  );
}
