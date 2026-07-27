import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { formatISTDateTime } from '../../utils/datetime.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import DateField from '../../components/DateField.jsx';

const ACTION_OPTIONS = [
  { value: '', label: 'All login events' },
  { value: 'login_success', label: 'Login success' },
  { value: 'login_failed', label: 'Login failed' },
];

function statusBadgeClass(status) {
  if (status === 'success') return 'badge badge-success audit-log-status';
  if (status === 'failed') return 'badge badge-warning audit-log-status';
  return 'badge badge-muted audit-log-status';
}

function formatAuditStatus(status) {
  if (status === 'success') return 'SUCCESS';
  if (status === 'failed') return 'FAILED';
  return status?.toUpperCase() || '—';
}

function formatActionLabel(action) {
  if (action === 'login_success') return 'Success';
  if (action === 'login_failed') return 'Failed';
  return action || '—';
}

function formatActionTitle(action) {
  if (action === 'login_success') return 'Login success';
  if (action === 'login_failed') return 'Login failed';
  return action || undefined;
}

function formatRoleLabel(role) {
  if (!role) return '—';
  return role;
}

function formatReason(log) {
  if (log.status === 'success' || log.action === 'login_success') return '—';
  return log.reason || '—';
}

function formatShortDeviceId(deviceId) {
  if (!deviceId) return '—';
  return deviceId.slice(0, 8);
}

function formatReasonLabel(reason) {
  if (reason === 'device') return 'shared device';
  if (reason === 'ip') return 'same network';
  return reason;
}

function resolveConflictLevel(log) {
  if (!log.ipConflict || !log.conflictWithUsers?.length) return null;
  const hasDevice = log.conflictWithUsers.some((entry) => entry.reasons?.includes('device'));
  return hasDevice ? 'device' : 'network';
}

function formatConflictTooltip(log) {
  if (!log.ipConflict || !log.conflictWithUsers?.length) return undefined;
  return log.conflictWithUsers
    .map((entry) => {
      const account = entry.email || entry.userId || 'Unknown account';
      const reasons = (entry.reasons ?? []).map(formatReasonLabel).join(', ');
      return `${account} (${reasons || 'conflict'})`;
    })
    .join('\n');
}

function ConflictBadge({ log }) {
  const level = resolveConflictLevel(log);
  if (!level) return '—';

  const label = level === 'device' ? 'Device' : 'Network';
  const badgeClass =
    level === 'device'
      ? 'badge badge-warning audit-logs-table__conflict audit-logs-table__conflict--device'
      : 'badge badge-muted audit-logs-table__conflict audit-logs-table__conflict--network';

  return (
    <span className={badgeClass} title={formatConflictTooltip(log)}>
      {label}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="audit-logs-table-skeleton" aria-busy="true" aria-label="Loading login audit logs">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

export default function AdminAuditLogs() {
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [draftSearch, setDraftSearch] = useState('');
  const [draftDate, setDraftDate] = useState('');
  const [draftAction, setDraftAction] = useState('');
  const [draftConflictsOnly, setDraftConflictsOnly] = useState(false);

  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedDate, setAppliedDate] = useState('');
  const [appliedAction, setAppliedAction] = useState('');
  const [appliedConflictsOnly, setAppliedConflictsOnly] = useState(false);

  const requestKeyRef = useRef('');

  const hasActiveFilters = Boolean(
    appliedSearch || appliedDate || appliedAction || appliedConflictsOnly,
  );

  const loadLogs = useCallback(
    async ({
      nextPage = 1,
      nextSearch = '',
      nextDate = '',
      nextAction = '',
      nextConflictsOnly = false,
    } = {}) => {
      const requestKey = `${nextPage}|${nextSearch}|${nextDate}|${nextAction}|${nextConflictsOnly}`;
      requestKeyRef.current = requestKey;
      setLoading(true);
      setError('');

      try {
        const params = { page: nextPage, limit: 20 };
        if (nextSearch) params.search = nextSearch;
        if (nextDate) params.date = nextDate;
        if (nextAction) params.action = nextAction;
        if (nextConflictsOnly) params.conflictsOnly = 'true';

        const data = await adminApi.listAuditLogs(params);
        if (requestKeyRef.current !== requestKey) return;

        setLogs(data.logs);
        setPagination(data.pagination);
      } catch (err) {
        if (requestKeyRef.current !== requestKey) return;
        setError(getErrorMessage(err));
      } finally {
        if (requestKeyRef.current === requestKey) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    loadLogs({ nextPage: 1 });
  }, [loadLogs]);

  function applyFilters() {
    const nextSearch = draftSearch.trim();
    setAppliedSearch(nextSearch);
    setAppliedDate(draftDate);
    setAppliedAction(draftAction);
    setAppliedConflictsOnly(draftConflictsOnly);
    loadLogs({
      nextPage: 1,
      nextSearch,
      nextDate: draftDate,
      nextAction: draftAction,
      nextConflictsOnly: draftConflictsOnly,
    });
  }

  function clearFilters() {
    setDraftSearch('');
    setDraftDate('');
    setDraftAction('');
    setDraftConflictsOnly(false);
    setAppliedSearch('');
    setAppliedDate('');
    setAppliedAction('');
    setAppliedConflictsOnly(false);
    loadLogs({
      nextPage: 1,
      nextSearch: '',
      nextDate: '',
      nextAction: '',
      nextConflictsOnly: false,
    });
  }

  const emptyTitle = useMemo(() => {
    if (hasActiveFilters) return 'No login logs match these filters';
    return 'No login logs found';
  }, [hasActiveFilters]);

  const emptyDescription = useMemo(() => {
    if (hasActiveFilters) {
      return 'Try adjusting search, date, event type, or conflict filter, or clear filters to browse all login attempts.';
    }
    return 'Successful and failed sign-in attempts will appear here as users access the system.';
  }, [hasActiveFilters]);

  return (
    <div className="page page--audit-logs">
      <section className="audit-logs-panel card card--table" aria-label="Login audit logs">
        <div className="audit-logs-toolbar card__toolbar">
          <div className="audit-logs-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search audit-logs-toolbar__search"
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Search corporate email…"
              ariaLabel="Search by corporate email"
              onEnter={applyFilters}
            />

            <label className="field-inline filter-bar__field audit-logs-toolbar__field">
              <span className="label">Date</span>
              <DateField
                value={draftDate}
                onChange={setDraftDate}
                placeholder="All dates"
                aria-label="Filter by date"
              />
            </label>

            <label className="field-inline filter-bar__field audit-logs-toolbar__field">
              <span className="label">Event</span>
              <SelectField
                value={draftAction}
                onChange={setDraftAction}
                options={ACTION_OPTIONS}
                aria-label="Login event filter"
              />
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={draftConflictsOnly}
                onChange={(event) => setDraftConflictsOnly(event.target.checked)}
              />
              <span>Conflicts only</span>
            </label>

            <div className="audit-logs-toolbar__actions filter-bar__field">
              {hasActiveFilters ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
              <button type="button" className="btn btn-primary btn-sm" onClick={applyFilters}>
                Apply Filters
              </button>
            </div>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : logs.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.inbox}
            title={emptyTitle}
            description={emptyDescription}
            action={
              hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--fit audit-logs-table-wrap">
              <table className="table data-table audit-logs-table">
                <colgroup>
                  <col className="audit-logs-table__col-time" />
                  <col className="audit-logs-table__col-action" />
                  <col className="audit-logs-table__col-email" />
                  <col className="audit-logs-table__col-role" />
                  <col className="audit-logs-table__col-status" />
                  <col className="audit-logs-table__col-reason" />
                  <col className="audit-logs-table__col-device" />
                  <col className="audit-logs-table__col-ip" />
                  <col className="audit-logs-table__col-conflict" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" title="Indian Standard Time">
                      Time
                    </th>
                    <th scope="col">Action</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Device</th>
                    <th scope="col">IP</th>
                    <th scope="col">Conflict</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const reason = formatReason(log);
                    const shortDeviceId = formatShortDeviceId(log.deviceId);
                    return (
                      <tr key={log.id}>
                        <td
                          data-label="Time"
                          className="cell-datetime audit-logs-table__time"
                          title={formatISTDateTime(log.timestamp)}
                        >
                          {formatISTDateTime(log.timestamp)}
                        </td>
                        <td
                          data-label="Action"
                          className="audit-logs-table__action"
                          title={formatActionTitle(log.action)}
                        >
                          {formatActionLabel(log.action)}
                        </td>
                        <td data-label="Email" className="cell-ellipsis" title={log.email || undefined}>
                          {log.email || '—'}
                        </td>
                        <td data-label="Role" className="cell-ellipsis" title={log.role || undefined}>
                          {formatRoleLabel(log.role)}
                        </td>
                        <td data-label="Status">
                          <span className={statusBadgeClass(log.status)}>
                            {formatAuditStatus(log.status)}
                          </span>
                        </td>
                        <td
                          data-label="Reason"
                          className="cell-ellipsis audit-logs-table__reason"
                          title={reason !== '—' ? reason : undefined}
                        >
                          {reason}
                        </td>
                        <td
                          data-label="Device"
                          className="audit-logs-table__device"
                          title={log.deviceId || undefined}
                        >
                          {shortDeviceId}
                        </td>
                        <td
                          data-label="IP"
                          className="cell-ellipsis audit-logs-table__ip"
                          title={log.ip || undefined}
                        >
                          {log.ip || '—'}
                        </td>
                        <td data-label="Conflict" className="audit-logs-table__conflict-cell">
                          <ConflictBadge log={log} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationBar
              pagination={pagination}
              onPageChange={(nextPage) =>
                loadLogs({
                  nextPage,
                  nextSearch: appliedSearch,
                  nextDate: appliedDate,
                  nextAction: appliedAction,
                  nextConflictsOnly: appliedConflictsOnly,
                })
              }
              entityLabel="logs"
            />
          </>
        )}
      </section>
    </div>
  );
}
