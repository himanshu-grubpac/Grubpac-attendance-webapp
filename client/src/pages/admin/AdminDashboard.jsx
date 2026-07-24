import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS, hasPermission } from '@shared/permissions.js';
import { getVisibleNavItems } from '../../config/nav.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { adminApi, getErrorMessage } from '../../services/api.js';

const ADMIN_SHORTCUT_PATHS = new Set([
  '/admin/dashboard',
  '/admin/leave/approvals',
  '/admin/attendance',
  '/admin/leave/team-calendar',
  '/admin/help/tickets',
  '/admin/help/team',
]);

export default function AdminDashboard() {
  const { user } = useAuth();
  const [reports, setReports] = useState(null);
  const [reportsError, setReportsError] = useState('');

  const shortcuts = getVisibleNavItems(user)
    .filter((item) => !ADMIN_SHORTCUT_PATHS.has(item.to))
    .slice(0, 8);

  const canOwnAttendance = hasPermission(user?.permissions, PERMISSIONS.ATTENDANCE_READ_OWN);

  useEffect(() => {
    adminApi
      .getReportsSummary()
      .then((data) => setReports(data.summary ?? null))
      .catch((err) => setReportsError(getErrorMessage(err)));
  }, []);

  return (
    <div className="page page--admin-home">
      {reports && (
        <div className="kpi-strip">
          <Link to="/admin/leave/approvals" className="kpi-strip__item card">
            <span className="kpi-strip__label">Pending leave</span>
            <strong className="kpi-strip__value">{reports.pendingLeaveRequests}</strong>
          </Link>
          <div className="kpi-strip__item card">
            <span className="kpi-strip__label">Leave used ({reports.year})</span>
            <strong className="kpi-strip__value">{reports.approvedLeaveDaysYtd}</strong>
            <span className="muted small">Approved days YTD</span>
          </div>
          <Link to="/admin/help/tickets" className="kpi-strip__item card">
            <span className="kpi-strip__label">Open tickets</span>
            <strong className="kpi-strip__value">{reports.openHelpTickets}</strong>
          </Link>
          <Link to="/admin/users" className="kpi-strip__item card">
            <span className="kpi-strip__label">Active employees</span>
            <strong className="kpi-strip__value">{reports.activeEmployees}</strong>
          </Link>
        </div>
      )}
      {reportsError && <div className="alert alert--error">{reportsError}</div>}

      {canOwnAttendance ? (
        <div className="card admin-own-attendance">
          <Link to="/employee/dashboard" className="admin-own-attendance__link">
            My attendance →
          </Link>
        </div>
      ) : null}

      <section className="card dash-shortcuts dash-shortcuts--list">
        <h2 className="dash-shortcuts__heading">Shortcuts</h2>
        <ul className="shortcut-list">
          {shortcuts.map((item) => (
            <li key={item.to}>
              <Link to={item.to} className="shortcut-list__link">
                <span className="shortcut-list__icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="shortcut-list__text">
                  <strong>{item.label}</strong>
                  <span className="muted small">{item.section}</span>
                </span>
                <span className="shortcut-list__chevron" aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
