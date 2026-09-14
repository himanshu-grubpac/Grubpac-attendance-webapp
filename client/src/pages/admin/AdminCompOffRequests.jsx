import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatISTDate, formatISTDateTime, getISTDateInputValue } from '../../utils/datetime.js';
import { compOffApi, getErrorMessage } from '../../services/api.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useActionPopup } from '../../context/ActionPopupContext.jsx';
import LeaveDecisionModal from './LeaveDecisionModal.jsx';
import RequestsTabs from '../../components/RequestsTabs.jsx';

const QUEUE_SIZE = 20;

// Fallback only: the popup countdown prefers the server-authoritative
// `decisionUndoExpiresAt` (decision/assessment windows are ~15s).
const DECISION_UNDO_MS = 15000;
const PENDING_SETTLE_POLL_MS = 5000;
const MAX_SETTLE_POLLS = 24;

const COMP_OFF_STATUS_TONE = {
  pending: 'badge-warning',
  approved: 'badge-info',
  worked: 'badge-primary',
  assessed: 'badge-success',
  rejected: 'badge-muted',
  lapsed: 'badge-muted',
  cancelled: 'badge-muted',
};

function statusLabel(status) {
  if (status === 'worked') return 'Awaiting assessment';
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
}

function StatusToneBadge({ status }) {
  return (
    <span className={`badge ${COMP_OFF_STATUS_TONE[status] ?? 'badge-muted'}`.trim()}>
      {statusLabel(status)}
    </span>
  );
}

const AVATAR_COLORS = ['#e85d04', '#3b82f6', '#8b5cf6', '#059669', '#d946ef', '#0ea5e9'];

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

function compactDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  }).format(new Date(value));
}

function durationLabel(days) {
  const value = Number(days);
  if (!Number.isFinite(value)) return '—';
  if (value === 1) return '1 day';
  return `${value} days`;
}

function dateRangeLabel(item) {
  const start = formatISTDate(item.startDate);
  const end = formatISTDate(item.endDate);
  if (start === end) return start;
  return `${start} – ${end}`;
}

function compactDateRangeLabel(item) {
  const start = compactDate(item.startDate);
  const end = compactDate(item.endDate);
  if (start === end) return start;
  return `${start} – ${end}`;
}

const QUEUE_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'worked', label: 'Awaiting assessment' },
  { value: 'assessed', label: 'Assessed' },
  { value: 'closed', label: 'Closed' },
];

/** Parse the ?queue= deep link into a queue tab value. */
function queueFromParam(value) {
  if (value === 'assessment' || value === 'worked') return 'worked';
  if (value === 'approved' || value === 'upcoming') return 'approved';
  if (value === 'assessed') return 'assessed';
  if (value === 'closed') return 'closed';
  return 'pending';
}

function decisionUndoDurationMs(request) {
  const expiresAt = Date.parse(request?.decisionUndoExpiresAt ?? '');
  if (!Number.isFinite(expiresAt)) return DECISION_UNDO_MS;
  return Math.max(0, expiresAt - Date.now());
}

const ASSESSMENT_OPTIONS = [
  { value: 'completed', label: 'Work completed', credit: '+1' },
  { value: 'half', label: 'Half work done', credit: '+0.5' },
  { value: 'none', label: 'Work not completed', credit: '+0' },
];

const DAY_RATE_CREDIT = { completed: 1, half: 0.5, none: 0 };

function assessmentRateLabel(value) {
  return value === 'completed' ? 'Work completed' : value === 'half' ? 'Half work done' : 'Work not completed';
}

/** IST calendar day keys covered by a request, inclusive. */
function enumerateRequestDayKeys(item) {
  // API items carry ISO strings — Intl.DateTimeFormat throws on strings, so
  // coerce to Date first (and bail on anything unparseable).
  const toDateOrNull = (value) => {
    if (value == null || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const startDate = toDateOrNull(item?.startDate);
  const endDate = toDateOrNull(item?.endDate);
  if (!startDate || !endDate) return [];
  const start = getISTDateInputValue(startDate);
  const end = getISTDateInputValue(endDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '')) return [];
  const keys = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function defaultAssessmentValues(item) {
  const values = {};
  for (const dayKey of enumerateRequestDayKeys(item)) values[dayKey] = 'completed';
  return values;
}

function assessmentTotalCredit(values) {
  return Object.values(values ?? {}).reduce((sum, rate) => sum + (DAY_RATE_CREDIT[rate] ?? 0), 0);
}

function formatAssessDayKey(dayKey) {
  const date = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

export default function AdminCompOffRequests() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const { showActionPopup } = useActionPopup();

  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actingId, setActingId] = useState(null);
  const [expandedIds, setExpandedIds] = useState({});
  const [decisionModal, setDecisionModal] = useState({ open: false, item: null, comment: '' });
  const [assessment, setAssessment] = useState({ open: false, item: null, values: {}, comment: '' });
  const [queueStatus, setQueueStatus] = useState(() => queueFromParam(searchParams.get('queue')));

  const queueStatusRef = useRef(queueStatus);
  queueStatusRef.current = queueStatus;
  const pageRef = useRef(page);
  pageRef.current = page;

  const loadRequests = async ({ nextPage = 1, nextQueueStatus = queueStatusRef.current, quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    try {
      // 'closed' is a server-side virtual queue (rejected + lapsed +
      // cancelled) with real pagination — no client-side merging.
      const data = await compOffApi.list({
        scope: 'approvals',
        status: nextQueueStatus,
        page: nextPage,
        limit: QUEUE_SIZE,
      });
      setRequests(data.requests ?? []);
      setPagination(data.pagination ?? null);
      setPage(nextPage);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    loadRequests();
  }, []);

  useEffect(() => {
    setExpandedIds({});
  }, [page, queueStatus]);

  // Sync ?queue= deep links (dashboard button / notification links).
  useEffect(() => {
    const queueParam = searchParams.get('queue');
    if (!queueParam) return;
    const next = queueFromParam(queueParam);
    if (next !== queueStatusRef.current) {
      setQueueStatus(next);
      loadRequests({ nextPage: 1, nextQueueStatus: next });
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Email Take Action deep link (?decision=request&requestId=): auto-open the
  // decision popup, mirroring AdminLeaveApprovals. StrictMode-safe: no
  // "handled" ref guard (it would cancel the only fetch on dev remount and
  // the popup would never open) — only the latest run may open the modal.
  useEffect(() => {
    const decision = searchParams.get('decision');
    const requestId = searchParams.get('requestId');
    if (decision !== 'request' || !requestId) {
      return undefined;
    }

    let superseded = false;
    async function openDeepLinkedRequest() {
      // Prefer the already-loaded queue row so no fetch is needed.
      let target = requests.find((item) => item.id === requestId);
      if (!target) {
        try {
          const data = await compOffApi.get(requestId);
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
        showError('This comp off request is no longer pending.');
      }
      setSearchParams({}, { replace: true });
    }

    openDeepLinkedRequest();
    return () => {
      superseded = true;
    };
  }, [searchParams, requests, setSearchParams, showError]);

  // Settle polling while any visible row carries a staged (undoable) action.
  const settlePollsRef = useRef(0);
  useEffect(() => {
    if (!requests.some((item) => item.pendingAction)) {
      settlePollsRef.current = 0;
      return undefined;
    }
    if (settlePollsRef.current >= MAX_SETTLE_POLLS) return undefined;
    const timer = setInterval(() => {
      settlePollsRef.current += 1;
      loadRequests({ nextPage: pageRef.current, quiet: true });
    }, PENDING_SETTLE_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  function handleQueueStatusChange(value) {
    setQueueStatus(value);
    loadRequests({ nextPage: 1, nextQueueStatus: value });
  }

  function toggleExpanded(id) {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function handleDecision(id, decision) {
    const item = decisionModal.item || requests.find((r) => r.id === id);
    const note = (decisionModal.comment ?? '').trim();
    if (!note) {
      showError('A remark is required for this action.');
      return;
    }
    const payload = { comment: note };

    setActingId(id);
    setError('');
    try {
      const response = decision === 'reject'
        ? await compOffApi.reject(id, payload)
        : await compOffApi.approve(id, payload);
      const durationMs = decisionUndoDurationMs(response?.request);
      setDecisionModal({ open: false, item: null, comment: '' });
      if (durationMs > 0) {
        const decided = decision === 'reject' ? 'declined' : 'approved';
        showActionPopup({
          message: `Comp off request ${decided}. If done by mistake, click Undo to revert it.`,
          undoLabel: 'Undo',
          onUndo: async () => {
            try {
              await compOffApi.undo(id);
              showSuccess('Comp off decision undone.');
              await loadRequests({ nextPage: pageRef.current });
              setDecisionModal({ open: true, item, comment: note });
            } catch (err) {
              showError(getErrorMessage(err));
              await loadRequests({ nextPage: pageRef.current });
            }
          },
          durationMs,
        });
      } else {
        showSuccess(`Comp off request ${decision === 'reject' ? 'declined' : 'approved'}.`);
      }
      await loadRequests({ nextPage: pageRef.current });
    } catch (err) {
      showError(getErrorMessage(err));
      // A 409 race means the row changed underneath us — resync.
      await loadRequests({ nextPage: pageRef.current });
    } finally {
      setActingId(null);
    }
  }



  async function submitAssessment() {
    const item = assessment.item;
    if (!item) return;
    const remark = (assessment.comment ?? '').trim();
    if (!remark) {
      setError('A remark is required to record the assessment.');
      return;
    }
    setActingId(item.id);
    setError('');
    try {
      const payload = {
        assessments: enumerateRequestDayKeys(item).map((dayKey) => ({
          date: dayKey,
          assessment: assessment.values?.[dayKey] ?? 'completed',
        })),
        comment: remark,
      };
      const response = await compOffApi.assess(item.id, payload);
      const durationMs = decisionUndoDurationMs(response?.request);
      setAssessment({ open: false, item: null, values: {}, comment: '' });
      if (durationMs > 0) {
        showActionPopup({
          message: 'Assessment recorded. If done by mistake, click Undo to revert it.',
          undoLabel: 'Undo',
          onUndo: async () => {
            try {
              await compOffApi.undoAssess(item.id);
              showSuccess('Comp off assessment undone.');
              await loadRequests({ nextPage: pageRef.current });
            } catch (err) {
              showError(getErrorMessage(err));
              await loadRequests({ nextPage: pageRef.current });
            }
          },
          durationMs,
        });
      } else {
        showSuccess('Comp off assessment recorded.');
      }
      await loadRequests({ nextPage: pageRef.current });
    } catch (err) {
      showError(getErrorMessage(err));
      await loadRequests({ nextPage: pageRef.current });
    } finally {
      setActingId(null);
    }
  }

  const pageDays = useMemo(
    () => requests.reduce((sum, item) => sum + (Number(item.days) || 0), 0),
    [requests],
  );

  const emptyCopy = {
    pending: ['No comp off requests pending approval', 'Requests to work weekends/holidays will appear here.'],
    worked: ['No work awaiting assessment', 'Approved requests become assessable after the employee checks out on the day.'],
    assessed: ['No assessed requests', 'Completed assessments appear here with their granted credit.'],
    closed: ['No closed requests', 'Rejected, lapsed, and cancelled requests appear here.'],
  }[queueStatus] ?? ['Nothing here', ''];

  return (
    <div className="page page--approvals">
      <RequestsTabs
        active="compoff"
        onSelect={(tab) => navigate(tab === 'compoff' ? '/admin/leave/comp-off' : `/admin/leave/approvals${tab === 'leave' ? '' : `?tab=${tab}`}`)}
      />
      <section className="approvals-stats" aria-label="Comp off queue summary">
        <div className="approvals-stats__grid">
          <article className="approvals-stat card approvals-stat--info">
            <div className="approvals-stat__head">
              <span className="approvals-stat__label">{queueStatus === 'worked' ? 'AWAITING ASSESSMENT' : 'REQUESTS IN QUEUE'}</span>
              <span className="approvals-stat__icon" aria-hidden="true">◈</span>
            </div>
            <strong className="approvals-stat__value">{loading ? '—' : (pagination?.total ?? 0)}</strong>
            <p className="approvals-stat__hint muted small">{queueStatus === 'closed' ? 'Rejected + lapsed + cancelled' : 'Requests in your approval scope'}</p>
          </article>
          <article className="approvals-stat card approvals-stat--info">
            <div className="approvals-stat__head">
              <span className="approvals-stat__label">WORK DAYS</span>
              <span className="approvals-stat__icon" aria-hidden="true">▤</span>
            </div>
            <strong className="approvals-stat__value">{loading ? '—' : pageDays}</strong>
            <p className="approvals-stat__hint muted small">Total days on this page</p>
          </article>
        </div>
      </section>

      <section className="approvals-panel card card--table" aria-label="Comp off requests">
        <div className="approvals-toolbar card__toolbar">
          <div className="approvals-toolbar__filters filter-bar">
            <label className="field-inline filter-bar__field approvals-toolbar__field">
              <span className="label">Queue</span>
              <SelectField
                value={queueStatus}
                onChange={handleQueueStatusChange}
                options={QUEUE_OPTIONS}
                aria-label="Comp off queue filter"
              />
            </label>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title={emptyCopy[0]}
            description={emptyCopy[1]}
          />
        ) : (
          <>
            <div className="table-wrap approvals-table-wrap">
              <table className="table data-table approvals-table">
                <thead>
                  <tr>
                    <th className="approvals-table__expand-col" aria-label="Expand row" />
                    <th scope="col" className="approvals-table__col-row-num">#</th>
                    <th>Employee</th>
                    <th>Period</th>
                    <th>Days</th>
                    <th>Status</th>
                    <th className="approvals-table__actions-col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((item, index) => {
                    const rowNumber = (page - 1) * (pagination?.limit ?? QUEUE_SIZE) + index + 1;
                    const busy = actingId === item.id;
                    const isExpanded = Boolean(expandedIds[item.id]);
                    const detailId = `comp-off-detail-${item.id}`;
                    const initials = getInitials(item.userName);
                    const color = avatarColor(item.userName);
                    const staged = item.pendingAction;
                    const isPendingQueue = queueStatus === 'pending';
                    const isAssessmentQueue = queueStatus === 'worked';
                    const mobileSubline = [
                      compactDateRangeLabel(item),
                      durationLabel(item.days),
                    ]
                      .map((part) => String(part ?? '').trim())
                      .filter(Boolean)
                      .join(' · ');
                    const mobileAction = isPendingQueue ? 'review' : isAssessmentQueue ? 'assess' : null;

                    return (
                      <Fragment key={item.id}>
                        <tr
                          className={`approval-row approval-row--summary${isExpanded ? ' approval-row--expanded' : ''}`}
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          aria-controls={detailId}
                          onClick={() => toggleExpanded(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleExpanded(item.id);
                            }
                          }}
                        >
                          {/* Mobile card (≤720px): identity, subline, status, action */}
                          <td className="approval-card-cell" colSpan={7}>
                            <div className="approval-card">
                              <button
                                type="button"
                                className="approval-row__toggle approval-card__toggle"
                                aria-expanded={isExpanded}
                                aria-controls={detailId}
                                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.userName || 'employee'} request`}
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
                                <StatusToneBadge status={item.status} />
                                {mobileAction && !isExpanded && !staged ? (
                                  mobileAction === 'review' ? (
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm btn--compact approval-card__action"
                                      disabled={busy}
                                      onClick={() => toggleExpanded(item.id)}
                                    >
                                      Review
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm btn--compact approval-card__action"
                                      disabled={busy}
                                      onClick={() => setAssessment({ open: true, item, values: defaultAssessmentValues(item), comment: '' })}
                                    >
                                      Assess
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
                              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.userName || 'employee'} request`}
                              onClick={() => toggleExpanded(item.id)}
                            >
                              <span className={`approval-row__chevron${isExpanded ? ' is-open' : ''}`} aria-hidden="true">▼</span>
                            </button>
                          </td>
                          <td data-label="#" className="approvals-table__row-num approval-desktop-cell" aria-label={`Row ${rowNumber}`}>
                            {rowNumber}
                          </td>
                          <td data-label="Employee" className="approval-row__employee-cell approval-desktop-cell">
                            <div className="approval-row__identity">
                              <span className="approval-row__avatar" style={{ backgroundColor: color }} aria-hidden="true">
                                {initials}
                              </span>
                              <span className="approval-row__name">{item.userName || 'Employee'}</span>
                            </div>
                          </td>
                          <td data-label="Period" className="approval-row__dates muted approval-desktop-cell" title={dateRangeLabel(item)}>
                            {compactDateRangeLabel(item)}
                          </td>
                          <td data-label="Days" className="approval-row__days approval-desktop-cell">
                            {durationLabel(item.days)}
                          </td>
                          <td data-label="Status" className="approval-row__status approval-desktop-cell">
                            <StatusToneBadge status={item.status} />
                          </td>
                          {!isExpanded ? (
                            <td
                              className="approvals-table__actions-cell approval-desktop-cell"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {isPendingQueue && (
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={busy || Boolean(staged)}
                                  onClick={() => toggleExpanded(item.id)}
                                >
                                  Review
                                </button>
                              )}
                              {isAssessmentQueue && (
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={busy || Boolean(staged)}
                                  onClick={() => setAssessment({ open: true, item, values: defaultAssessmentValues(item), comment: '' })}
                                >
                                  Assess
                                </button>
                              )}
                            </td>
                          ) : (
                            <td className="approvals-table__actions-cell approval-desktop-cell" />
                          )}
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
                                {item.createdAt ? (
                                  <p className="approval-row__submitted muted small">
                                    Submitted {formatISTDateTime(item.createdAt)}
                                  </p>
                                ) : null}
                                {item.decidedAt ? (
                                  <p className="approval-row__submitted muted small">
                                    {item.status === 'assessed' ? 'Assessed' : 'Decided'} {formatISTDateTime(item.decidedAt)}
                                    {item.approverName ? ` by ${item.approverName}` : ''}
                                  </p>
                                ) : null}

                                <dl className="approval-row__meta">
                                  <div className="approval-row__meta-item">
                                    <dt>Comp off period</dt>
                                    <dd>{dateRangeLabel(item)}</dd>
                                  </div>
                                  <div className="approval-row__meta-item">
                                    <dt>Days</dt>
                                    <dd>{durationLabel(item.days)}</dd>
                                  </div>
                                  {item.creditedDays > 0 ? (
                                    <div className="approval-row__meta-item">
                                      <dt>Credit granted</dt>
                                      <dd>+{item.creditedDays} day(s)</dd>
                                    </div>
                                  ) : null}
                                  {Array.isArray(item.assessmentBreakdown) && item.assessmentBreakdown.length > 1 ? (
                                    <div className="approval-row__meta-item">
                                      <dt>Per-day assessment</dt>
                                      <dd>{item.assessmentBreakdown.map((entry) => `${entry.dayKey}: ${assessmentRateLabel(entry.assessment)} (+${entry.credit})`).join(' · ')}</dd>
                                    </div>
                                  ) : null}
                                </dl>

                                {item.reason ? (
                                  <div className="approval-row__reason">
                                    <span className="label">Request reason</span>
                                    <p>{item.reason}</p>
                                  </div>
                                ) : null}

                                {item.comment ? (
                                  <div className="approval-row__reason">
                                    <span className="label">Remarks</span>
                                    <p>{item.comment}</p>
                                  </div>
                                ) : null}

                                {staged ? (
                                  <div
                                    className="approval-row__pending-decision"
                                    style={{ padding: '8px 12px', marginBottom: 8, background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 6, fontSize: 13, color: '#92400e' }}
                                  >
                                    A <strong>{statusLabel(staged)}</strong> action is pending. Undo it first before acting again.
                                  </div>
                                ) : null}

                                {isPendingQueue && !staged ? (
                                  <div className="approval-row__actions">
                                    <button
                                      type="button"
                                      className="btn btn-primary"
                                      disabled={busy}
                                      onClick={() => setDecisionModal({ open: true, item, comment: '' })}
                                    >
                                      Take action
                                    </button>
                                  </div>
                                ) : null}

                                {isAssessmentQueue && !staged ? (
                                  <div className="approval-row__actions">
                                    <button
                                      type="button"
                                      className="btn btn-primary"
                                      disabled={busy}
                                      onClick={() => setAssessment({ open: true, item, values: defaultAssessmentValues(item), comment: '' })}
                                    >
                                      Assess work
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

            <PaginationBar
              pagination={pagination}
              onPageChange={(nextPage) => loadRequests({ nextPage })}
            />
          </>
        )}
      </section>

      {assessment.open && assessment.item ? (
        <div className="modal__backdrop" onClick={() => setAssessment({ open: false, item: null, values: {}, comment: '' })}>
          <div
            className="modal modal--compact"
            role="dialog"
            aria-modal="true"
            aria-label="Assess comp off work"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal__body">
              <h3 className="modal__title">Assess comp off work</h3>
              <p className="muted small">
                {assessment.item.userName || 'Employee'} worked {durationLabel(assessment.item.days)} on{' '}
                {dateRangeLabel(assessment.item)}. Rate each day below — credit totals live and is granted after the undo window.
              </p>
              {enumerateRequestDayKeys(assessment.item).map((dayKey) => (
                <div key={dayKey} className="assessment-day">
                  <span className="label">{formatAssessDayKey(dayKey)}</span>
                  <div className="assessment-options assessment-options--inline" role="radiogroup" aria-label={`Assessment for ${dayKey}`}>
                    {ASSESSMENT_OPTIONS.map((option) => (
                      <label key={option.value} className="assessment-option assessment-option--chip">
                        <input
                          type="radio"
                          name={`assessment-${assessment.item.id}-${dayKey}`}
                          value={option.value}
                          checked={(assessment.values?.[dayKey] ?? 'completed') === option.value}
                          onChange={() => setAssessment((prev) => ({
                            ...prev,
                            values: { ...(prev.values ?? {}), [dayKey]: option.value },
                          }))}
                        />
                        <span>
                          <strong>{option.label}</strong>
                          <span className="muted small"> {option.credit} day</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <p className="assessment-total">
                Total credit: <strong>+{assessmentTotalCredit(assessment.values)} day(s)</strong>
              </p>
              <label className="form-grid__full">
                <span className="label">Remark <span aria-hidden="true" style={{ color: '#dc2626' }}>*</span></span>
                <textarea
                  rows={2}
                  value={assessment.comment}
                  onChange={(event) => setAssessment((prev) => ({ ...prev, comment: event.target.value }))}
                  placeholder="Explain the assessment (required)"
                  aria-label="Assessment remark (required)"
                />
              </label>
              {error ? <div className="alert alert--error">{error}</div> : null}
            </div>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setAssessment({ open: false, item: null, values: {}, comment: '' })}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={actingId === assessment.item.id || !(assessment.comment ?? '').trim()}
                onClick={submitAssessment}
              >
                {actingId === assessment.item.id ? 'Saving…' : 'Record assessment'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <LeaveDecisionModal
        open={decisionModal.open}
        item={decisionModal.item}
        initialComment={decisionModal.comment}
        busy={actingId === decisionModal.item?.id}
        onCommentChange={(value) => setDecisionModal((prev) => ({ ...prev, comment: value }))}
        onApprove={() => handleDecision(decisionModal.item.id, 'approve')}
        onReject={() => handleDecision(decisionModal.item.id, 'reject')}
        onCancel={() => setDecisionModal({ open: false, item: null, comment: '' })}
      />
    </div>
  );
}
