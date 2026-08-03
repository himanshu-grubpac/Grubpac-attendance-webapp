import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatISTDate, formatISTDateTime, IST_TIMEZONE } from '../../utils/datetime.js';
import { adminApi, leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import { getTodayMonthIst } from '../../components/MonthField.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useToast } from '../../context/ToastContext.jsx';

const APPROVALS_PAGE_SIZE = 20;

const AVATAR_COLORS = ['#e85d04', '#3b82f6', '#8b5cf6', '#059669', '#d946ef', '#0ea5e9'];

const QUEUE_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
];

function statCardsForQueue(queueStatus) {
  const isPending = queueStatus === 'pending';
  return [
    {
      key: 'count',
      label: isPending ? 'PENDING REQUESTS' : 'APPROVED REQUESTS',
      hint: isPending ? 'Awaiting your decision' : 'Decisions recorded in your scope',
      icon: isPending ? '⏳' : '✓',
      tone: isPending ? 'warning' : 'info',
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
  return formatISTDate(value);
}

function decidedLabel(value) {
  if (!value) return null;
  return formatISTDateTime(value);
}

function isDefaultMonthFilter(month) {
  return month === getTodayMonthIst();
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
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { showSuccess, showError } = useToast();

  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [page, setPage] = useState(1);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [yearFilter, setYearFilter] = useState(() =>
    clampYearToCurrent(parseMonthFilterValue(getTodayMonthIst()).year),
  );
  const [monthPartFilter, setMonthPartFilter] = useState(
    () => parseMonthFilterValue(getTodayMonthIst()).month,
  );
  const [loading, setLoading] = useState(true);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [error, setError] = useState('');
  const [comments, setComments] = useState({});
  const [actingId, setActingId] = useState(null);
  const [expandedIds, setExpandedIds] = useState({});
  const [queueStatus, setQueueStatus] = useState('pending');

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
      if (nextMonth) params.month = nextMonth;

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
    const { year, month } = parseMonthFilterValue(getTodayMonthIst());
    setEmployeeFilter('');
    setYearFilter(year);
    setMonthPartFilter(month);
    loadRequests({ nextPage: 1, nextEmployee: '', nextYear: year, nextMonthPart: month });
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
    const item = requests.find((request) => request.id === id);
    const note = (comments[id] ?? '').trim();
    const payload = note ? { comment: note } : {};

    if (decision === 'reject') {
      await requestConfirm({
        title: 'Decline leave request?',
        message: item
          ? `Decline ${item.userName}'s request for ${leaveTypeLabel(item)} (${dateRangeLabel(item)}). The employee will be notified. This action cannot be reversed from this screen.`
          : 'Decline this leave request? The employee will be notified. This action cannot be reversed from this screen.',
        confirmLabel: 'Decline request',
        variant: 'danger',
        onConfirm: async () => {
          setActingId(id);
          setError('');
          try {
            await leaveApi.rejectRequest(id, payload);
            showSuccess('Leave request declined. The employee has been notified.');
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
        },
      });
      return;
    }

    setActingId(id);
    setError('');
    try {
      await leaveApi.approveRequest(id, payload);
      showSuccess('Leave request approved. The employee has been notified.');
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
        aria-label={isPendingQueue ? 'Pending leave requests' : 'Approved leave requests'}
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
                ? `No ${isPendingQueue ? 'pending' : 'approved'} requests match these filters`
                : isPendingQueue
                  ? 'No leave requests pending approval'
                  : 'No approved leave requests in this period'
            }
            description={
              hasActiveFilters
                ? 'Try a different employee or month, or clear filters to see the full queue.'
                : isPendingQueue
                  ? 'New leave requests that require your decision will appear in this queue.'
                  : 'Approved requests in your scope will appear here after decisions are recorded.'
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
                          className={`approval-row approval-row--summary${
                            isExpanded ? ' approval-row--expanded' : ''
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
                        </tr>

                        {isExpanded ? (
                          <tr className="approval-row__detail-row">
                            <td colSpan={7}>
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

                                {isPendingQueue ? (
                                  <>
                                    <label className="approval-row__comment field">
                                      <span className="label">Approver comment (optional)</span>
                                      <input
                                        type="text"
                                        value={comments[item.id] ?? ''}
                                        onChange={(event) => setCommentFor(item.id, event.target.value)}
                                        placeholder="Shared with the employee after your decision"
                                        disabled={busy}
                                        maxLength={500}
                                      />
                                    </label>

                                    <div className="approval-row__actions">
                                      <button
                                        type="button"
                                        className="btn btn-primary"
                                        disabled={busy}
                                        onClick={() => handleDecision(item.id, 'approve')}
                                      >
                                        {busy ? 'Submitting…' : 'Approve'}
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-danger"
                                        disabled={busy}
                                        onClick={() => handleDecision(item.id, 'reject')}
                                      >
                                        Decline
                                      </button>
                                    </div>
                                  </>
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
    </div>
  );
}
