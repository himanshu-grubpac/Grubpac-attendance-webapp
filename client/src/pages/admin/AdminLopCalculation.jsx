import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getErrorMessage, salaryApi } from '../../services/api.js';
import { formatINRCurrency, formatISTDate } from '../../utils/datetime.js';
import {
  buildSalaryMonthOptions,
  buildSalaryYearOptions,
  clampMonthPartForYear,
  clampYearToCurrentIst,
  formatMonthLabel,
  getTodayMonthIst,
} from '../../components/MonthField.jsx';
import DownloadProgressModal from '../../components/DownloadProgressModal.jsx';
import { getTodayIstValue } from '../../components/DateField.jsx';
import SelectField from '../../components/SelectField.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import LopDetailModal from '../../components/LopDetailModal.jsx';
import './AdminLopCalculation.css';

const PAGE_SIZE = 20;

function parseMonthFilterValue(value) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = getTodayMonthIst().split('-');
    return { year, month };
  }
  const [year, month] = value.split('-');
  return { year, month };
}

function toMonthFilterValue(year, month) {
  return `${year}-${month}`;
}

/** Matches server resolveSalaryAsOfDate defaults for MTD cutoff. */
function resolveAsOfForMonth(month) {
  const today = getTodayIstValue();
  const [year, monthPart] = month.split('-');
  const monthStart = `${year}-${monthPart}-01`;
  const lastDay = new Date(Date.UTC(Number(year), Number(monthPart), 0)).getUTCDate();
  const monthEnd = `${year}-${monthPart}-${String(lastDay).padStart(2, '0')}`;

  if (today >= monthStart && today <= monthEnd) {
    return today;
  }
  if (today > monthEnd) {
    return monthEnd;
  }
  return monthStart;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function TableSkeleton() {
  return (
    <div className="salary-table-skeleton" aria-busy="true" aria-label="Loading LOP summaries">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

export default function AdminLopCalculation() {
  const initialMonth = useMemo(() => {
    const { year, month } = parseMonthFilterValue(getTodayMonthIst());
    const clampedYear = clampYearToCurrentIst(year);
    return {
      year: clampedYear,
      month: clampMonthPartForYear(clampedYear, month),
    };
  }, []);
  const [yearFilter, setYearFilter] = useState(initialMonth.year);
  const [monthPartFilter, setMonthPartFilter] = useState(initialMonth.month);
  const yearOptions = useMemo(() => buildSalaryYearOptions(), [yearFilter, monthPartFilter]);
  const monthOptions = useMemo(() => buildSalaryMonthOptions(yearFilter), [yearFilter]);
  const month = useMemo(
    () => toMonthFilterValue(yearFilter, monthPartFilter),
    [yearFilter, monthPartFilter],
  );
  const monthLabel = useMemo(() => formatMonthLabel(month), [month]);
  const asOf = useMemo(() => resolveAsOfForMonth(month), [month]);

  const [employees, setEmployees] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [responseAsOfDate, setResponseAsOfDate] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadModal, setDownloadModal] = useState({
    open: false,
    subtitle: '',
    error: '',
  });
  const isDownloading = downloadModal.open;
  const [detailTarget, setDetailTarget] = useState(null);
  const [detailMonth, setDetailMonth] = useState(null);

  const handleYearChange = useCallback((value) => {
    const nextYear = clampYearToCurrentIst(value);
    setYearFilter(nextYear);
    setMonthPartFilter((currentMonth) => clampMonthPartForYear(nextYear, currentMonth));
  }, []);

  const loadSummaries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await salaryApi.listLopSummaries({
        month,
        asOf,
        page,
        limit: PAGE_SIZE,
      });
      setEmployees(data.employees ?? []);
      setResponseAsOfDate(data.asOfDate ?? asOf);
      setPagination(
        data.pagination ?? {
          page: 1,
          limit: PAGE_SIZE,
          total: 0,
          totalPages: 1,
        },
      );
    } catch (err) {
      setEmployees([]);
      setResponseAsOfDate(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [asOf, month, page]);

  useEffect(() => {
    if (detailTarget) {
      return;
    }
    loadSummaries();
  }, [detailTarget, loadSummaries]);

  useEffect(() => {
    setPage(1);
  }, [month]);

  const closeDownloadModal = useCallback(() => {
    setDownloadModal({ open: false, subtitle: '', error: '' });
  }, []);

  const handleBulkExport = useCallback(async () => {
    setDownloadModal({
      open: true,
      subtitle: `Bulk LOP report for ${monthLabel}`,
      error: '',
    });
    setError('');
    try {
      const blob = await salaryApi.exportLopBulk({ month, asOf });
      downloadBlob(blob, `lop-bulk-${month}.xlsx`);
      closeDownloadModal();
    } catch (err) {
      const message = getErrorMessage(err);
      setDownloadModal((current) => ({ ...current, error: message }));
      setError(message);
    }
  }, [asOf, closeDownloadModal, month, monthLabel]);

  const handleRowDownload = useCallback(
    async (row) => {
      setDownloadModal({
        open: true,
        subtitle: `LOP log for ${row.name} — ${monthLabel}`,
        error: '',
      });
      setError('');
      try {
        const blob = await salaryApi.exportLopSingle(row.userId, { month, asOf });
        const safeName = (row.name ?? 'employee').replace(/[^\w.-]+/g, '_');
        downloadBlob(blob, `lop-${safeName}-${month}.xlsx`);
        closeDownloadModal();
      } catch (err) {
        const message = getErrorMessage(err);
        setDownloadModal((current) => ({ ...current, error: message }));
        setError(message);
      }
    },
    [asOf, closeDownloadModal, month, monthLabel],
  );

  const handleDetailMonthChange = useCallback((year, monthPart) => {
    const nextYear = clampYearToCurrentIst(year);
    setDetailMonth(toMonthFilterValue(nextYear, clampMonthPartForYear(nextYear, monthPart)));
  }, []);

  const openDetail = useCallback(
    (row) => {
      setDetailTarget({ userId: row.userId, name: row.name });
      setDetailMonth(month);
    },
    [month],
  );

  const closeDetail = useCallback(() => {
    setDetailTarget(null);
    setDetailMonth(null);
  }, []);

  const activeDetailMonth = detailMonth ?? month;
  const detailAsOf = useMemo(() => resolveAsOfForMonth(activeDetailMonth), [activeDetailMonth]);
  const detailYear = activeDetailMonth.split('-')[0];
  const detailMonthOptions = useMemo(() => buildSalaryMonthOptions(detailYear), [detailYear]);

  /** Server asOfDate after load; client asOf until first response — both from IST helpers, never hardcoded. */
  const viewingDateLabel = formatISTDate(responseAsOfDate ?? asOf);

  return (
    <div className="page page--salary">
      <p className="salary-disclaimer muted small">
        Month-to-date payable after loss of pay deductions, as of {viewingDateLabel}. Salary is
        spread across a fixed 30-day pool (monthly salary ÷ 30). Loss of pay applies only on
        working days (Monday to Friday minus holidays) for absent, half-day, or unpaid leave —
        weekends and holidays are paid. Loss of pay detail shows deductions only — no payable
        total on that screen.
      </p>

      <section className="salary-panel card card--table" aria-label="Salary calculation and LOP">
        <div className="salary-toolbar card__toolbar">
          <div className="salary-toolbar__filters filter-bar">
            <div className="filter-bar__field salary-toolbar__field salary-toolbar__field--period">
              <div className="salary-toolbar__period">
                <div className="field-inline">
                  <span className="label">Year</span>
                  <SelectField
                    value={yearFilter}
                    onChange={handleYearChange}
                    options={yearOptions}
                    aria-label="LOP year"
                    disabled={loading || isDownloading}
                  />
                </div>
                <div className="field-inline">
                  <span className="label">Month</span>
                  <SelectField
                    value={monthPartFilter}
                    onChange={setMonthPartFilter}
                    options={monthOptions}
                    aria-label="LOP month"
                    disabled={loading || isDownloading}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="salary-toolbar__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleBulkExport}
              disabled={isDownloading || loading}
            >
              Bulk download
            </button>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : employees.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.payroll}
            title="No employees with salary configured"
            description="Active employees with monthly salary appear here once salary is set for the selected month."
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive salary-table-wrap">
              <table className="table data-table salary-table salary-table--lop">
                <thead>
                  <tr>
                    <th scope="col" className="salary-table__col-row-num">
                      #
                    </th>
                    <th>Employee name</th>
                    <th className="salary-table__num">Monthly salary</th>
                    <th className="salary-table__num">Month-to-date payable</th>
                    <th className="cell-actions-col--text">Loss of Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((row, index) => {
                    const rowNumber = (pagination.page - 1) * pagination.limit + index + 1;

                    return (
                      <tr key={row.userId}>
                        <td
                          data-label="#"
                          className="salary-table__row-num"
                          aria-label={`Row ${rowNumber}`}
                        >
                          {rowNumber}
                        </td>
                        <td data-label="Employee name">
                          <Link
                            to={`/admin/users/${row.userId}`}
                            className="table-link cell-ellipsis salary-table__name"
                            title={row.name}
                          >
                            {row.name}
                          </Link>
                          {row.employeeCode ? (
                            <div className="muted small">{row.employeeCode}</div>
                          ) : null}
                        </td>
                        <td data-label="Monthly salary" className="salary-table__num">
                          {formatINRCurrency(row.totalSalary)}
                        </td>
                        <td data-label="Month-to-date payable" className="salary-table__num salary-table__net">
                          {formatINRCurrency(row.mtdPayable)}
                          {row.totalLopDeduction > 0 ? (
                            <div className="muted small">
                              Loss of pay till date −{formatINRCurrency(row.totalLopDeduction)}
                            </div>
                          ) : null}
                        </td>
                        <td data-label="Loss of Pay" className="cell-actions">
                          <div className="cell-actions__group">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => openDetail(row)}
                              disabled={isDownloading}
                            >
                              View
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleRowDownload(row)}
                              disabled={isDownloading}
                            >
                              Download
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationBar pagination={pagination} onPageChange={setPage} />
          </>
        )}
      </section>

      <DownloadProgressModal
        open={downloadModal.open}
        subtitle={downloadModal.subtitle}
        error={downloadModal.error}
        onClose={closeDownloadModal}
      />

      <LopDetailModal
        open={Boolean(detailTarget)}
        userId={detailTarget?.userId ?? null}
        employeeName={detailTarget?.name ?? null}
        month={activeDetailMonth}
        asOf={detailAsOf}
        yearOptions={yearOptions}
        monthOptions={detailMonthOptions}
        onMonthChange={handleDetailMonthChange}
        onClose={closeDetail}
      />
    </div>
  );
}
