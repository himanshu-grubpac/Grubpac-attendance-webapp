import { useEffect, useState, useCallback, useMemo } from 'react';
import { PERMISSIONS } from '@shared/permissions.js';
import { Link } from 'react-router-dom';
import { formatISTDateTime } from '../../utils/datetime.js';
import { adminApi, helpApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import HelpStatusBadge from '../../components/HelpStatusBadge.jsx';
import HelpPriorityBadge from '../../components/HelpPriorityBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { usePortalSync } from '../../hooks/usePortalSync.js';
import { broadcastHelpSync, PORTAL_TOPICS } from '../../utils/portalSync.js';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export default function AdminHelpTeam() {
  const { hasPermission } = useAuth();
  const canSetPriority =
    hasPermission(PERMISSIONS.HELP_SET_PRIORITY) || hasPermission(PERMISSIONS.HELP_MANAGE);
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatingPriorityId, setUpdatingPriorityId] = useState('');
  const { showSuccess, showError } = useToast();

  const scopedDeptOptions = useMemo(
    () => [...departments].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    [departments],
  );
  const canFilterByDept = scopedDeptOptions.length > 1;
  const departmentOptions = useMemo(
    () => [
      { value: '', label: 'All managed departments' },
      ...scopedDeptOptions.map((dept) => ({ value: dept.id, label: dept.name })),
    ],
    [scopedDeptOptions],
  );

  useEffect(() => {
    let cancelled = false;
    adminApi
      .listDepartments()
      .then((data) => {
        if (!cancelled) setDepartments(data.departments ?? []);
      })
      .catch(() => {
        if (!cancelled) setDepartments([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadTickets = useCallback(async (nextPage = page, nextDepartment = departmentId) => {
    setLoading(true);
    setError('');
    try {
      const params = { scope: 'team', page: nextPage, limit: 20 };
      if (nextDepartment) params.departmentId = nextDepartment;
      const data = await helpApi.listTickets(params);
      setTickets(data.tickets ?? []);
      setPagination(data.pagination ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, departmentId]);

  useEffect(() => {
    loadTickets(page, departmentId);
  }, [loadTickets, page, departmentId]);

  usePortalSync(() => {
    void loadTickets(page, departmentId);
  }, { topics: [PORTAL_TOPICS.HELP] });

  const handlePriorityChange = useCallback(async (ticketId, newPriority) => {
    setUpdatingPriorityId(ticketId);
    try {
      await helpApi.updateTicketStatus(ticketId, { priority: newPriority });
      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, priority: newPriority } : t)),
      );
      broadcastHelpSync();
      showSuccess('Priority updated.');
    } catch (err) {
      showError(getErrorMessage(err));
    } finally {
      setUpdatingPriorityId('');
    }
  }, [showSuccess, showError]);

  return (
    <div className="page">
      {error && <div className="alert alert--error">{error}</div>}

      {canFilterByDept ? (
        <div className="toolbar-row toolbar-row--filters">
          <label className="field-inline form-field--sm">
            <span className="label">Department</span>
            <SelectField
              value={departmentId}
              onChange={(value) => {
                setDepartmentId(value);
                setPage(1);
              }}
              options={departmentOptions}
              aria-label="Filter by department"
            />
          </label>
        </div>
      ) : null}

      <div className="card card--table">
        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.help}
            title="No team help tickets"
            description="Tickets from employees in your managed team will appear here."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive help-team-table-wrap">
            <table className="table data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Title</th>
                  <th>Priority</th>
                  {canSetPriority ? <th>Set Priority</th> : null}
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Employee">{item.createdByName}</td>
                    <td data-label="Title" className="cell-ellipsis" title={item.title}>
                      {item.title}
                    </td>
                    <td data-label="Priority">
                      <HelpPriorityBadge priority={item.priority} />
                    </td>
                    {canSetPriority ? (
                      <td data-label="Set Priority">
                        <SelectField
                          value={item.priority ?? 'medium'}
                          onChange={(value) => handlePriorityChange(item.id, value)}
                          options={PRIORITY_OPTIONS}
                          aria-label={`Set priority for ${item.title}`}
                          disabled={!item.canManage || updatingPriorityId === item.id}
                        />
                      </td>
                    ) : null}
                    <td data-label="Status">
                      <HelpStatusBadge status={item.status} />
                    </td>
                    <td data-label="Created" className="muted small">
                      {formatISTDateTime(item.createdAt)}
                    </td>
                    <td data-label="Actions" className="cell-actions">
                      <Link to={`/admin/help/team/${item.id}`} className="btn btn-ghost btn-sm">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar pagination={pagination} onPageChange={setPage} />
      </div>
    </div>
  );
}
