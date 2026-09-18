import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { formatISTDateTime } from '../../utils/datetime.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import DateField from '../../components/DateField.jsx';

const MODULE_OPTIONS = [
  { value: '', label: 'All modules' },
  { value: 'authentication', label: 'Authentication' },
  { value: 'employees', label: 'Employees' },
  { value: 'organization', label: 'Organization' },
  { value: 'roles', label: 'Roles & Permissions' },
  { value: 'leave', label: 'Leave' },
  { value: 'comp-off', label: 'Comp Off' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'helpdesk', label: 'Helpdesk' },
  { value: 'salary', label: 'Salary & Payroll' },
  { value: 'faq', label: 'FAQ & Demo' },
  { value: 'audit', label: 'Audit Logs' },
  { value: 'other', label: 'Other' },
];

const ACTION_OPTIONS = [
  { value: '', label: 'All events' },
  { value: 'login_success', label: 'Auth — Login success' },
  { value: 'login_failed', label: 'Auth — Login failed' },
  { value: 'logout', label: 'Auth — Logout' },
  { value: 'profile_updated', label: 'Auth — Profile updated' },
  { value: 'password_changed', label: 'Auth — Password changed' },
  { value: 'pin_changed', label: 'Auth — PIN changed' },
  { value: 'pin_set', label: 'Auth — PIN set' },
  { value: 'pin_removed', label: 'Auth — PIN removed' },
  { value: 'password_reset_requested', label: 'Auth — Password reset requested' },
  { value: 'password_reset_completed', label: 'Auth — Password reset completed' },
  { value: 'employee_registered', label: 'Employees — Registered' },
  { value: 'employee_org_updated', label: 'Employees — Updated' },
  { value: 'employee_bulk_upsert', label: 'Employees — Bulk sync' },
  { value: 'employee_bulk_upload', label: 'Employees — Bulk upload (legacy)' },
  { value: 'password_reset_by_admin', label: 'Employees — Password reset' },
  { value: 'pin_reset_by_admin', label: 'Employees — PIN reset' },
  { value: 'quarter_warnings_reset', label: 'Employees — Warnings reset' },
  { value: 'department_created', label: 'Org — Department created' },
  { value: 'department_updated', label: 'Org — Department updated' },
  { value: 'department_deleted', label: 'Org — Department deleted' },
  { value: 'office_settings_updated', label: 'Org — Office settings updated' },
  { value: 'role_created', label: 'Roles — Created' },
  { value: 'role_updated', label: 'Roles — Updated' },
  { value: 'role_deleted', label: 'Roles — Deleted' },
  { value: 'leave_type_created', label: 'Leave — Type created' },
  { value: 'leave_type_updated', label: 'Leave — Type updated' },
  { value: 'leave_type_deleted', label: 'Leave — Type deleted' },
  { value: 'leave_policy_created', label: 'Leave — Policy created' },
  { value: 'leave_policy_updated', label: 'Leave — Policy updated' },
  { value: 'leave_policy_entitled_recomputed', label: 'Leave — Entitlements recomputed' },
  { value: 'leave_balance_adjusted', label: 'Leave — Balance adjusted' },
  { value: 'leave_encashment_recorded', label: 'Leave — Encashment recorded' },
  { value: 'leave_carry_forward_applied', label: 'Leave — Carry forward applied' },
  { value: 'leave_accrual_job_run', label: 'Leave — Accrual job run' },
  { value: 'leave_request_created', label: 'Leave — Request created' },
  { value: 'leave_request_approved', label: 'Leave — Request approved' },
  { value: 'leave_request_rejected', label: 'Leave — Request rejected' },
  { value: 'leave_request_edited', label: 'Leave — Request edited' },
  { value: 'leave_request_withdrawn', label: 'Leave — Request withdrawn' },
  { value: 'leave_request_cancelled', label: 'Leave — Request cancelled' },
  { value: 'leave_request_cancellation_undone', label: 'Leave — Cancellation undone' },
  { value: 'leave_request_decision_undone', label: 'Leave — Decision undone' },
  { value: 'leave_request_finalized', label: 'Leave — Request finalized' },
  { value: 'leave_request_auto_approved', label: 'Leave — Auto approved' },
  { value: 'leave_submit_finalized', label: 'Leave — Submit finalized' },
  { value: 'leave_admin_exception_granted', label: 'Leave — Admin exception granted' },
  { value: 'leave_admin_exception_denied', label: 'Leave — Admin exception denied' },
  { value: 'holiday_created', label: 'Leave — Holiday created' },
  { value: 'holiday_updated', label: 'Leave — Holiday updated' },
  { value: 'holiday_deleted', label: 'Leave — Holiday deleted' },
  { value: 'recurring_holiday_rules_updated', label: 'Leave — Recurring rules updated' },
  { value: 'recurring_holidays_materialized', label: 'Leave — Recurring holidays materialized' },
  { value: 'recurring_rule_holidays_deleted', label: 'Leave — Rule holidays deleted' },
  { value: 'leave_carry_bulk_upload', label: 'Leave — Carry bulk upload' },
  { value: 'leave_adjustment_batch', label: 'Leave — Adjustment batch' },
  { value: 'comp_off_requested', label: 'Comp off — Requested' },
  { value: 'comp_off_submit_finalized', label: 'Comp off — Submit finalized' },
  { value: 'comp_off_submit_undone', label: 'Comp off — Submit undone' },
  { value: 'comp_off_approved', label: 'Comp off — Approved' },
  { value: 'comp_off_rejected', label: 'Comp off — Rejected' },
  { value: 'comp_off_decision_undone', label: 'Comp off — Decision undone' },
  { value: 'comp_off_worked', label: 'Comp off — Worked' },
  { value: 'comp_off_assess_staged', label: 'Comp off — Assessment staged' },
  { value: 'comp_off_assess_undone', label: 'Comp off — Assessment undone' },
  { value: 'comp_off_withdrawn', label: 'Comp off — Withdrawn' },
  { value: 'comp_off_withdraw_undone', label: 'Comp off — Withdrawal undone' },
  { value: 'comp_off_finalized', label: 'Comp off — Finalized' },
  { value: 'comp_off_lapsed', label: 'Comp off — Lapsed' },
  { value: 'attendance_marked', label: 'Attendance — Marked' },
  { value: 'attendance_admin_create', label: 'Attendance — Created by admin' },
  { value: 'attendance_admin_edit', label: 'Attendance — Edited by admin' },
  { value: 'attendance_undo', label: 'Attendance — Undone' },
  { value: 'attendance_auto_checkout', label: 'Attendance — Auto checkout' },
  { value: 'week_attendance_confirmed', label: 'Attendance — Week confirmed' },
  { value: 'week_attendance_unconfirmed', label: 'Attendance — Week unconfirmed' },
  { value: 'help_ticket_created', label: 'Helpdesk — Ticket created' },
  { value: 'help_ticket_status_updated', label: 'Helpdesk — Ticket updated' },
  { value: 'help_ticket_comment_added', label: 'Helpdesk — Comment added' },
  { value: 'help_ticket_comment_deleted', label: 'Helpdesk — Comment deleted' },
  { value: 'help_ticket_deleted', label: 'Helpdesk — Ticket deleted' },
  { value: 'salary_updated', label: 'Salary — Employee salary updated' },
  { value: 'salary_settings_updated', label: 'Salary — Settings updated' },
  { value: 'salary_transfers_generated', label: 'Salary — Transfers generated' },
  { value: 'salary_transfer_updated', label: 'Salary — Transfer updated' },
  { value: 'salary_audit_exported', label: 'Salary — Audit exported' },
  { value: 'lop_record_created', label: 'Salary — LOP record created' },
  { value: 'month_settled', label: 'Salary — Month settled' },
  { value: 'demo_faq_created', label: 'FAQ — Created' },
  { value: 'demo_faq_updated', label: 'FAQ — Updated' },
  { value: 'demo_faq_deleted', label: 'FAQ — Deleted' },
  { value: 'audit_logs_exported', label: 'Audit — Logs exported' },
];

function statusBadgeClass(status) {
  if (status === 'success') return 'badge badge-success audit-log-status';
  if (status === 'failed') return 'badge badge-warning audit-log-status';
  return 'badge badge-muted audit-log-status';
}

function formatAuditStatus(status) {
  if (status === 'success') return 'SUCCESS';
  if (status === 'failed') return 'FAILED';
  // Never invent an outcome for legacy rows: unknown stays unknown.
  return status?.toUpperCase() || 'UNKNOWN';
}

function humanizeAction(action) {
  return String(action ?? '')
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatActionLabel(action) {
  if (action === 'login_success') return 'Login success';
  if (action === 'login_failed') return 'Login failed';
  if (action === 'employee_bulk_upsert') return 'Bulk sync';
  if (action === 'employee_bulk_upload') return 'Bulk upload';
  if (action === 'employee_registered') return 'Registered';
  if (action === 'employee_org_updated') return 'Updated';
  if (action === 'password_reset_by_admin') return 'Password reset';
  if (action === 'pin_reset_by_admin') return 'PIN reset';
  if (!action) return '—';
  return humanizeAction(action);
}

function formatActionTitle(action) {
  if (action === 'login_success') return 'Login success';
  if (action === 'login_failed') return 'Login failed';
  if (action === 'employee_bulk_upsert') return 'Bulk employee sync';
  if (action === 'employee_bulk_upload') return 'Bulk upload (legacy)';
  if (action === 'employee_registered') return 'Employee registered';
  if (action === 'employee_org_updated') return 'Employee org updated';
  if (action === 'password_reset_by_admin') return 'Password reset by admin';
  if (action === 'pin_reset_by_admin') return 'PIN reset by admin';
  if (!action) return undefined;
  return humanizeAction(action);
}

function hasActor(log) {
  const identifier = log?.metadata?.identifier;
  return Boolean(
    log?.userId ||
      log?.email ||
      (identifier !== undefined && identifier !== null && String(identifier).trim() !== ''),
  );
}

function formatActorEmail(log) {
  if (log.email) return { text: log.email, muted: false };
  // Failed logins store the attempted credential (email / mobile / code).
  const identifier = log.metadata?.identifier;
  if (identifier !== undefined && identifier !== null && String(identifier).trim() !== '') {
    return { text: String(identifier), muted: false };
  }
  if (!hasActor(log)) return { text: 'System', muted: true };
  return { text: 'Unknown user', muted: true };
}

function formatRoleDisplay(log) {
  if (log.role) return { text: log.role, muted: false };
  if (!hasActor(log)) return { text: 'System', muted: true };
  return { text: 'Not recorded', muted: true };
}

function formatReason(log) {
  return log.reason || 'Not recorded';
}

function formatShortDeviceId(deviceId) {
  if (!deviceId) return null;
  return deviceId.slice(0, 8);
}

const DEVICE_TYPE_LABELS = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' };

function formatDeviceOwnerLabel(actorName, deviceType) {
  const label = DEVICE_TYPE_LABELS[deviceType] ?? null;
  if (!label) return null;
  const name = typeof actorName === 'string' ? actorName.trim() : '';
  if (!name) return label;
  return `${/s$/i.test(name) ? `${name}'` : `${name}'s`} ${label}`;
}

function formatDeviceDisplay(log) {
  // Preferred: "<Name>'s <Mobile|Tablet|Desktop> — <Browser> / <OS>" from the
  // server-classified fields. Falls back to the legacy raw-ID rendering when
  // the response predates those fields.
  const ownerLabel =
    log.deviceType !== undefined
      ? formatDeviceOwnerLabel(log.actorName ?? null, log.deviceType)
      : null;
  if (ownerLabel) {
    const detail = [log.browser, log.os].filter(Boolean).join(' / ');
    return { text: detail ? `${ownerLabel} — ${detail}` : ownerLabel, muted: false };
  }
  if (log.deviceType !== undefined) return { text: 'Not recorded', muted: true };
  const shortDeviceId = formatShortDeviceId(log.deviceId);
  if (shortDeviceId) return { text: shortDeviceId, muted: false };
  if (log.userAgent) return { text: 'Browser', muted: false };
  return { text: 'Not recorded', muted: true };
}

function formatModuleLabel(module) {
  if (!module) return '—';
  return String(module)
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatShortRecordId(recordId) {
  if (!recordId) return 'n/a';
  const text = String(recordId);
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
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
  if (!level) return <span className="badge badge-muted">None</span>;

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

  // Live filters: text inputs debounce, everything else applies instantly.
  // One unified search box (email, user ID, or record ID — matched with OR
  // semantics by the `q` query param).
  const [query, setQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [action, setAction] = useState('');
  const [module, setModule] = useState('');
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 350);
  const [exporting, setExporting] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState(null);
  const [archiving, setArchiving] = useState(false);

  const requestKeyRef = useRef('');
  const skipAutoFilterRef = useRef(true);

  const hasActiveFilters = Boolean(
    debouncedQuery.trim() ||
      dateFrom ||
      dateTo ||
      action ||
      module ||
      conflictsOnly,
  );

  const loadLogs = useCallback(
    async ({
      nextPage = 1,
      nextQuery = '',
      nextDateFrom = '',
      nextDateTo = '',
      nextAction = '',
      nextModule = '',
      nextConflictsOnly = false,
    } = {}) => {
      const requestKey = [
        nextPage,
        nextQuery,
        nextDateFrom,
        nextDateTo,
        nextAction,
        nextModule,
        nextConflictsOnly,
      ].join('|');
      requestKeyRef.current = requestKey;
      setLoading(true);
      setError('');

      try {
        const params = { page: nextPage, limit: 20 };
        if (nextQuery) params.q = nextQuery;
        if (nextDateFrom) params.dateFrom = nextDateFrom;
        if (nextDateTo) params.dateTo = nextDateTo;
        if (nextAction) params.action = nextAction;
        if (nextModule) params.module = nextModule;
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
    adminApi
      .getAuditArchiveStatus()
      .then((data) => setArchiveStatus(data))
      .catch(() => setArchiveStatus(null));
  }, [loadLogs]);

  // Auto-apply: debounced text inputs, instant selects/dates/checkbox.
  useEffect(() => {
    if (skipAutoFilterRef.current) {
      skipAutoFilterRef.current = false;
      return;
    }
    loadLogs({
      nextPage: 1,
      nextQuery: debouncedQuery.trim(),
      nextDateFrom: dateFrom,
      nextDateTo: dateTo,
      nextAction: action,
      nextModule: module,
      nextConflictsOnly: conflictsOnly,
    });
  }, [
    debouncedQuery,
    dateFrom,
    dateTo,
    action,
    module,
    conflictsOnly,
    loadLogs,
  ]);

  async function handleArchiveNow() {
    if (archiving) return;
    if (
      !window.confirm(
        'Archive audit logs older than 1 month to cold storage and prune entries older than 2 months? This cannot be undone from the app.',
      )
    ) {
      return;
    }
    setArchiving(true);
    setError('');
    try {
      const result = await adminApi.runAuditArchive({});
      setArchiveStatus((current) => ({ ...(current ?? {}), lastRun: result }));
      loadLogs({
        nextPage: 1,
        nextQuery: query,
        nextDateFrom: dateFrom,
        nextDateTo: dateTo,
        nextAction: action,
        nextModule: module,
        nextConflictsOnly: conflictsOnly,
      });
      adminApi
        .getAuditArchiveStatus()
        .then((data) => setArchiveStatus({ ...data, lastRun: result }))
        .catch(() => {});
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setArchiving(false);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function handleExport(format) {
    setExporting(true);
    setError('');
    try {
      const blob = await adminApi.exportAuditLogs({
        q: query.trim() || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        action: action || undefined,
        module: module || undefined,
        conflictsOnly: conflictsOnly || undefined,
        format,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `audit-logs-${stamp}.${format}`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  function clearFilters() {
    setQuery('');
    setDateFrom('');
    setDateTo('');
    setAction('');
    setModule('');
    setConflictsOnly(false);
  }

  const emptyTitle = useMemo(() => {
    if (hasActiveFilters) return 'No audit logs match these filters';
    return 'No audit logs found';
  }, [hasActiveFilters]);

  const emptyDescription = useMemo(() => {
    if (hasActiveFilters) {
      return 'Try adjusting search, module, date range, event type, or conflict filter, or clear filters to browse all events.';
    }
    return 'Login events, bulk uploads, employee registrations, and other admin actions will appear here.';
  }, [hasActiveFilters]);

  return (
    <div className="page page--audit-logs">
      <section className="audit-logs-panel card card--table" aria-label="Login audit logs">
        <div className="audit-logs-toolbar card__toolbar">
          <div className="audit-logs-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search audit-logs-toolbar__search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search email, user ID, record ID, action, module, or date…"
              ariaLabel="Search audit logs"
            />

            <div className="audit-logs-toolbar__control-row">
            <label className="field-inline filter-bar__field audit-logs-toolbar__field">
              <span className="label">Module</span>
              <SelectField
                value={module}
                onChange={setModule}
                options={MODULE_OPTIONS}
                aria-label="Module filter"
              />
            </label>

            <label className="field-inline filter-bar__field audit-logs-toolbar__field">
              <span className="label">Event</span>
              <SelectField
                value={action}
                onChange={setAction}
                options={ACTION_OPTIONS}
                aria-label="Login event filter"
              />
            </label>

            <label className="field-inline filter-bar__field audit-logs-toolbar__field">
              <span className="label">From</span>
              <DateField
                value={dateFrom}
                onChange={setDateFrom}
                placeholder="Start date"
                aria-label="Filter from date"
              />
            </label>

            <label className="field-inline filter-bar__field audit-logs-toolbar__field">
              <span className="label">To</span>
              <DateField
                value={dateTo}
                onChange={setDateTo}
                placeholder="End date"
                aria-label="Filter to date"
              />
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={conflictsOnly}
                onChange={(event) => setConflictsOnly(event.target.checked)}
              />
              <span>Conflicts only</span>
            </label>

            <div className="audit-logs-toolbar__actions filter-bar__field">
              {hasActiveFilters ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleExport('xlsx')}
                disabled={exporting}
                title="Download filtered logs as Excel (max 10,000 rows)"
              >
                {exporting ? 'Exporting…' : 'Excel'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => handleExport('csv')}
                disabled={exporting}
                title="Download filtered logs as CSV (max 10,000 rows)"
              >
                {exporting ? 'Exporting…' : 'CSV'}
              </button>
            </div>
            </div>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        <p className="muted small audit-logs-archive-note">
          Showing live logs
          {archiveStatus?.oldestRetainedAt
            ? ` · oldest retained ${formatISTDateTime(archiveStatus.oldestRetainedAt)}`
            : ''}
          {archiveStatus?.archivedMonths?.length > 0
            ? ` · archived through ${archiveStatus.archivedMonths[archiveStatus.archivedMonths.length - 1]}`
            : ''}
          {' · '}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleArchiveNow}
            disabled={archiving}
            title="Archive logs older than 1 month to cold storage and prune entries older than 2 months"
          >
            {archiving ? 'Archiving…' : 'Archive now'}
          </button>
        </p>

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
            <div className="table-wrap table-wrap--fit table-wrap--responsive audit-logs-table-wrap">
              <table className="table data-table audit-logs-table">
                <colgroup>
                  <col className="audit-logs-table__col-time" />
                  <col className="audit-logs-table__col-action" />
                  <col className="audit-logs-table__col-module" />
                  <col className="audit-logs-table__col-email" />
                  <col className="audit-logs-table__col-record" />
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
                    <th scope="col">Module</th>
                    <th scope="col">Email</th>
                    <th scope="col">Record</th>
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
                    const actorEmail = formatActorEmail(log);
                    const roleDisplay = formatRoleDisplay(log);
                    const deviceDisplay = formatDeviceDisplay(log);
                    const deviceTitle = log.deviceId || log.userAgent || undefined;
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
                        <td data-label="Module" className="cell-ellipsis" title={log.module || undefined}>
                          {formatModuleLabel(log.module)}
                        </td>
                        <td data-label="Email" className="cell-ellipsis" title={actorEmail.muted ? undefined : actorEmail.text}>
                          {actorEmail.muted ? <span className="muted">{actorEmail.text}</span> : actorEmail.text}
                        </td>
                        <td data-label="Record" className="cell-ellipsis" title={log.recordId || undefined}>
                          {log.recordId ? formatShortRecordId(log.recordId) : <span className="muted">n/a</span>}
                        </td>
                        <td data-label="Role" className="cell-ellipsis" title={roleDisplay.muted ? undefined : roleDisplay.text}>
                          {roleDisplay.muted ? <span className="muted">{roleDisplay.text}</span> : roleDisplay.text}
                        </td>
                        <td data-label="Status">
                          <span className={statusBadgeClass(log.status)}>
                            {formatAuditStatus(log.status)}
                          </span>
                        </td>
                        <td
                          data-label="Reason"
                          className="cell-ellipsis audit-logs-table__reason"
                          title={log.reason || undefined}
                        >
                          {log.reason ? reason : <span className="muted">{reason}</span>}
                        </td>
                        <td
                          data-label="Device"
                          className="audit-logs-table__device"
                          title={deviceTitle}
                        >
                          {deviceDisplay.muted ? <span className="muted">{deviceDisplay.text}</span> : deviceDisplay.text}
                        </td>
                        <td
                          data-label="IP"
                          className="cell-ellipsis audit-logs-table__ip"
                          title={log.ip || undefined}
                        >
                          {log.ip ? log.ip : <span className="muted">Not recorded</span>}
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
                  nextQuery: query.trim(),
                  nextDateFrom: dateFrom,
                  nextDateTo: dateTo,
                  nextAction: action,
                  nextModule: module,
                  nextConflictsOnly: conflictsOnly,
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
