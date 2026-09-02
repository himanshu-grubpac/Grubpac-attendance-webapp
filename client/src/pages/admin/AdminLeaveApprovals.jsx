import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatISTDate, formatISTDateTime, IST_TIMEZONE } from '../../utils/datetime.js';
import { adminApi, leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import { getTodayMonthIst } from '../../components/MonthField.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useActionPopup } from '../../context/ActionPopupContext.jsx';
import LeaveDecisionModal from './LeaveDecisionModal.jsx';

const APPROVALS_PAGE_SIZE = 20;

// Mirrors the server undo window (LEAVE_DECISION_UNDO_MS). The applicant email
// is only sent once this window expires, so the popup countdown must match.
const DECISION_UNDO_MS = 15000;

function decisionUndoDurationMs(request) {
  const expiresAt = Date.parse(request?.decisionUndoExpiresAt ?? '');
  if (!Number.isFinite(expiresAt)) return DECISION_UNDO_MS;
  return Math.max(0, expiresAt - Date.now());
}

const AVATAR_COLORS = ['#e85d04', '#3b82f6', '#8b5cf6', '#059669', '#d946ef', '#0ea5e9'];

const QUEUE_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'cancelled', label: 'Cancelled' },
];

function statCardsForQueue(queueStatus) {
  const labels = {
    pending: { label: 'PENDING REQUESTS', hint: 'Awaiting your decision', icon: '⏳', tone: 'warning' },
    approved: { label: 'APPROVED REQUESTS', hint: 'Decisions recorded in your scope', icon: '✓', tone: 'info' },
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
    <div className="table-wrap approvals-table-wrap" aria-busy="true" aria-label="Loading leave approvals">
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

async function fetchActiveEmployees() {
  const employees = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await adminApi.listEmployees({ page, limit: 100, isActive: 'true' });
    employees.push(...(data.employees ?? []));
    totalPages = data.pagination?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return employees;
}

export default function AdminLeaveApprovals() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { showSuccess, showError } = useToast();
  const { showActionPopup } = useActionPopup();

  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [page, setPage] = useState(1);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [yearFilter, setYearFilter] = useState(() =>
    clampYearToCurrent(parseMonthFilterValue(getTodayMonthIst()).year),
  );
  const [monthPartFilter, setMonthPartFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [error, setError] = useState('');
  const [comments, setComments] = useState({});
  const [actingId, setActingId] = useState(null);
  const [expandedIds, setExpandedIds] = useState({});
  const [queueStatus, setQueueStatus] = useState('pending');

  const [decisionModal, setDecisionModal] = useState({ open: false, item: null, comment: '' });
  const [cancelModal, setCancelModal] = useState({ open: false, item: null, comment: '' });
  const deepLinkRef = useRef(null);

  const employeeFilterRef = useRef(employeeFilter);
  const yearFilterRef = useRef(yearFilter);
  const monthPartFilterRef = useRef(monthPartFilter);
  const queueStatusRef = useRef(queueStatus);
  employeeFilterRef.current = employeeFilter;
  yearFilterRef.current = yearFilter;
  monthPartFilterRef.current = monthPartFilter;
  queueStatusRef.current = queueStatus;

  const monthFilter = useMemo(
    () => toMonthFilterValue(yearFilter, monthPartFilter),
    [yearFilter, monthPartFilter],
  );

  const yearOptions = useMemo(() => buildYearOptions(), []);

  const employeeOptions = useMemo(
    () => [
      { value: '', label: 'All employees' },
      ...employees.map((employee) => ({
        value: employee.id,
        label: employee.name || employee.email || 'Employee',
      })),
    ],
    [employees],
  );

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


  } = {}) => {
    const nextMonth = toMonthFilterValue(nextYear, nextMonthPart);
    setLoading(true);
    setError('');
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
      const data = await leaveApi.listRequests(params);
      setRequests(data.requests ?? []);
      setPagination(data.pagination ?? null);
      setPage(nextPage);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests({ nextPage: 1 });
  }, [loadRequests]);

  useEffect(() => {
    setExpandedIds({});
  }, [page, employeeFilter, monthFilter, queueStatus]);

  function handleQueueStatusChange(value) {
    setQueueStatus(value);
    loadRequests({ nextPage: 1, nextQueueStatus: value });
  }

  useEffect(() => {
    setEmployeesLoading(true);
    fetchActiveEmployees()
      .then((items) => setEmployees(items))
      .catch(() => {
        // Employee filter remains optional if directory fails to load.
      })
      .finally(() => setEmployeesLoading(false));
  }, []);

  useEffect(() => {
    const decision = searchParams.get('decision');
    const requestId = searchParams.get('requestId');
    if (decision !== 'request' || !requestId) {
      deepLinkRef.current = null;
      return undefined;
    }

    const deepLinkKey = `${decision}:${requestId}`;
    if (deepLinkRef.current === deepLinkKey) return undefined;
    deepLinkRef.current = deepLinkKey;

    let cancelled = false;
    async function openDeepLinkedRequest() {
      let target = requests.find((item) => item.id === requestId);
      if (!target) {
        try {
          const data = await leaveApi.getRequest(requestId);
          target = data.request ?? data;
        } catch (err) {
          if (!cancelled) {
            showError(getErrorMessage(err));
            setSearchParams({}, { replace: true });
          }
          return;
        }
      }

      if (cancelled) return;
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
      cancelled = true;
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
                disabled={employeesLoading}
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
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

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
                    : 'No cancelled leave requests'
            }
            description={
              hasActiveFilters
                ? 'Try a different employee or month, or clear filters to see the full queue.'
                : queueStatus === 'pending'
                  ? 'New leave requests that require your decision will appear in this queue.'
                  : queueStatus === 'approved'
                    ? 'Approved requests in your scope will appear here after decisions are recorded.'
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
                    <th>Employee</th>
                    <th>Leave type</th>
                    <th>Period</th>
                    <th>Days</th>
                    <th>Status</th>
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
                          <td
                            className="approvals-table__expand-cell"
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
                            className="approvals-table__row-num"
                            aria-label={`Row ${rowNumber}`}
                          >
                            {rowNumber}
                          </td>

                          <td data-label="Employee" className="approval-row__employee-cell">
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

                          <td data-label="Leave type" className="approval-row__type" title={leaveTypeLabel(item)}>
                            {compactLeaveTypeLabel(item)}
                          </td>

                          <td
                            data-label="Period"
                            className="approval-row__dates muted"
                            title={dateRangeLabel(item)}
                          >
                            {compactDateRangeLabel(item)}
                          </td>

                          <td data-label="Days" className="approval-row__days">
                            {durationLabel(item.days)}
                          </td>

                          <td data-label="Status" className="approval-row__status">
                            <LeaveStatusBadge status={item.status} />
                          </td>

                          {!isExpanded ? (
                            <td
                              className="approvals-table__actions-cell"
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
                            <td className="approvals-table__actions-cell" />
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
