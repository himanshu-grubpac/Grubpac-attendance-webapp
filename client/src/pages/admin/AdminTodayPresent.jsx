import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import { useTableColumns } from '../../hooks/useTableColumns.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { mergeAppendUnique } from '../../utils/listMerge.js';
import ColumnEditorPanel from '../../components/ColumnEditorPanel.jsx';

const TODAY_PRESENT_TABLE_KEY = 'attendanceToday';
const TODAY_PRESENT_PAGE_SIZE = 25;

// Keys must exist in the backend attendanceToday registry (validateColumns
// rejects unknown keys on save) — `name` renders as the Employee column.
const TODAY_PRESENT_COLUMNS = [
  { key: 'name', label: 'Employee', always: true },
  { key: 'department', label: 'Department' },
  { key: 'role', label: 'Role' },
  { key: 'status', label: 'Status' },
];

const TODAY_PRESENT_DEFAULT_COLUMNS = ['name', 'department', 'role', 'status'];
const EMPTY_SUMMARY = { present: 0, absent: 0, onLeave: 0, total: 0 };

function isPresent(member) {
  return member.status === 'checked_in' || member.status === 'wfh';
}

function isOnLeave(member) {
  return member.status === 'on_leave';
}

export default function AdminTodayPresent() {
  const { setMeta } = usePageMetaContext();
  const [teamStatus, setTeamStatus] = useState([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const debouncedSearch = useDebouncedValue(query, 350);
  const loadMoreRef = useRef(null);
  const requestKeyRef = useRef('');
  const skipDebouncedSearchRef = useRef(true);
  const {
    visibleColumns,
    columnsLoading,
    columnsError,
    editorOpen,
    setEditorOpen,
    isColumnVisible,
    handleColumnToggle,
  } = useTableColumns({
    tableKey: TODAY_PRESENT_TABLE_KEY,
    allColumns: TODAY_PRESENT_COLUMNS,
    defaultVisible: TODAY_PRESENT_DEFAULT_COLUMNS,
  });

  useEffect(() => {
    setMeta({
      title: 'Today Present',
      subtitle: 'Live attendance status for all team members',
    });
  }, [setMeta]);

  const load = useCallback(async ({ search = '', nextPage = 1, append = false } = {}) => {
    const requestKey = `${search}|${nextPage}|${append}`;
    requestKeyRef.current = requestKey;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const params = { page: nextPage, limit: TODAY_PRESENT_PAGE_SIZE };
      if (search.trim()) params.search = search.trim();
      const data = await adminApi.getTeamTodayStatus(params);
      if (requestKeyRef.current !== requestKey) return;
      setTeamStatus((current) => {
        const fresh = data.teamStatus ?? [];
        if (!append) return fresh;
        // Dedupe by userId: newly registered members can shift offsets
        // between page fetches, returning overlapping rows.
        return mergeAppendUnique(current, fresh, (item) => item?.userId);
      });
      setSummary(data.summary ?? EMPTY_SUMMARY);
      setPagination(data.pagination ?? null);
      setPage(data.pagination?.page ?? nextPage);
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setError(getErrorMessage(err));
      if (!append) {
        setTeamStatus([]);
        setSummary(EMPTY_SUMMARY);
        setPagination(null);
      }
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    load({ search: '', nextPage: 1 });
  }, [load]);

  useEffect(() => {
    if (skipDebouncedSearchRef.current) {
      skipDebouncedSearchRef.current = false;
      return;
    }
    load({ search: debouncedSearch, nextPage: 1 });
  }, [debouncedSearch, load]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || loading || loadingMore) return;
        if (!pagination || page >= pagination.totalPages) return;
        load({ search: debouncedSearch, nextPage: page + 1, append: true });
      },
      { rootMargin: '120px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [debouncedSearch, load, loading, loadingMore, page, pagination]);

  return (
    <div className="page page--admin-today-present">
      <section className="today-present-summary" aria-label="Today summary">
        <div className="today-present-summary__card today-present-summary__card--present">
          <span className="today-present-summary__value">{summary.present}</span>
          <span className="today-present-summary__label">Present</span>
        </div>
        <div className="today-present-summary__card today-present-summary__card--absent">
          <span className="today-present-summary__value">{summary.absent}</span>
          <span className="today-present-summary__label">Absent</span>
        </div>
        <div className="today-present-summary__card today-present-summary__card--leave">
          <span className="today-present-summary__value">{summary.onLeave}</span>
          <span className="today-present-summary__label">On Leave</span>
        </div>
        <div className="today-present-summary__card">
          <span className="today-present-summary__value">{summary.total}</span>
          <span className="today-present-summary__label">Total</span>
        </div>
      </section>

      <section className="card card--table" aria-label="Team present status">
        <div className="card__toolbar" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <h2 className="card__title">Team Attendance Today</h2>
          <div className="search-input" style={{ maxWidth: '20rem' }}>
            <svg className="search-input__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              className="input search-input__field"
              placeholder="Search name, code, department, role"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search team members"
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditorOpen(true)}
            >
              Edit columns
            </button>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}
        {columnsError ? <div className="alert alert--error">{columnsError}</div> : null}

        {loading ? (
          <div className="employees-table-skeleton" aria-busy="true" aria-label="Loading team status">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive">
              <table className="table data-table today-present-table">
                <thead>
                  <tr>
                    <th scope="col" className="today-present-table__col-num">#</th>
                    {isColumnVisible('name') && <th scope="col">Employee</th>}
                    {isColumnVisible('department') && <th scope="col">Department</th>}
                    {isColumnVisible('role') && <th scope="col">Role</th>}
                    {isColumnVisible('status') && <th scope="col">Status</th>}
                  </tr>
                </thead>
                <tbody>
                  {teamStatus.length === 0 ? (
                    <tr>
                      <td colSpan={visibleColumns.length + 1} className="muted small today-present-table__empty">
                        {query.trim() ? 'No team members match this search.' : 'No team members found.'}
                      </td>
                    </tr>
                  ) : (
                    teamStatus.map((member, index) => {
                      const present = isPresent(member);
                      const onLeave = !present && isOnLeave(member);
                      // Note: kept as if/else (not nested ternary) — oxlint's
                      // parser rejects nested ternaries with a false error.
                      let badgeTone = 'absent';
                      let badgeLabel = 'Absent';
                      if (present) {
                        badgeTone = 'present';
                        badgeLabel = 'Present';
                      } else if (onLeave) {
                        badgeTone = 'leave';
                        badgeLabel = 'On Leave';
                      }
                      // Fall back to a positional key: rows without a userId must
                      // never share a key (or mergeAppendUnique would drop them).
                      const rowKey = member.userId ?? `row-${index}`;
                      return (
                        <tr key={rowKey}>
                          <td className="today-present-table__col-num">{index + 1}</td>
                          {isColumnVisible('name') && (
                            <td data-label="Employee" className="today-present-table__employee">
                              <span className="today-present-table__name">
                                {member.firstName ||
                                  member.name?.split(' ')[0] ||
                                  'Team Member'}
                              </span>
                              {member.employeeCode && (
                                <span className="today-present-table__code muted small">
                                  {' '}
                                  ({member.employeeCode})
                                </span>
                              )}
                            </td>
                          )}
                          {isColumnVisible('department') && <td data-label="Department">{member.department ?? '—'}</td>}
                          {isColumnVisible('role') && <td data-label="Role">{member.roleName ?? '—'}</td>}
                          {isColumnVisible('status') && (
                            <td data-label="Status">
                              <span
                                className={`today-present-table__badge today-present-table__badge--${badgeTone}`}
                              >
                                {badgeLabel}
                              </span>
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {pagination && teamStatus.length > 0 ? (
              <p className="employees-scroll-hint muted small" role="status">
                Showing {teamStatus.length} of {pagination.total} team members
                {loadingMore ? ' · Loading more…' : ''}
              </p>
            ) : null}
            <div ref={loadMoreRef} className="employees-scroll-sentinel" aria-hidden="true" />
          </>
        )}
      </section>

      <ColumnEditorPanel
        open={editorOpen}
        columns={TODAY_PRESENT_COLUMNS}
        isColumnVisible={isColumnVisible}
        onToggle={handleColumnToggle}
        loading={columnsLoading}
        onClose={() => setEditorOpen(false)}
      />
    </div>
  );
}
