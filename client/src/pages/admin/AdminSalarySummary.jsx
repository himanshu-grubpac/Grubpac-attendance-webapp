import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getErrorMessage, salaryApi } from '../../services/api.js';
import { formatINRCurrency, getISTMonthInputValue } from '../../utils/datetime.js';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';

const PAGE_SIZE = 20;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatMonthLabel(month) {
  if (!month) return '';
  const [year, monthNum] = month.split('-');
  const date = new Date(Number(year), Number(monthNum) - 1, 1);
  return date.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export default function AdminSalarySummary() {
  const [month, setMonth] = useState(getISTMonthInputValue());
  const [summaries, setSummaries] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const { setMeta } = usePageMetaContext();

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError('');
    try {
      const blob = await salaryApi.exportSummary(month);
      downloadBlob(blob, `salary-summary-${month}.xlsx`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setExporting(false);
    }
  }, [month]);

  useEffect(() => {
    setMeta({
      actions: (
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleExport}
          disabled={exporting}
        >
          {exporting ? 'Exporting…' : 'Export Excel'}
        </button>
      ),
    });
  }, [exporting, handleExport, setMeta]);

  useEffect(() => {
    setLoading(true);
    setError('');
    setSelectedId(null);
    salaryApi
      .listSummaries(month)
      .then((data) => setSummaries(data.summaries ?? []))
      .catch((err) => {
        setSummaries([]);
        setError(getErrorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => {
    setPage(1);
  }, [month, debouncedSearch]);

  const filtered = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return summaries;
    return summaries.filter(
      (item) =>
        item.userName?.toLowerCase().includes(query) ||
        item.employeeCode?.toLowerCase().includes(query),
    );
  }, [summaries, debouncedSearch]);

  const aggregates = useMemo(() => {
    const withEstimate = summaries.filter((item) => item.payableEstimate != null);
    return {
      totalPayable: withEstimate.reduce((sum, item) => sum + item.payableEstimate, 0),
      employeeCount: withEstimate.length,
      totalLop: summaries.reduce((sum, item) => sum + (item.lopDays ?? 0), 0),
      workingDays: summaries[0]?.workingDaysInMonth ?? null,
    };
  }, [summaries]);

  const pagination = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / PAGE_SIZE) || 1,
    }),
    [filtered.length, page],
  );

  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const selectedSummary = useMemo(
    () => summaries.find((item) => item.userId === selectedId) ?? null,
    [summaries, selectedId],
  );

  return (
    <div className="page">
      <div className="card-grid card-grid--stats">
        <div className="card stat-card">
          <span className="stat-card__label">Total pay estimate</span>
          <strong className="stat-card__value">
            {loading ? '…' : formatINRCurrency(aggregates.totalPayable)}
          </strong>
          <span className="muted small">{formatMonthLabel(month)} · estimate only</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Employees in estimate</span>
          <strong className="stat-card__value">{loading ? '…' : aggregates.employeeCount}</strong>
          <span className="muted small">Salary configured for month</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Total LOP days</span>
          <strong className="stat-card__value">
            {loading ? '…' : aggregates.totalLop.toFixed(1)}
          </strong>
          <span className="muted small">Unpaid leave estimate</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Working days</span>
          <strong className="stat-card__value">
            {loading ? '…' : aggregates.workingDays ?? '—'}
          </strong>
          <span className="muted small">Mon–Fri minus holidays</span>
        </div>
      </div>

      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline filter-bar__field">
            <span className="label">Month (IST)</span>
            <input
              className="input"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <label className="field-inline filter-bar__field filter-bar__search">
            <span className="label">Search</span>
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or employee code…"
              ariaLabel="Search salary estimates"
            />
          </label>
        </div>

        {error && <div className="alert alert--error">{error}</div>}

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.payroll}
            title="No pay estimates"
            description={
              debouncedSearch
                ? 'No employees match your search for this month.'
                : 'Estimates appear once employees have salary configured and attendance recorded.'
            }
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive table-wrap--fit">
              <table className="table">
                <colgroup>
                  <col style={{ width: '28%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '16%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Salary</th>
                    <th>Present</th>
                    <th>LOP</th>
                    <th>Pay estimate</th>
                    <th className="cell-actions-col--text">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((item) => (
                    <tr
                      key={item.userId}
                      className={selectedId === item.userId ? 'table-row--selected' : undefined}
                    >
                      <td data-label="Employee">
                        <Link
                          to={`/admin/users/${item.userId}`}
                          className="table-link cell-ellipsis"
                          title={item.userName}
                        >
                          {item.userName}
                        </Link>
                        {item.employeeCode && (
                          <div className="muted small cell-ellipsis" title={item.employeeCode}>
                            {item.employeeCode}
                          </div>
                        )}
                      </td>
                      <td data-label="Salary">{formatINRCurrency(item.monthlySalary)}</td>
                      <td data-label="Present">{item.presentDays}</td>
                      <td data-label="LOP">{item.lopDays}</td>
                      <td data-label="Pay estimate">{formatINRCurrency(item.payableEstimate)}</td>
                      <td data-label="Actions" className="cell-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            setSelectedId((current) =>
                              current === item.userId ? null : item.userId,
                            )
                          }
                        >
                          {selectedId === item.userId ? 'Hide' : 'Details'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar pagination={pagination} onPageChange={setPage} />
          </>
        )}
      </div>

      {selectedSummary && (
        <div className="card">
          <dl className="detail-list detail-list--grid">
            <div>
              <dt>Employee</dt>
              <dd>{selectedSummary.userName}</dd>
            </div>
            <div>
              <dt>Monthly salary (INR)</dt>
              <dd>{formatINRCurrency(selectedSummary.monthlySalary)}</dd>
            </div>
            <div>
              <dt>Working days</dt>
              <dd>{selectedSummary.workingDaysInMonth}</dd>
            </div>
            <div>
              <dt>Present days</dt>
              <dd>{selectedSummary.presentDays}</dd>
            </div>
            <div>
              <dt>Paid leave days</dt>
              <dd>{selectedSummary.paidLeaveDays}</dd>
            </div>
            <div>
              <dt>Payable days</dt>
              <dd>{selectedSummary.payableDays}</dd>
            </div>
            <div>
              <dt>LOP / unpaid estimate</dt>
              <dd>{selectedSummary.lopDays}</dd>
            </div>
            <div>
              <dt>Per day (INR)</dt>
              <dd>{formatINRCurrency(selectedSummary.perDaySalary)}</dd>
            </div>
            <div>
              <dt>Payable estimate (INR)</dt>
              <dd>{formatINRCurrency(selectedSummary.payableEstimate)}</dd>
            </div>
          </dl>
          <p className="card-footnote muted small">
            Monthly pay estimate based on attendance and approved leave — not a payroll run.
          </p>
        </div>
      )}
    </div>
  );
}
