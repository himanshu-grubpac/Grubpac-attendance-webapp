import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';

const KPI_CARDS = [
  {
    key: 'pendingLeave',
    label: 'View Leave Requests',
    icon: '✓',
    to: '/admin/leave/approvals',
    getValue: (summary) => summary.pendingLeaveRequests,
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
    to: '/admin/users',
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
  const [reports, setReports] = useState(null);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reportsError, setReportsError] = useState('');


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
          <DashboardCardSkeleton />
          <DashboardCardSkeleton />
          <DashboardCardSkeleton />
          <DashboardCardSkeleton />
        </div>
      ) : reports ? (
        <div className="admin-home__grid">
          {KPI_CARDS.map((card) => {
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
                <strong className="admin-home__card-value">{card.getValue(reports)}</strong>
                {hint ? <span className="admin-home__card-hint muted small">{hint}</span> : null}
              </Link>
            );
          })}
        </div>
      ) : null}


    </div>
  );
}
