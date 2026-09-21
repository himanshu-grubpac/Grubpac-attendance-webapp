import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS, hasCompanyWideScope } from '@shared/permissions.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';
import TodayPresentRoster from '../../components/TodayPresentRoster.jsx';

const ROSTER_PREVIEW_SIZE = 10;

const KPI_CARDS = [
  {
    key: 'pendingLeave',
    label: 'View Leave Requests',
    icon: '✓',
    to: '/admin/leave/approvals',
    // Total comes from the same pending-counts endpoint as the hint below,
    // so the number always equals its own breakdown (leave + WFH + comp off
    // + awaiting assessment). The reports summary counts LeaveRequests only
    // (no comp-off, no year filter) and is just the fallback.
    getValue: (summary, counts) =>
      typeof counts?.total === 'number' ? counts.total : summary.pendingLeaveRequests,
    getHint: (_, counts) => {
      if (!counts) return 'Awaiting your decision';
      const parts = [];
      if (counts.leave) parts.push(`${counts.leave} leave`);
      if (counts.wfh) parts.push(`${counts.wfh} WFH`);
      const compOff = (counts.compOff ?? 0) + (counts.compOffAssessment ?? 0);
      if (compOff) parts.push(`${compOff} comp off`);
      return parts.length > 0 ? parts.join(' · ') : 'Awaiting your decision';
    },
  },
  {
    key: 'openTickets',
    label: 'Open Tickets',
    icon: '?',
    to: '/admin/help/tickets',
    getValue: (summary) => summary.openHelpTickets,
  },
  {
    key: 'presentAbsent',
    label: 'Present & Absent (Today)',
    icon: '◷',
    to: '/admin/attendance',
    getValue: (summary) => {
      const { presentToday, absentToday } = summary;
      if (typeof presentToday !== 'number' || typeof absentToday !== 'number') return '—';
      return `${presentToday} / ${absentToday}`;
    },
    getHint: (summary) => {
      const { presentToday, absentToday } = summary;
      if (typeof presentToday !== 'number' || typeof absentToday !== 'number') return null;
      return 'Present / Absent';
    },
  },
  {
    key: 'activeEmployees',
    label: 'Total Active Employees',
    icon: '☰',
    // Deep-link forces the Active status so the list always lands on Active
    // from the dashboard, regardless of remembered filters.
    to: '/admin/users?status=true',
    getValue: (summary) => summary.activeEmployees,
  },
];

function DashboardCardSkeleton() {
  return (
    <div className="admin-home__card admin-home__card--skeleton card" aria-hidden="true">
      <div className="admin-home__card-head">
        <div className="skeleton admin-home__skeleton-icon" />
        <div className="skeleton admin-home__skeleton-label" />
      </div>
      <div className="skeleton admin-home__skeleton-value" />
    </div>
  );
}

export default function AdminDashboard() {
  const { hasPermission, permissions, user } = useAuth();
  const [reports, setReports] = useState(null);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reportsError, setReportsError] = useState('');

  // Today-present roster: every role with an admin view (READ_ALL or
  // READ_TEAM) gets the section; the server scopes rows to the managed
  // departments for team viewers. Department/role narrow within scope.
  // Full-vs-team is decided by company-wide scope (employees record read +
  // Admin/HR role): ATTENDANCE_READ_* slugs alone no longer distinguish the
  // two since the RBAC catalog grants record read to admin, HR and RMs
  // alike — the scope helper checks the actor's role.
  const canSeeFullRoster = hasCompanyWideScope(permissions ?? [], user);
  const canSeeTeamRoster =
    canSeeFullRoster || hasPermission(PERMISSIONS.ATTENDANCE_READ_TEAM);
  // Managed department scope for team viewers (single managed department
  // locks the roster, several get a limited dropdown — resolved below from
  // the roster scope facets once they land).
  const managedDepartmentIds = useMemo(() => {
    const raw = user?.managedDepartmentIds;
    return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
  }, [user]);
  const [roster, setRoster] = useState([]);
  const [rosterPagination, setRosterPagination] = useState(null);
  const [rosterPage, setRosterPage] = useState(1);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterLoadingMore, setRosterLoadingMore] = useState(false);
  const [rosterError, setRosterError] = useState('');
  const [rosterQuery, setRosterQuery] = useState('');
  const [rosterDepartment, setRosterDepartment] = useState('');
  const [rosterRole, setRosterRole] = useState('');
  const [rosterDepartments, setRosterDepartments] = useState([]);
  const [rosterRoles, setRosterRoles] = useState([]);
  // Scope facets arrive with every roster response: the distinct
  // departments/roles across the viewer's whole scoped membership. Team
  // viewers build both dropdowns from these (never the directory lists).
  const [rosterFacets, setRosterFacets] = useState({ departments: [], roles: [] });
  // Scoped department options for team viewers: the UNION of assigned
  // managed departments (intersected with the directory for names) and
  // facet departments — a managed department with no people yet still
  // lists, so multi-department RMs always see exactly their departments.
  // Options can only narrow: the server enforces the same scope. A single
  // scoped department locks the roster (no dropdown).
  const scopedDeptOptions = useMemo(() => {
    const byId = new Map();
    for (const dept of rosterDepartments) {
      if (managedDepartmentIds.includes(String(dept.id))) {
        byId.set(String(dept.id), { id: dept.id, name: dept.name });
      }
    }
    const facets = Array.isArray(rosterFacets.departments) ? rosterFacets.departments : [];
    for (const dept of facets) {
      const key = String(dept?.id ?? '');
      if (key && !byId.has(key)) byId.set(key, { id: dept.id, name: dept.name });
    }
    return [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [managedDepartmentIds, rosterDepartments, rosterFacets]);
  // A single scoped department locks the roster (no dropdown); several get
  // a dropdown limited to those departments; full readers keep all of them.
  const canFilterRosterByDept =
    canSeeFullRoster || (canSeeTeamRoster && scopedDeptOptions.length > 1);
  // Department options for team viewers are limited to their scoped
  // departments (the server enforces the same scope, so the dropdown can
  // only narrow, never widen).
  const rosterDepartmentOptions = useMemo(() => {
    const list = canSeeFullRoster ? rosterDepartments : scopedDeptOptions;
    return [
      { value: '', label: canSeeFullRoster ? 'All departments' : 'All managed departments' },
      ...list.map((dept) => ({ value: dept.id, label: dept.name })),
    ];
  }, [canSeeFullRoster, rosterDepartments, scopedDeptOptions]);
  // Role options for team viewers are limited to the roles of the people
  // under them (scope facets). Team viewers cannot list roles
  // (ROLES_MANAGE/USERS_WRITE only), so without facets the role filter
  // would be a dead single-option select — hide it.
  // The Admin role option is visible only to viewers who can administer
  // roles — team viewers never see it in any role dropdown.
  const canSeeAdminRole = user?.roleSlug === SYSTEM_ROLE_SLUGS.ADMIN
    || hasPermission(PERMISSIONS.ROLES_MANAGE);
  const withoutAdminRole = (role) => canSeeAdminRole || role.slug !== SYSTEM_ROLE_SLUGS.ADMIN;
  const scopedRoleOptions = useMemo(() => {
    const fromFacets = Array.isArray(rosterFacets.roles) ? rosterFacets.roles : [];
    return [
      { value: '', label: 'All roles' },
      ...fromFacets
        .filter(withoutAdminRole)
        .map((role) => ({ value: role.id, label: role.name })),
    ];
  }, [rosterFacets, canSeeAdminRole]);
  const showRosterRoleFilter =
    canSeeFullRoster || (canSeeTeamRoster && scopedRoleOptions.length > 1);
  const debouncedRosterQuery = useDebouncedValue(rosterQuery, 350);
  const rosterSentinelRef = useRef(null);
  const rosterRequestKeyRef = useRef('');

  const loadRoster = useCallback(async ({
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
    rosterRequestKeyRef.current = requestKey;
    if (append) {
      setRosterLoadingMore(true);
    } else if (!quiet) {
      setRosterLoading(true);
    }
    setRosterError('');
    try {
      const params = { page: nextPage, limit: ROSTER_PREVIEW_SIZE };
      if (search.trim()) params.search = search.trim();
      if (nextDepartment) params.departmentId = nextDepartment;
      if (nextRole) params.roleId = nextRole;
      const data = await adminApi.getTeamTodayStatus(params);
      if (rosterRequestKeyRef.current !== requestKey) return;
      setRoster((current) => {
        const fresh = data.teamStatus ?? [];
        if (!append) return fresh;
        const seen = new Set(current.map((item) => item?.userId));
        return [...current, ...fresh.filter((item) => !seen.has(item?.userId))];
      });
      setRosterPagination(data.pagination ?? null);
      setRosterPage(data.pagination?.page ?? nextPage);
      setRosterFacets(data.scopeFacets ?? { departments: [], roles: [] });
    } catch (err) {
      if (rosterRequestKeyRef.current !== requestKey) return;
      setRosterError(getErrorMessage(err));
      if (!append) {
        setRoster([]);
        setRosterPagination(null);
        setRosterFacets({ departments: [], roles: [] });
      }
    } finally {
      if (rosterRequestKeyRef.current === requestKey) {
        setRosterLoading(false);
        setRosterLoadingMore(false);
      }
    }
  }, []);

  const canManageHelp = hasPermission(PERMISSIONS.HELP_MANAGE);
  const canWriteUsers = hasPermission(PERMISSIONS.USERS_WRITE);


  // Department options for the roster filter below. Fail-silent so
  // read-only viewers without list rights still get the table.
  useEffect(() => {
    let cancelled = false;
    adminApi
      .listDepartments()
      .then((data) => {
        if (!cancelled) setRosterDepartments(data.departments ?? []);
      })
      .catch(() => {
        if (!cancelled) setRosterDepartments([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openTicketsTo = canManageHelp && canWriteUsers ? '/admin/help/tickets' : '/admin/help/team';
  const visibleCards = KPI_CARDS.filter((card) => {
    if (card.key !== 'openTickets') return true;
    return canManageHelp;
  }).map((card) => (card.key === 'openTickets' ? { ...card, to: openTicketsTo } : card));


  useEffect(() => {
    if (!canSeeFullRoster) return undefined;
    // listRoles needs ROLES_MANAGE or USERS_WRITE — team viewers build
    // their role options from the roster scope facets instead.
    if (typeof adminApi.listRoles !== 'function') return undefined;
    adminApi
      .listRoles()
      .then((data) => setRosterRoles(data.roles ?? []))
      .catch(() => setRosterRoles([]));
  }, [canSeeFullRoster]);

  // Refs mirror the Employee List pattern: the debounced keystroke effect
  // must not refire for dropdown changes (those load directly below).
  const rosterDepartmentRef = useRef(rosterDepartment);
  rosterDepartmentRef.current = rosterDepartment;
  const rosterRoleRef = useRef(rosterRole);
  rosterRoleRef.current = rosterRole;

  useEffect(() => {
    if (!canSeeTeamRoster) return undefined;
    loadRoster({
      search: debouncedRosterQuery,
      nextPage: 1,
      nextDepartment: rosterDepartmentRef.current,
      nextRole: rosterRoleRef.current,
      quiet: true,
    });
  }, [canSeeTeamRoster, debouncedRosterQuery, loadRoster]);

  function handleRosterDepartmentChange(value) {
    setRosterDepartment(value);
    loadRoster({ search: rosterQuery, nextPage: 1, nextDepartment: value, nextRole: rosterRole });
  }

  function handleRosterRoleChange(value) {
    setRosterRole(value);
    loadRoster({ search: rosterQuery, nextPage: 1, nextDepartment: rosterDepartment, nextRole: value });
  }

  useEffect(() => {
    if (!canSeeTeamRoster) return undefined;
    const node = rosterSentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || rosterLoading || rosterLoadingMore) return;
        if (!rosterPagination || rosterPage >= rosterPagination.totalPages) return;
        loadRoster({
          search: debouncedRosterQuery,
          nextPage: rosterPage + 1,
          append: true,
          nextDepartment: rosterDepartmentRef.current,
          nextRole: rosterRoleRef.current,
        });
      },
      { rootMargin: '120px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    canSeeTeamRoster,
    debouncedRosterQuery,
    rosterDepartment,
    rosterRole,
    loadRoster,
    rosterLoading,
    rosterLoadingMore,
    rosterPage,
    rosterPagination,
  ]);

  useEffect(() => {
    setLoading(true);
    setReportsError('');
    Promise.allSettled([adminApi.getReportsSummary(), leaveApi.getApprovalsPendingCounts()])
      .then(([reportsResult, countsResult]) => {
        if (reportsResult.status === 'fulfilled') {
          setReports(reportsResult.value.summary ?? null);
        } else {
          setReports(null);
          setReportsError(getErrorMessage(reportsResult.reason));
        }
        // Badge counts are RM-scoped to the caller's approval queue via the
        // pending-counts endpoint; fail silent so the KPI grid still renders.
        if (countsResult.status === 'fulfilled') {
          setCounts(countsResult.value.counts ?? null);
        } else {
          setCounts(null);
        }
      })
      .finally(() => setLoading(false));
  }, []);



  return (
    <div className="page page--admin-home">
      <p className="admin-home__intro muted">
        Operational snapshot for today (IST).
      </p>

      {reportsError ? (
        <div className="alert alert--error" role="alert">
          {reportsError}
        </div>
      ) : null}

      {loading ? (
        <div className="admin-home__grid" aria-busy="true" aria-label="Loading dashboard metrics">
          {visibleCards.map((card) => (
            <DashboardCardSkeleton key={card.key} />
          ))}
        </div>
      ) : reports ? (
        <>
          <div className="admin-home__grid">
            {visibleCards.map((card) => {
              const hint = card.getHint?.(reports, counts);
              return (
                <Link key={card.key} to={card.to} className="admin-home__card card">
                  <span className="admin-home__card-chevron" aria-hidden="true">
                    ›
                  </span>
                  <div className="admin-home__card-head">
                    <span className="admin-home__card-icon" aria-hidden="true">
                      {card.icon}
                    </span>
                    <span className="admin-home__card-label">{card.label}</span>
                  </div>
                  <strong className="admin-home__card-value">{card.getValue(reports, counts)}</strong>
                  {hint ? <span className="admin-home__card-hint muted small">{hint}</span> : null}
                </Link>
              );
            })}
          </div>

          {canSeeTeamRoster ? (
            <section className="card card--table admin-home__roster" aria-label="Today present preview">
              <div className="card__toolbar">
                <h2 className="card__title">Today present</h2>
              </div>
              {rosterError ? <div className="alert alert--error">{rosterError}</div> : null}
              <TodayPresentRoster
                rows={roster}
                loading={rosterLoading}
                search={rosterQuery}
                onSearchChange={setRosterQuery}
                hasActiveSearch={Boolean(rosterQuery.trim())}
                onDepartmentChange={handleRosterDepartmentChange}
                departmentValue={rosterDepartment}
                showDepartmentFilter={canFilterRosterByDept}
                departmentOptions={rosterDepartmentOptions}
                onRoleChange={showRosterRoleFilter ? handleRosterRoleChange : null}
                roleValue={rosterRole}
                roleOptions={canSeeFullRoster
                  ? [
                    { value: '', label: 'All roles' },
                    ...rosterRoles.filter(withoutAdminRole).map((role) => ({ value: role.id, label: role.name })),
                  ]
                  : scopedRoleOptions}
                footer={
                  rosterPagination && roster.length > 0 ? (
                    <p className="employees-scroll-hint muted small" role="status">
                      Showing {roster.length} of {rosterPagination.total} team members
                      {rosterLoadingMore ? ' · Loading more…' : ''}
                      {' · '}
                      <Link to="/admin/attendance/today-present">View all</Link>
                    </p>
                  ) : null
                }
              />
              <div ref={rosterSentinelRef} className="employees-scroll-sentinel" aria-hidden="true" />
            </section>
          ) : null}
        </>
      ) : null}


    </div>
  );
}
