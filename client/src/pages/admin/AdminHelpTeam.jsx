import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatISTDateTime } from '../../utils/datetime.js';
import { helpApi, getErrorMessage } from '../../services/api.js';
import HelpStatusBadge from '../../components/HelpStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

export default function AdminHelpTeam() {
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadTickets(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const data = await helpApi.listTickets({ scope: 'team', page: nextPage, limit: 20 });
      setTickets(data.tickets ?? []);
      setPagination(data.pagination ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTickets(page);
  }, [page]);

  return (
    <div className="page">
      {error && <div className="alert alert--error">{error}</div>}

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
            description="Tickets from your direct reports will appear here."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Employee">{item.createdByName}</td>
                    <td data-label="Title" className="cell-ellipsis" title={item.title}>
                      {item.title}
                    </td>
                    <td data-label="Status">
                      <HelpStatusBadge status={item.status} />
                    </td>
                    <td data-label="Created" className="muted small">
                      {formatISTDateTime(item.createdAt)}
                    </td>
                    <td data-label="Action" className="cell-actions">
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
