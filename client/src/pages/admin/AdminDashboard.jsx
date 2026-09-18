import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
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
  const { hasPermission } = useAuth();
  const [reports, setReports] = useState(null);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reportsError, setReportsError] = useState('');

  // Today-present roster: the complete team list (infinite scroll), scoped
  // by the same team permissions as the Today Present page (READ_ALL = full
  // directory, READ_TEAM = reports). Department/role narrow within scope.
  const canSeeFullRoster = hasPermission(PERMISSIONS.ATTENDANCE_READ_ALL);
  const canFilterRosterByDept = hasPermission(PERMISSIONS.ATTENDANCE_READ_ALL);
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
    } catch (err) {
      if (rosterRequestKeyRef.current !== requestKey) return;
      setRosterError(getErrorMessage(err));
      if (!append) {
        setRoster([]);
        setRosterPagination(null);
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
    // listRoles needs ROLES_MANAGE or USERS_WRITE — fail silent so
    // read-only viewers still get the roster.
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
    if (!canSeeFullRoster) return undefined;
    loadRoster({
      search: debouncedRosterQuery,
      nextPage: 1,
      nextDepartment: rosterDepartmentRef.current,
      nextRole: rosterRoleRef.current,
      quiet: true,
    });
  }, [canSeeFullRoster, debouncedRosterQuery, loadRoster]);

  function handleRosterDepartmentChange(value) {
    setRosterDepartment(value);
    loadRoster({ search: rosterQuery, nextPage: 1, nextDepartment: value, nextRole: rosterRole });
  }

  function handleRosterRoleChange(value) {
    setRosterRole(value);
    loadRoster({ search: rosterQuery, nextPage: 1, nextDepartment: rosterDepartment, nextRole: value });
  }

  useEffect(() => {
    if (!canSeeFullRoster) return undefined;
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
    canSeeFullRoster,
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

          {canSeeFullRoster ? (
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
                departmentOptions={[
                  { value: '', label: 'All departments' },
                  ...rosterDepartments.map((dept) => ({ value: dept.id, label: dept.name })),
                ]}
                onRoleChange={handleRosterRoleChange}
                roleValue={rosterRole}
                roleOptions={[
                  { value: '', label: 'All roles' },
                  ...rosterRoles.map((role) => ({ value: role.id, label: role.name })),
                ]}
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
