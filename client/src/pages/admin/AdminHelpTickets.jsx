import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { formatISTDateTime } from '../../utils/datetime.js';
import { helpApi, getErrorMessage } from '../../services/api.js';
import HelpStatusBadge from '../../components/HelpStatusBadge.jsx';
import HelpPriorityBadge from '../../components/HelpPriorityBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import { useToast } from '../../context/ToastContext.jsx';

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export default function AdminHelpTickets() {
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [updatingPriorityId, setUpdatingPriorityId] = useState('');
  const { showSuccess, showError } = useToast();

  async function loadTickets(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const params = { scope: 'all', page: nextPage, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      const data = await helpApi.listTickets(params);
      setTickets(data.tickets ?? []);
      setPagination(data.pagination ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  useEffect(() => {
    loadTickets(page);
  }, [page, statusFilter]);

  const handlePriorityChange = useCallback(async (ticketId, newPriority) => {
    setUpdatingPriorityId(ticketId);
    try {
      await helpApi.updateTicketStatus(ticketId, { priority: newPriority });
      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, priority: newPriority } : t)),
      );
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

      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline filter-bar__field">
            <span className="label">Status</span>
            <SelectField
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_FILTER_OPTIONS}
              aria-label="Status filter"
            />
          </label>
        </div>

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.help}
            title="No help tickets"
            description={statusFilter ? 'No tickets match this status filter.' : 'Support tickets will appear here when raised.'}
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Title</th>
                  <th>Priority</th>
                  <th>Set Priority</th>
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
                    <td data-label="Set Priority">
                      <SelectField
                        value={item.priority ?? 'medium'}
                        onChange={(value) => handlePriorityChange(item.id, value)}
                        options={PRIORITY_OPTIONS}
                        aria-label={`Set priority for ${item.title}`}
                        disabled={updatingPriorityId === item.id}
                      />
                    </td>
                    <td data-label="Status">
                      <HelpStatusBadge status={item.status} />
                    </td>
                    <td data-label="Created" className="muted small">{formatISTDateTime(item.createdAt)}</td>
                    <td data-label="Actions" className="cell-actions">
                      <Link to={`/admin/help/tickets/${item.id}`} className="btn btn-ghost btn-sm">
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
