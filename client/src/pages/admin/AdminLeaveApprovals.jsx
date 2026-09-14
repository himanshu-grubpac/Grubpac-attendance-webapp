import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatISTDate, formatISTDateTime, IST_TIMEZONE } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import { getTodayMonthIst } from '../../components/MonthField.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useActionPopup } from '../../context/ActionPopupContext.jsx';
import { useTableColumns } from '../../hooks/useTableColumns.js';
import ColumnEditorPanel from '../../components/ColumnEditorPanel.jsx';
import LeaveDecisionModal from './LeaveDecisionModal.jsx';
import RequestsTabs from '../../components/RequestsTabs.jsx';

const REQUEST_TABS = ['leave', 'wfh', 'compoff'];

function tabFromParam(value) {
  return REQUEST_TABS.includes(value) ? value : 'leave';
}

const APPROVALS_PAGE_SIZE = 20;

// Fallback only: the popup countdown prefers the server-authoritative
// `decisionUndoExpiresAt` (undo expiry; the applicant email follows ~2.5s
// later via the finalizer, never during the undoable period).
const DECISION_UNDO_MS = 15000;

// Quiet background settle cadence for rows with a staged (undoable) action.
// The API answers fast; final status lands via the ~5s server finalizer, so
// the UI polls silently instead of hanging on PENDING. Capped so a stuck
// staged row (finalizer down) stops polling after ~2 minutes.
const PENDING_SETTLE_POLL_MS = 5000;
const MAX_SETTLE_POLLS = 24;

function decisionUndoDurationMs(request) {
  const expiresAt = Date.parse(request?.decisionUndoExpiresAt ?? '');
  if (!Number.isFinite(expiresAt)) return DECISION_UNDO_MS;
  return Math.max(0, expiresAt - Date.now());
}

const AVATAR_COLORS = ['#e85d04', '#3b82f6', '#8b5cf6', '#059669', '#d946ef', '#0ea5e9'];

const QUEUE_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

const LEAVE_TABLE_KEY = 'leaveList';

const LEAVE_COLUMNS = [
  { key: 'employee', label: 'Employee', always: true },
  { key: 'type', label: 'Leave type' },
  { key: 'period', label: 'Period' },
  { key: 'days', label: 'Days' },
  { key: 'status', label: 'Status' },
];

const LEAVE_DEFAULT_COLUMNS = ['employee', 'type', 'period', 'days', 'status'];

function statCardsForQueue(queueStatus) {
  const labels = {
    pending: { label: 'PENDING REQUESTS', hint: 'Awaiting your decision', icon: '⏳', tone: 'warning' },
    approved: { label: 'APPROVED REQUESTS', hint: 'Decisions recorded in your scope', icon: '✓', tone: 'info' },
    rejected: { label: 'REJECTED REQUESTS', hint: 'Rejected leave requests with remarks', icon: '✕', tone: 'danger' },
    cancelled: { label: 'CANCELLED REQUESTS', hint: 'Cancelled leave requests', icon: '✕', tone: 'muted' },
  };
  const config = labels[queueStatus] ?? labels.pending;
  return [
    {
      key: 'count',
      ...config,
    },
    {
      key: 'days',
      label: 'LEAVE DAYS',
      hint: 'Total days on this page',
      icon: '▤',
      tone: 'info',
    },
  ];
}

function getInitials(name) {
  if (!name?.trim()) return '?';
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < (name ?? '').length; i += 1) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function leaveTypeLabel(item) {
  if (item.leaveTypeCode && item.leaveTypeName) {
    return `${item.leaveTypeCode} — ${item.leaveTypeName}`;
  }
  return item.leaveTypeCode || item.leaveTypeName || 'Leave';
}

function halfDayLabel(halfDay) {
  if (halfDay === 'am') return 'Morning half-day';
  if (halfDay === 'pm') return 'Afternoon half-day';
  return null;
}


function compactDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  }).format(new Date(value));
}

function dateRangeLabel(item) {
  const start = formatISTDate(item.startDate);
  const end = formatISTDate(item.endDate);
  const half = halfDayLabel(item.halfDay);
  const halfSuffix = half ? ` · ${half}` : '';
  if (start === end) return `${start}${halfSuffix}`;
  return `${start} – ${end}${halfSuffix}`;
}

function compactDateRangeLabel(item) {
  const start = compactDate(item.startDate);
  const end = compactDate(item.endDate);
  if (start === end) return start;
  return `${start} – ${end}`;
}

function compactLeaveTypeLabel(item) {
  if (item.leaveTypeCode && item.leaveTypeName) {
    return `${item.leaveTypeCode} — ${item.leaveTypeName}`;
  }
  return item.leaveTypeCode || item.leaveTypeName || 'Leave';
}

function durationLabel(days) {
  const value = Number(days);
  if (!Number.isFinite(value)) return '—';
  if (value === 1) return '1 day';
  return `${value} days`;
}

function submittedLabel(value) {
  if (!value) return null;
  return formatISTDateTime(value);
}

function decidedLabel(value) {
  if (!value) return null;
  return formatISTDateTime(value);
}

function isDefaultMonthFilter(month) {
  return !month;
}

function parseMonthFilterValue(value) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) {
    return { year: getTodayMonthIst().split('-')[0], month: '' };
  }
  const [year, month] = value.split('-');
  return { year, month };
}

function toMonthFilterValue(year, month) {
  return month ? `${year}-${month}` : '';
}

function getCurrentIstYear() {
  return Number(getTodayMonthIst().split('-')[0]);
}

function clampYearToCurrent(year) {
  const currentYear = getCurrentIstYear();
  const parsed = Number(year);
  if (!Number.isFinite(parsed) || parsed > currentYear) {
    return String(currentYear);
  }
  return String(parsed);
}

function buildYearOptions() {
  const currentYear = getCurrentIstYear();
  const years = [];
  for (let year = currentYear; year >= currentYear - 4; year -= 1) {
    years.push({ value: String(year), label: String(year) });
  }
  return years;
}

const MONTH_PART_OPTIONS = [
  { value: '', label: 'All months' },
  ...Array.from({ length: 12 }, (_, index) => ({
    value: String(index + 1).padStart(2, '0'),
    label: new Intl.DateTimeFormat('en-IN', {
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2020, index, 1))),
  })),
];

function StatCardSkeleton() {
  return (
    <div className="approvals-stat card approvals-stat--skeleton" aria-hidden="true">
      <div className="approvals-stat__head">
        <div className="skeleton approvals-stat__skeleton-label" />
        <div className="skeleton approvals-stat__skeleton-icon" />
      </div>
      <div className="skeleton approvals-stat__skeleton-value" />
      <div className="skeleton approvals-stat__skeleton-hint" />
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="table-wrap table-wrap--responsive approvals-table-wrap" aria-busy="true" aria-label="Loading leave approvals">
      <table className="table data-table approvals-table">
        <thead>
          <tr>
            <th className="approvals-table__expand-col" aria-hidden="true" />
            <th scope="col" className="approvals-table__col-row-num">
              #
            </th>
            <th>Employee</th>
            <th>Leave type</th>
            <th>Period</th>
            <th>Days</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, index) => (
            <tr key={index} className="approval-row approval-row--skeleton">
              <td colSpan={7}>
                <div className="skeleton skeleton--row" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminLeaveApprovals() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { showSuccess, showError } = useToast();
  const { showActionPopup } = useActionPopup();

  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [yearFilter, setYearFilter] = useState(() =>
    clampYearToCurrent(parseMonthFilterValue(getTodayMonthIst()).year),
  );
  const [monthPartFilter, setMonthPartFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [comments, setComments] = useState({});
  const [actingId, setActingId] = useState(null);
  const [expandedIds, setExpandedIds] = useState({});
  const [queueStatus, setQueueStatus] = useState('pending');
  const [requestTab, setRequestTab] = useState(() => tabFromParam(searchParams.get('tab')));

  const [decisionModal, setDecisionModal] = useState({ open: false, item: null, comment: '' });
  const [cancelModal, setCancelModal] = useState({ open: false, item: null, comment: '' });
  const {
    columnsLoading: leaveColumnsLoading,
    columnsError: leaveColumnsError,
    editorOpen: leaveEditorOpen,
    setEditorOpen: setLeaveEditorOpen,
    isColumnVisible: isLeaveColumnVisible,
    handleColumnToggle: handleLeaveColumnToggle,
  } = useTableColumns({
    tableKey: LEAVE_TABLE_KEY,
    allColumns: LEAVE_COLUMNS,
    defaultVisible: LEAVE_DEFAULT_COLUMNS,
  });
  const employeeFilterRef = useRef(employeeFilter);
  const yearFilterRef = useRef(yearFilter);
  const monthPartFilterRef = useRef(monthPartFilter);
  const queueStatusRef = useRef(queueStatus);
  const requestTabRef = useRef(requestTab);
  employeeFilterRef.current = employeeFilter;
  yearFilterRef.current = yearFilter;
  monthPartFilterRef.current = monthPartFilter;
  queueStatusRef.current = queueStatus;
  requestTabRef.current = requestTab;

  const monthFilter = useMemo(
    () => toMonthFilterValue(yearFilter, monthPartFilter),
    [yearFilter, monthPartFilter],
  );

  const yearOptions = useMemo(() => buildYearOptions(), []);

  // Employee filter options derive from the loaded (already scope-filtered)
  // queue rows — never from the directory. A reporting manager therefore only
  // ever sees employees under them here; out-of-scope ids are additionally
  // rejected server-side with a 403.
  const employeeOptions = useMemo(() => {
    const seen = new Map();
    for (const item of requests) {
      const id = item.userId ? String(item.userId) : '';
      if (!id || seen.has(id)) continue;
      seen.set(id, item.userName || 'Employee');
    }
    return [
      { value: '', label: 'All employees' },
      ...[...seen.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [requests]);

  const hasActiveFilters = Boolean(employeeFilter) || !isDefaultMonthFilter(monthFilter);

  const pageLeaveDays = useMemo(
    () => requests.reduce((sum, item) => sum + (Number(item.days) || 0), 0),
    [requests],
  );

  const loadRequests = useCallback(async ({
    nextPage = 1,
    nextEmployee = employeeFilterRef.current,
    nextYear = yearFilterRef.current,
    nextMonthPart = monthPartFilterRef.current,
    nextQueueStatus = queueStatusRef.current,
    nextTab = requestTabRef.current,
    quiet = false,
  } = {}) => {
    const nextMonth = toMonthFilterValue(nextYear, nextMonthPart);
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    try {
      const params = {
        scope: 'approvals',
        status: nextQueueStatus,
        page: nextPage,
        limit: 20,
      };

      if (nextEmployee) params.userId = nextEmployee;
      if (nextYear) params.year = nextYear;
      if (nextMonthPart) params.month = `${nextYear}-${nextMonthPart}`;
      // Leave/WFH tabs split the queue server-side so pagination stays exact.
      if (nextTab === 'wfh') params.leaveTypeCode = 'WFH';
      if (nextTab === 'leave') params.excludeLeaveTypeCode = 'WFH';
      const data = await leaveApi.listRequests(params);
      setRequests(data.requests ?? []);
      setPagination(data.pagination ?? null);
      setPage(nextPage);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      // A quiet settle poll must never clear a foreground skeleton or error.
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests({ nextPage: 1 });
  }, [loadRequests]);

  // Settle polling: while any visible row carries a staged (undoable) action,
  // silently refetch so PENDING flips to the finalized status as soon as the
  // server finalizer commits it. Stops automatically once nothing is staged
  // (or after MAX_SETTLE_POLLS attempts if a row stays stuck).
  const settlePollsRef = useRef(0);
  useEffect(() => {
    if (!requests.some((item) => item.pendingDecision)) {
      settlePollsRef.current = 0;
      return undefined;
    }
    if (settlePollsRef.current >= MAX_SETTLE_POLLS) return undefined;
    const timer = setInterval(() => {
      settlePollsRef.current += 1;
      loadRequests({ nextPage: page, quiet: true });
    }, PENDING_SETTLE_POLL_MS);
    return () => clearInterval(timer);
  }, [requests, page, loadRequests]);

  useEffect(() => {
    setExpandedIds({});
  }, [page, employeeFilter, monthFilter, queueStatus, requestTab]);

  function handleQueueStatusChange(value) {
    setQueueStatus(value);
    loadRequests({ nextPage: 1, nextQueueStatus: value });
  }

  function handleRequestTabChange(tab) {
    if (tab === 'compoff') {
      navigate('/admin/leave/comp-off');
      return;
    }
    setRequestTab(tab);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'leave') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      return next;
    }, { replace: true });
    loadRequests({ nextPage: 1, nextTab: tab });
  }

  // Keep the tab in sync when arriving via a ?tab= deep link.
  useEffect(() => {
    const tab = tabFromParam(searchParams.get('tab'));
    if (tab !== 'compoff' && tab !== requestTabRef.current) {
      setRequestTab(tab);
      loadRequests({ nextPage: 1, nextTab: tab });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);



  useEffect(() => {
    const decision = searchParams.get('decision');
    const requestId = searchParams.get('requestId');
    if (decision !== 'request' || !requestId) {
      return undefined;
    }

    // NOTE: no "handled" ref guard here on purpose. React StrictMode (dev)
    // mounts, unmounts and remounts, so a ref marked "handled" before the
    // fetch would cancel the only fetch on remount and the modal would never
    // open. Supersession is tracked per effect run instead: only the latest
    // run may open the modal or consume the query params.
    let superseded = false;
    async function openDeepLinkedRequest() {
      // Prefer the already-loaded queue row so no fetch is needed.
      let target = requests.find((item) => item.id === requestId);
      if (!target) {
        try {
          const data = await leaveApi.getRequest(requestId);
          target = data.request ?? data;
        } catch (err) {
          if (superseded) return;
          showError(getErrorMessage(err));
          setSearchParams({}, { replace: true });
          return;
        }
      }

      if (superseded) return;
      if (target?.status === 'pending') {
        setDecisionModal({ open: true, item: target, comment: '' });
        setExpandedIds((prev) => ({ ...prev, [requestId]: true }));
      } else {
        showError('This leave request is no longer pending.');
      }
      setSearchParams({}, { replace: true });
    }

    openDeepLinkedRequest();
    return () => {
      superseded = true;
    };
  }, [searchParams, requests, setSearchParams, showError]);

  function setCommentFor(id, value) {
    setComments((prev) => ({ ...prev, [id]: value }));
  }

  function handleEmployeeChange(value) {
    setEmployeeFilter(value);
    loadRequests({ nextPage: 1, nextEmployee: value });
  }

  function handleYearChange(value) {
    const clampedYear = clampYearToCurrent(value);
    setYearFilter(clampedYear);
    loadRequests({ nextPage: 1, nextYear: clampedYear });
  }

  function handleMonthPartChange(value) {
    setMonthPartFilter(value);
    loadRequests({ nextPage: 1, nextMonthPart: value });
  }

  function clearFilters() {
    const { year } = parseMonthFilterValue(getTodayMonthIst());
    setEmployeeFilter('');
    setYearFilter(year);
    setMonthPartFilter('');
    loadRequests({ nextPage: 1, nextEmployee: '', nextYear: year, nextMonthPart: '' });
  }

  function toggleExpanded(id) {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleSummaryKeyDown(event, id) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleExpanded(id);
    }
  }

  async function handleDecision(id, decision) {
    const item = decisionModal.item || requests.find((r) => r.id === id);
    const note = (decisionModal.comment || (comments[id] ?? '')).trim();
    if (!note) {
      showError('A remark is required for this action.');
      return;
    }
    const payload = { comment: note };

    if (decision === 'reject') {
      setActingId(id);
      setError('');
      try {
        const response = await leaveApi.rejectRequest(id, payload);
        const durationMs = decisionUndoDurationMs(response?.request);
        setDecisionModal({ open: false, item: null, comment: '' });
        if (durationMs > 0) {
          showActionPopup({
            message: 'Leave request declined. If done by mistake, click Undo to revert it.',
            undoLabel: 'Undo',
            onUndo: async () => {
              try {
                await leaveApi.undoDecision(id);
                showSuccess('Leave decision undone.');
                await loadRequests({ nextPage: page });
                setDecisionModal({ open: true, item: item, comment: note });
              } catch (err) {
                showError(getErrorMessage(err));
                // Undo may have lost the expiry race and the request could be
                // finalized — resync so the UI never shows a stale undoable row.
                await loadRequests({ nextPage: page });
              }
            },
            durationMs,
          });
        } else {
          showSuccess('Leave request declined.');
        }
        setComments((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await loadRequests({ nextPage: page });
      } catch (err) {
        showError(getErrorMessage(err));
      } finally {
        setActingId(null);
      }
      return;
    }

    setActingId(id);
    setError('');
    try {
      const response = await leaveApi.approveRequest(id, payload);
      const durationMs = decisionUndoDurationMs(response?.request);
      setDecisionModal({ open: false, item: null, comment: '' });
      if (durationMs > 0) {
        showActionPopup({
          message: 'Leave request approved. If done by mistake, click Undo to revert it.',
          undoLabel: 'Undo',
            onUndo: async () => {
              try {
                await leaveApi.undoDecision(id);
                showSuccess('Leave decision undone.');
                await loadRequests({ nextPage: page });
                setDecisionModal({ open: true, item: item, comment: note });
              } catch (err) {
                showError(getErrorMessage(err));
                // Undo may have lost the expiry race and the request could be
                // finalized — resync so the UI never shows a stale undoable row.
                await loadRequests({ nextPage: page });
              }
            },
            durationMs,
          });
        } else {
          showSuccess('Leave request approved.');
        }
      setComments((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await loadRequests({ nextPage: page });
    } catch (err) {
      showError(getErrorMessage(err));
    } finally {
      setActingId(null);
    }
  }

  async function handleCancelApproved() {
    const item = cancelModal.item;
    const note = (cancelModal.comment || '').trim();
    if (!note) {
      showError('A remark is required to cancel this leave.');
      return;
    }
    setActingId(item.id);
    setError('');
    try {
      const response = await leaveApi.cancelApproved(item.id, { comment: note });
      const durationMs = decisionUndoDurationMs(response?.request);
      setCancelModal({ open: false, item: null, comment: '' });
      if (durationMs > 0) {
        showActionPopup({
          message: 'Approved leave cancelled. If done by mistake, click Undo to revert it.',
          undoLabel: 'Undo',
            onUndo: async () => {
              try {
                await leaveApi.undoCancellation(item.id);
                showSuccess('Cancellation undone. Leave restored.');
                await loadRequests({ nextPage: page });
              } catch (err) {
                showError(getErrorMessage(err));
                await loadRequests({ nextPage: page });
              }
            },
          durationMs,
        });
      } else {
        showSuccess('Approved leave cancelled.');
      }
      await loadRequests({ nextPage: page });
    } catch (err) {
      showError(getErrorMessage(err));
    } finally {
      setActingId(null);
    }
  }

  const statCards = useMemo(() => statCardsForQueue(queueStatus), [queueStatus]);
  const isPendingQueue = queueStatus === 'pending';

  const statValues = {
    count: pagination?.total ?? (loading ? null : 0),
    days: loading ? null : pageLeaveDays,
  };

  const pageSize = pagination?.limit ?? APPROVALS_PAGE_SIZE;

  return (
    <div className="page page--approvals">
      <RequestsTabs active={requestTab} onSelect={handleRequestTabChange} />
      <section className="approvals-stats" aria-label="Approval queue summary">
        <div className="approvals-stats__grid">
          {loading && !pagination
            ? statCards.map((card) => <StatCardSkeleton key={card.key} />)
            : statCards.map((card) => (
              <article
                key={card.key}
                className={`approvals-stat card approvals-stat--${card.tone}`}
              >
                <div className="approvals-stat__head">
                  <span className="approvals-stat__label">{card.label}</span>
                  <span className="approvals-stat__icon" aria-hidden="true">
                    {card.icon}
                  </span>
                </div>
                <strong className="approvals-stat__value">
                  {statValues[card.key] == null ? '—' : statValues[card.key]}
                </strong>
                <p className="approvals-stat__hint muted small">{card.hint}</p>
              </article>
            ))}
        </div>
      </section>

      <section
        className="approvals-panel card card--table"
        aria-label={`${queueStatus.charAt(0).toUpperCase() + queueStatus.slice(1)} leave requests`}
      >
        <div className="approvals-toolbar card__toolbar">
          <div className="approvals-toolbar__filters filter-bar">
            <label className="field-inline filter-bar__field approvals-toolbar__field">
              <span className="label">Queue</span>
              <SelectField
                value={queueStatus}
                onChange={handleQueueStatusChange}
                options={QUEUE_STATUS_OPTIONS}
                aria-label="Leave queue filter"
              />
            </label>

            <label className="field-inline filter-bar__field approvals-toolbar__field">
              <span className="label">Employee</span>
              <SelectField
                value={employeeFilter}
                onChange={handleEmployeeChange}
                options={employeeOptions}
                aria-label="Employee filter"
                disabled={loading}
              />
            </label>

            <div className="field-inline filter-bar__field approvals-toolbar__field approvals-toolbar__field--period">
              <span className="label">Leave period</span>
              <div className="approvals-toolbar__period">
                <SelectField
                  value={yearFilter}
                  onChange={handleYearChange}
                  options={yearOptions}
                  aria-label="Leave year filter"
                />
                <SelectField
                  value={monthPartFilter}
                  onChange={handleMonthPartChange}
                  options={MONTH_PART_OPTIONS}
                  aria-label="Leave month filter"
                />
              </div>
            </div>

            {hasActiveFilters ? (
              <div className="filter-bar__field approvals-toolbar__clear">
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            ) : null}
            <div className="filter-bar__field approvals-toolbar__clear">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLeaveEditorOpen(true)}>
                Edit columns
              </button>
            </div>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}
        {leaveColumnsError ? <div className="alert alert--error">{leaveColumnsError}</div> : null}

        {loading ? (
          <QueueSkeleton />
        ) : requests.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title={
              hasActiveFilters
                ? `No ${queueStatus} requests match these filters`
                : queueStatus === 'pending'
                  ? 'No leave requests pending approval'
                  : queueStatus === 'approved'
                    ? 'No approved leave requests in this period'
                    : queueStatus === 'rejected'
                      ? 'No rejected leave requests in this period'
                      : 'No cancelled leave requests'
            }
            description={
              hasActiveFilters
                ? 'Try a different employee or month, or clear filters to see the full queue.'
                : queueStatus === 'pending'
                  ? 'New leave requests that require your decision will appear in this queue.'
                  : queueStatus === 'approved'
                    ? 'Approved requests in your scope will appear here after decisions are recorded.'
                    : queueStatus === 'rejected'
                      ? 'Rejected requests in your scope will appear here with approver remarks.'
                      : 'Cancelled leave requests will appear here.'
            }
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
            <div className="table-wrap approvals-table-wrap">
              <table className="table data-table approvals-table">
                <thead>
                  <tr>
                    <th className="approvals-table__expand-col" aria-label="Expand row" />
                    <th scope="col" className="approvals-table__col-row-num">
                      #
                    </th>
                    {isLeaveColumnVisible('employee') && <th>Employee</th>}
                    {isLeaveColumnVisible('type') && <th>Leave type</th>}
                    {isLeaveColumnVisible('period') && <th>Period</th>}
                    {isLeaveColumnVisible('days') && <th>Days</th>}
                    {isLeaveColumnVisible('status') && <th>Status</th>}
                    <th className="approvals-table__actions-col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((item, index) => {
                    const rowNumber = (page - 1) * pageSize + index + 1;
                    const busy = actingId === item.id;
                    const submitted = submittedLabel(item.createdAt);
                    const decided = decidedLabel(item.decidedAt);
                    const initials = getInitials(item.userName);
                    const color = avatarColor(item.userName);
                    const isExpanded = Boolean(expandedIds[item.id]);
                    const detailId = `approval-detail-${item.id}`;

                    const mobileSubline = [
                      compactLeaveTypeLabel(item),
                      compactDateRangeLabel(item),
                      durationLabel(item.days),
                    ]
                      .map((part) => String(part ?? '').trim())
                      .filter(Boolean)
                      .join(' · ');
                    const mobileAction = isPendingQueue ? 'take-action' : queueStatus === 'approved' ? 'cancel' : null;

                    return (
                      <Fragment key={item.id}>
                        <tr
                          className={`approval-row approval-row--summary${isExpanded ? ' approval-row--expanded' : ''
                            }`}
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          aria-controls={detailId}
                          onClick={() => toggleExpanded(item.id)}
                          onKeyDown={(event) => handleSummaryKeyDown(event, item.id)}
                        >
                          {/* Mobile card (≤720px): identity, subline, status, action */}
                          <td className="approval-card-cell" colSpan={8}>
                            <div className="approval-card">
                              <button
                                type="button"
                                className="approval-row__toggle approval-card__toggle"
                                aria-expanded={isExpanded}
                                aria-controls={detailId}
                                aria-label={
                                  isExpanded
                                    ? `Collapse ${item.userName || 'employee'} leave request`
                                    : `Expand ${item.userName || 'employee'} leave request`
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleExpanded(item.id);
                                }}
                              >
                                <span
                                  className={`approval-row__chevron${isExpanded ? ' is-open' : ''}`}
                                  aria-hidden="true"
                                >
                                  ▼
                                </span>
                              </button>
                              <div className="approval-card__main">
                                <div className="approval-card__identity">
                                  <span
                                    className="approval-row__avatar"
                                    style={{ backgroundColor: color }}
                                    aria-hidden="true"
                                  >
                                    {initials}
                                  </span>
                                  <span className="approval-card__name">{item.userName || 'Employee'}</span>
                                </div>
                                {mobileSubline ? (
                                  <p className="approval-card__subline muted">{mobileSubline}</p>
                                ) : null}
                              </div>
                              <div
                                className="approval-card__footer"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <LeaveStatusBadge status={item.status} />
                                {mobileAction && !isExpanded ? (
                                  mobileAction === 'take-action' ? (
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm btn--compact approval-card__action"
                                      disabled={busy || Boolean(item.pendingDecision)}
                                      onClick={() => setDecisionModal({ open: true, item, comment: comments[item.id] ?? '' })}
                                    >
                                      Take Action
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="btn btn-danger btn-sm btn--compact approval-card__action"
                                      disabled={busy || Boolean(item.pendingDecision)}
                                      onClick={() => setCancelModal({ open: true, item, comment: '' })}
                                    >
                                      Cancel
                                    </button>
                                  )
                                ) : null}
                              </div>
                            </div>
                          </td>

                          <td
                            className="approvals-table__expand-cell approval-desktop-cell"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="approval-row__toggle"
                              aria-expanded={isExpanded}
                              aria-controls={detailId}
                              aria-label={
                                isExpanded
                                  ? `Collapse ${item.userName || 'employee'} leave request`
                                  : `Expand ${item.userName || 'employee'} leave request`
                              }
                              onClick={() => toggleExpanded(item.id)}
                            >
                              <span
                                className={`approval-row__chevron${isExpanded ? ' is-open' : ''}`}
                                aria-hidden="true"
                              >
                                ▼
                              </span>
                            </button>
                          </td>

                          <td
                            data-label="#"
                            className="approvals-table__row-num approval-desktop-cell"
                            aria-label={`Row ${rowNumber}`}
                          >
                            {rowNumber}
                          </td>

                          {isLeaveColumnVisible('employee') && (
                            <td data-label="Employee" className="approval-row__employee-cell approval-desktop-cell">
                              <div className="approval-row__identity">
                                <span
                                  className="approval-row__avatar"
                                  style={{ backgroundColor: color }}
                                  aria-hidden="true"
                                >
                                  {initials}
                                </span>
                                <span className="approval-row__name">{item.userName || 'Employee'}</span>
                              </div>
                            </td>
                          )}

                          {isLeaveColumnVisible('type') && (
                            <td data-label="Leave type" className="approval-row__type approval-desktop-cell" title={leaveTypeLabel(item)}>
                              {compactLeaveTypeLabel(item)}
                            </td>
                          )}

                          {isLeaveColumnVisible('period') && (
                            <td
                              data-label="Period"
                              className="approval-row__dates muted approval-desktop-cell"
                              title={dateRangeLabel(item)}
                            >
                              {compactDateRangeLabel(item)}
                            </td>
                          )}

                          {isLeaveColumnVisible('days') && (
                            <td data-label="Days" className="approval-row__days approval-desktop-cell">
                              {durationLabel(item.days)}
                            </td>
                          )}

                          {isLeaveColumnVisible('status') && (
                            <td data-label="Status" className="approval-row__status approval-desktop-cell">
                              <LeaveStatusBadge status={item.status} />
                            </td>
                          )}

                          {!isExpanded ? (
                            <td
                              className="approvals-table__actions-cell approval-desktop-cell"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {isPendingQueue ? (
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={busy || Boolean(item.pendingDecision)}
                                  onClick={() => setDecisionModal({ open: true, item, comment: comments[item.id] ?? '' })}
                                >
                                  Take Action
                                </button>
                              ) : queueStatus === 'approved' ? (
                                <button
                                  type="button"
                                  className="btn btn-danger btn-sm"
                                  disabled={busy || Boolean(item.pendingDecision)}
                                  onClick={() => setCancelModal({ open: true, item, comment: '' })}
                                >
                                  Cancel
                                </button>
                              ) : null}
                            </td>
                          ) : (
                            <td className="approvals-table__actions-cell approval-desktop-cell" />
                          )}
                        </tr>

                        {isExpanded ? (
                          <tr className="approval-row__detail-row">
                            <td colSpan={8}>
                              <div id={detailId} className="approval-row__detail">
                                {item.userEmail ? (
                                  <p className="approval-row__email muted small" title={item.userEmail}>
                                    {item.userEmail}
                                  </p>
                                ) : null}

                                {submitted ? (
                                  <p className="approval-row__submitted muted small">
                                    Submitted {submitted}
                                  </p>
                                ) : null}

                                {decided ? (
                                  <p className="approval-row__submitted muted small">
                                    {item.status === 'approved' ? 'Approved' : 'Decided'} {decided}
                                    {item.approverName ? ` by ${item.approverName}` : ''}
                                  </p>
                                ) : null}

                                <dl className="approval-row__meta">
                                  <div className="approval-row__meta-item">
                                    <dt>Leave type</dt>
                                    <dd>{leaveTypeLabel(item)}</dd>
                                  </div>
                                  <div className="approval-row__meta-item">
                                    <dt>Leave period</dt>
                                    <dd>{dateRangeLabel(item)}</dd>
                                  </div>
                                  <div className="approval-row__meta-item">
                                    <dt>Duration</dt>
                                    <dd>{durationLabel(item.days)}</dd>
                                  </div>
                                  {halfDayLabel(item.halfDay) ? (
                                    <div className="approval-row__meta-item">
                                      <dt>Half-day</dt>
                                      <dd>{halfDayLabel(item.halfDay)}</dd>
                                    </div>
                                  ) : null}
                                </dl>

                                {item.reason ? (
                                  <div className="approval-row__reason">
                                    <span className="label">Request reason</span>
                                    <p>{item.reason}</p>
                                  </div>
                                ) : null}

                                {item.documentUrl ? (
                                  <a
                                    className="approval-row__doc"
                                    href={item.documentUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open supporting document
                                  </a>
                                ) : null}

                                {item.decisionComment ? (
                                  <div className="approval-row__reason">
                                    <span className="label">Approver comment</span>
                                    <p>{item.decisionComment}</p>
                                  </div>
                                ) : null}

                                {item.pendingDecision ? (
                                  <div className="approval-row__pending-decision" style={{ padding: '8px 12px', marginBottom: 8, background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 6, fontSize: 13, color: '#92400e' }}>
                                    A <strong>{item.pendingDecision}</strong> decision is pending. Undo it first before making a new decision.
                                  </div>
                                ) : null}

                                {isPendingQueue ? (
                                  <div className="approval-row__actions">
                                    <button
                                      type="button"
                                      className="btn btn-primary"
                                      disabled={busy || Boolean(item.pendingDecision)}
                                      onClick={() => setDecisionModal({ open: true, item, comment: comments[item.id] ?? '' })}
                                    >
                                      Take Action
                                    </button>
                                  </div>
                                ) : queueStatus === 'approved' ? (
                                  <div className="approval-row__actions">
                                    <button
                                      type="button"
                                      className="btn btn-danger"
                                      disabled={busy || Boolean(item.pendingDecision)}
                                      onClick={() => setCancelModal({ open: true, item, comment: '' })}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationBar pagination={pagination} onPageChange={(nextPage) => loadRequests({ nextPage })} />
          </>
        )}
      </section>

      {confirmDialog}

      <ColumnEditorPanel
        open={leaveEditorOpen}
        columns={LEAVE_COLUMNS}
        isColumnVisible={isLeaveColumnVisible}
        onToggle={handleLeaveColumnToggle}
        loading={leaveColumnsLoading}
        onClose={() => setLeaveEditorOpen(false)}
      />

      <LeaveDecisionModal
        open={decisionModal.open}
        item={decisionModal.item}
        initialComment={decisionModal.comment}
        busy={actingId === decisionModal.item?.id}
        error={error}
        onCommentChange={(value) => setDecisionModal((prev) => ({ ...prev, comment: value }))}
        onApprove={() => handleDecision(decisionModal.item.id, 'approve')}
        onReject={() => handleDecision(decisionModal.item.id, 'reject')}
        onCancel={() => setDecisionModal({ open: false, item: null, comment: '' })}
      />

      <LeaveDecisionModal
        open={cancelModal.open}
        item={cancelModal.item}
        action="cancel"
        initialComment={cancelModal.comment}
        busy={actingId === cancelModal.item?.id}
        error={error}
        onCommentChange={(value) => setCancelModal((prev) => ({ ...prev, comment: value }))}
        onApprove={handleCancelApproved}
        onReject={() => setCancelModal({ open: false, item: null, comment: '' })}
      />
    </div>
  );
}
