import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, getErrorMessage, leaveApi, salaryApi } from '../../services/api.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { formatINRCurrency, formatISTDate } from '../../utils/datetime.js';
import {
  buildSalaryMonthOptions,
  buildSalaryYearOptions,
  clampMonthPartForYear,
  clampYearToCurrentIst,
  getTodayMonthIst,
} from '../../components/MonthField.jsx';
import SalaryDetailModal from '../../components/SalaryDetailModal.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import StickyHScrollBar from '../../components/StickyHScrollBar.jsx';
import { usePortalSync } from '../../hooks/usePortalSync.js';
import { dayKeyInMonth, PORTAL_TOPICS } from '../../utils/portalSync.js';

const HISTORY_PAGE_SIZE = 20;

/** Maps an audit/history table row to SalaryDetailModal summary (row snapshot, not live API). */
function auditRowToSummary(row) {
  if (!row) return null;
  const netPayable =
    row.status === 'settled' && row.netSalary != null ? row.netSalary : row.payableEstimate;
  return {
    monthlySalary: row.hasSalaryConfigured ? row.grossSalary : null,
    workingDaysInMonth: row.workingDays,
    presentDays: row.presentDays,
    paidLeaveDays: row.paidLeaveDays,
    payableDays: row.payableDays,
    paidDaysOutOf30: row.paidDaysOutOf30,
    lopDays: row.lopDays,
    lopDeduction: row.lopDeduction,
    payableEstimate: row.hasSalaryConfigured ? netPayable : null,
    asOfDate: row.asOfDate ?? null,
    lopDates: [],
  };
}

function formatNetSalary(row) {
  if (!row?.hasSalaryConfigured || row.netSalary == null) return '—';
  return formatINRCurrency(row.netSalary);
}

function currentIstYear() {
  return Number(getTodayMonthIst().split('-')[0]);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function auditStatusBadge(status) {
  if (status === 'settled') {
    return { label: 'Settled', className: 'badge badge-success salary-status' };
  }
  if (status === 'inconsistent') {
    return { label: 'Needs attention', className: 'badge badge-warning salary-status' };
  }
  return { label: 'Pending estimate', className: 'badge badge-muted salary-status' };
}

function TableSkeleton({ label }) {
  return (
    <div className="salary-table-skeleton" aria-busy="true" aria-label={label}>
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

/**
 * Per-employee salary history (LOP, deductions, settled vs pending per month).
 * With `fixedUserId` it loads one employee (self-service); otherwise an
 * employee picker is shown (admin / RM team scope enforced server-side).
 */
export function SalaryHistorySection({ fixedUserId = null, title = 'Salary history' }) {
  const { user } = useAuth();
  const currentYear = currentIstYear();
  const [year, setYear] = useState(String(currentYear));
  const [employees, setEmployees] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const [selectedId, setSelectedId] = useState(fixedUserId);
  const [history, setHistory] = useState(null);
  const [loadingEmployees, setLoadingEmployees] = useState(!fixedUserId);
  const [loading, setLoading] = useState(Boolean(fixedUserId));
  const [error, setError] = useState('');

  const [detailMonth, setDetailMonth] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);

  function closeDetail() {
    setDetailOpen(false);
    setDetailMonth(null);
    setDetail(null);
    setDetailError('');
  }

  useEffect(() => {
    setSelectedId(fixedUserId);
    closeDetail();
  }, [fixedUserId]);

  const loadEmployees = useCallback(async (query) => {
    setLoadingEmployees(true);
    try {
      const data = await adminApi.listEmployees({
        search: query || undefined,
        isActive: 'true',
        page: 1,
        limit: HISTORY_PAGE_SIZE,
      });
      setEmployees(data.employees ?? []);
    } catch {
      setEmployees([]);
    } finally {
      setLoadingEmployees(false);
    }
  }, []);

  useEffect(() => {
    if (fixedUserId) return;
    loadEmployees(debouncedSearch.trim());
  }, [fixedUserId, debouncedSearch, loadEmployees]);

  const loadHistory = useCallback(async (userId, yearValue) => {
    if (!userId) {
      setHistory(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await salaryApi.getHistory(userId, { year: yearValue });
      setHistory(data);
    } catch (err) {
      setHistory(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    closeDetail();
    loadHistory(selectedId, year);
  }, [selectedId, year, loadHistory]);

  const fetchHistoryDetailBalances = useCallback(async (userId, periodKey) => {
    const isSelf = userId === user?.id;
    const balanceData = isSelf
      ? await leaveApi.getMyBalances({ year: Number(periodKey.split('-')[0]) })
      : await leaveApi.getBalances({ userId, year: Number(periodKey.split('-')[0]) });
    return balanceData.balances ?? [];
  }, [user?.id]);

  const loadDetail = useCallback(async (userId, periodKey, historyRow) => {
    setDetailOpen(true);
    setDetailMonth(periodKey);
    setDetailLoading(true);
    setDetailError('');
    try {
      const balances = await fetchHistoryDetailBalances(userId, periodKey);
      setDetail({
        summary: auditRowToSummary(historyRow),
        balances,
        inactive: false,
      });
    } catch (err) {
      setDetail(null);
      setDetailError(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, [fetchHistoryDetailBalances]);

  const refetchOpenDetail = useCallback(async () => {
    if (!detailOpen || !selectedId || !detailMonth) return;
    const historyRow = (history?.history ?? []).find((item) => item.periodKey === detailMonth);
    if (!historyRow) return;
    setDetailLoading(true);
    setDetailError('');
    try {
      const balances = await fetchHistoryDetailBalances(selectedId, detailMonth);
      setDetail({
        summary: auditRowToSummary(historyRow),
        balances,
        inactive: false,
      });
    } catch (err) {
      setDetail(null);
      setDetailError(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, [detailMonth, detailOpen, fetchHistoryDetailBalances, history?.history, selectedId]);

  const handleAttendanceSalarySync = useCallback(
    (detail) => {
      if (!selectedId) return;
      if (detail?.dayKey && !detail.dayKey.startsWith(`${year}-`)) return;
      loadHistory(selectedId, year);
      if (detailOpen && detailMonth && dayKeyInMonth(detail.dayKey, detailMonth)) {
        refetchOpenDetail();
      }
    },
    [detailMonth, detailOpen, loadHistory, refetchOpenDetail, selectedId, year],
  );

  usePortalSync(handleAttendanceSalarySync, {
    topics: [PORTAL_TOPICS.PAYROLL],
    userId: selectedId ?? undefined,
  });

  const employeeOptions = useMemo(
    () =>
      employees.map((employee) => ({
        value: employee.id,
        label: `${employee.name}${employee.employeeCode ? ` (${employee.employeeCode})` : ''}`,
      })),
    [employees],
  );

  const historyEmployeeBounds = useMemo(() => {
    if (fixedUserId && user) {
      return {
        joiningDate: user.joiningDate ?? null,
        endingDate: user.endingDate ?? null,
      };
    }
    if (history?.employee) {
      return {
        joiningDate: history.employee.joiningDate ?? null,
        endingDate: history.employee.endingDate ?? null,
      };
    }
    return null;
  }, [fixedUserId, history?.employee, user]);

  const historyYearOptions = useMemo(
    () => buildSalaryYearOptions(historyEmployeeBounds),
    [historyEmployeeBounds, year],
  );

  useEffect(() => {
    if (!historyEmployeeBounds) return;
    const clampedYear = clampYearToCurrentIst(year, historyEmployeeBounds);
    if (clampedYear !== year) {
      setYear(clampedYear);
    }
  }, [historyEmployeeBounds, year]);

  const rows = history?.history ?? [];

  return (
    <section className="salary-panel card card--table" aria-label={title}>
      <div className="salary-toolbar card__toolbar">
        <div className="salary-toolbar__filters filter-bar">
          {fixedUserId ? null : (
            <SearchInput
              className="filter-bar__search salary-toolbar__search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or employee code…"
              ariaLabel="Search employees"
            />
          )}
          <div className="field-inline filter-bar__field salary-toolbar__field">
            <span className="label">Year</span>
            <SelectField
              value={year}
              onChange={setYear}
              options={historyYearOptions}
              aria-label="History year"
              disabled={loading}
            />
          </div>
          {fixedUserId ? null : (
            <div className="field-inline filter-bar__field salary-toolbar__field">
              <span className="label">Employee</span>
              <SelectField
                value={selectedId ?? ''}
                onChange={setSelectedId}
                options={employeeOptions}
                placeholder={loadingEmployees ? 'Loading employees…' : 'Select employee…'}
                aria-label="Employee"
                disabled={loadingEmployees || loading}
              />
            </div>
          )}
        </div>
      </div>

      {history?.employee ? (
        <p className="salary-detail__title muted small">
          {history.employee.name}
          {history.employee.employeeCode ? ` (${history.employee.employeeCode})` : ''}
        </p>
      ) : null}

      {error ? <div className="alert alert--error">{error}</div> : null}

      {loading ? (
        <TableSkeleton label="Loading salary history" />
      ) : history?.inactive ? (
        <EmptyState
          icon={EMPTY_ICONS.payroll}
          title="Employee data not found"
          description="This employee is deactivated, so salary history is unavailable."
        />
      ) : !selectedId ? (
        <EmptyState
          icon={EMPTY_ICONS.payroll}
          title="Select an employee"
          description="Choose an employee to view month-wise salary, LOP, and settlement status."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={EMPTY_ICONS.payroll}
          title="No salary history"
          description="No pay records found for this employee and year."
        />
      ) : (
        <>
          <div className="table-wrap table-wrap--responsive salary-table-wrap">
            <table className="table data-table salary-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="salary-table__num">Gross</th>
                  <th className="salary-table__num">Paid days / MTD</th>
                  <th className="salary-table__num">LOP days</th>
                  <th className="salary-table__num">LOP deduction</th>
                  <th className="salary-table__num">Net</th>
                  <th>Transfer</th>
                  <th>Status</th>
                  <th className="cell-actions-col--text">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = auditStatusBadge(row.status);
                  return (
                    <tr key={row.periodKey}>
                      <td data-label="Month">{row.periodKey}</td>
                      <td data-label="Gross" className="salary-table__num">
                        {row.hasSalaryConfigured ? formatINRCurrency(row.grossSalary) : '—'}
                      </td>
                      <td data-label="Paid days / MTD" className="salary-table__num">
                        {row.hasSalaryConfigured && row.paidDaysOutOf30 != null ? (
                          <>
                            {row.paidDaysOutOf30}
                            <div className="muted small">
                              {row.payableEstimate != null
                                ? formatINRCurrency(row.payableEstimate)
                                : '—'}
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td data-label="LOP days" className="salary-table__num">
                        {row.lopDays ?? '—'}
                      </td>
                      <td data-label="LOP deduction" className="salary-table__num">
                        {row.lopDeduction != null ? formatINRCurrency(row.lopDeduction) : '—'}
                      </td>
                      <td data-label="Net" className="salary-table__num salary-table__net">
                        {formatNetSalary(row)}
                      </td>
                      <td data-label="Transfer">{row.transferStatus ?? '—'}</td>
                      <td data-label="Status">
                        <span className={status.className}>{status.label}</span>
                      </td>
                      <td data-label="Actions" className="cell-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => loadDetail(selectedId, row.periodKey, row)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <SalaryDetailModal
            open={detailOpen}
            month={detailMonth}
            summary={detail?.summary ?? null}
            balances={detail?.balances ?? []}
            loading={detailLoading}
            error={detailError}
            inactive={detail?.inactive === true}
            onClose={closeDetail}
          />
        </>
      )}
    </section>
  );
}

/**
 * Monthly salary audit for the caller's scope (RM team / admin all).
 * Settled months show finalized LOP + transfer truth; pending months estimates.
 * Each row now has a Details popup with the same breakdown as salary history.
 */
export function TeamAuditSection({ allowDownload = true, title = 'Monthly salary audit' }) {
  const { showSuccess } = useToast();
  const initialPeriod = useMemo(() => {
    const [year, month] = getTodayMonthIst().split('-');
    const clampedYear = clampYearToCurrentIst(year);
    return {
      year: clampedYear,
      month: clampMonthPartForYear(clampedYear, month),
    };
  }, []);
  const [yearFilter, setYearFilter] = useState(initialPeriod.year);
  const [monthPartFilter, setMonthPartFilter] = useState(initialPeriod.month);
  const auditYearOptions = useMemo(() => buildSalaryYearOptions(), [yearFilter, monthPartFilter]);
  const auditMonthOptions = useMemo(() => buildSalaryMonthOptions(yearFilter), [yearFilter]);
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const periodKey = `${yearFilter}-${monthPartFilter}`;

  const [employees, setEmployees] = useState([]);
  const [asOfDate, setAsOfDate] = useState(null);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [auditDetail, setAuditDetail] = useState(null);
  const [auditDetailLoading, setAuditDetailLoading] = useState(false);
  const [auditDetailError, setAuditDetailError] = useState('');
  const [auditDetailOpen, setAuditDetailOpen] = useState(false);
  const [auditDetailMonth, setAuditDetailMonth] = useState(null);
  const [auditDetailEmployeeId, setAuditDetailEmployeeId] = useState(null);
  const tableWrapRef = useRef(null);

  function closeAuditDetail() {
    setAuditDetailOpen(false);
    setAuditDetail(null);
    setAuditDetailError('');
    setAuditDetailMonth(null);
    setAuditDetailEmployeeId(null);
  }

  const fetchAuditDetailBalances = useCallback(async (employeeId, periodKey) => {
    const balanceData = await leaveApi
      .getBalances({ userId: employeeId, year: Number(String(periodKey).split('-')[0]) })
      .catch(() => leaveApi.getMyBalances({ year: Number(String(periodKey).split('-')[0]) }));
    return balanceData.balances ?? [];
  }, []);

  const openAuditDetail = useCallback(async (row) => {
    setAuditDetailOpen(true);
    setAuditDetailMonth(row.periodKey);
    setAuditDetailEmployeeId(row.employeeId);
    setAuditDetailLoading(true);
    setAuditDetailError('');
    try {
      const balances = await fetchAuditDetailBalances(row.employeeId, row.periodKey);
      setAuditDetail({
        summary: auditRowToSummary(row),
        balances,
        inactive: false,
      });
    } catch (err) {
      setAuditDetail(null);
      setAuditDetailError(getErrorMessage(err));
    } finally {
      setAuditDetailLoading(false);
    }
  }, [fetchAuditDetailBalances]);

  const refetchOpenAuditDetail = useCallback(async () => {
    if (!auditDetailOpen || !auditDetailEmployeeId || !auditDetailMonth) return;
    const row = employees.find((item) => item.employeeId === auditDetailEmployeeId);
    if (!row) return;
    setAuditDetailLoading(true);
    setAuditDetailError('');
    try {
      const balances = await fetchAuditDetailBalances(auditDetailEmployeeId, auditDetailMonth);
      setAuditDetail({
        summary: auditRowToSummary(row),
        balances,
        inactive: false,
      });
    } catch (err) {
      setAuditDetail(null);
      setAuditDetailError(getErrorMessage(err));
    } finally {
      setAuditDetailLoading(false);
    }
  }, [
    auditDetailEmployeeId,
    auditDetailMonth,
    auditDetailOpen,
    employees,
    fetchAuditDetailBalances,
  ]);

  // Close stale modal when the audit period changes.

  useEffect(() => {
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch((err) => {
        console.warn('Salary audit: failed to load departments', getErrorMessage(err));
        setDepartments([]);
      });
  }, []);

  const departmentOptions = useMemo(
    () => [
      { value: '', label: 'All departments' },
      ...departments
        .filter((item) => item.isActive !== false)
        .map((item) => ({ value: item.id, label: item.name })),
    ],
    [departments],
  );

  const loadAudit = useCallback(async (period, department) => {
    setLoading(true);
    setError('');
    try {
      const data = await salaryApi.getAudit({
        periodKey: period,
        ...(department ? { departmentId: department } : {}),
      });
      setEmployees(data.employees ?? []);
      setAsOfDate(data.asOfDate ?? null);
      setTotals(data.totals ?? null);
    } catch (err) {
      setEmployees([]);
      setAsOfDate(null);
      setTotals(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAudit(periodKey, departmentId);
  }, [periodKey, departmentId, loadAudit]);

  const handleAttendanceSalarySync = useCallback(
    (detail) => {
      loadAudit(periodKey, departmentId);
      if (
        auditDetailOpen &&
        auditDetailMonth &&
        auditDetailEmployeeId &&
        detail?.userId &&
        String(detail.userId) === String(auditDetailEmployeeId) &&
        dayKeyInMonth(detail.dayKey, auditDetailMonth)
      ) {
        refetchOpenAuditDetail();
      }
    },
    [
      auditDetailEmployeeId,
      auditDetailMonth,
      auditDetailOpen,
      departmentId,
      loadAudit,
      periodKey,
      refetchOpenAuditDetail,
    ],
  );

  usePortalSync(handleAttendanceSalarySync, {
    topics: [PORTAL_TOPICS.PAYROLL],
    month: periodKey,
  });

  async function handleDownload() {
    setExporting(true);
    setError('');
    try {
      const blob = await salaryApi.downloadAudit(
        periodKey,
        departmentId ? { departmentId } : undefined,
      );
      downloadBlob(blob, `salary-audit-${periodKey}.xlsx`);
      showSuccess('Audit report downloaded.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const handleYearChange = (value) => {
    const nextYear = clampYearToCurrentIst(value);
    setYearFilter(nextYear);
    setMonthPartFilter((currentMonth) => clampMonthPartForYear(nextYear, currentMonth));
  };

  const hasActiveSearch = Boolean(debouncedSearch.trim());

  const filteredEmployees = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return employees;
    return employees.filter(
      (row) =>
        row.employeeName?.toLowerCase().includes(query) ||
        row.employeeCode?.toLowerCase().includes(query) ||
        row.departmentName?.toLowerCase().includes(query),
    );
  }, [debouncedSearch, employees]);

  return (
    <>
      <p className="salary-disclaimer muted small">
        Settled months show finalized LOP and transfer amounts; pending months show live estimates
        {asOfDate ? ` as of ${formatISTDate(asOfDate)}` : ''}. Paid days use the fixed 30-day salary
        pool (monthly salary ÷ 30).
      </p>

      <section className="salary-panel card card--table" aria-label={title}>
        <div className="salary-toolbar card__toolbar">
          <div className="salary-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search salary-toolbar__search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, code, or department…"
              ariaLabel="Search salary audit"
            />

            <div className="filter-bar__field salary-toolbar__field salary-toolbar__field--period">
              <div className="salary-toolbar__period">
                <div className="field-inline">
                  <span className="label">Year</span>
                  <SelectField
                    value={yearFilter}
                    onChange={handleYearChange}
                    options={auditYearOptions}
                    aria-label="Audit year"
                    disabled={loading}
                  />
                </div>
                <div className="field-inline">
                  <span className="label">Month</span>
                  <SelectField
                    value={monthPartFilter}
                    onChange={setMonthPartFilter}
                    options={auditMonthOptions}
                    aria-label="Audit month"
                    disabled={loading}
                  />
                </div>
              </div>
            </div>

            <div className="field-inline filter-bar__field salary-toolbar__field">
              <span className="label">Department</span>
              <SelectField
                value={departmentId}
                onChange={setDepartmentId}
                options={departmentOptions}
                aria-label="Audit department"
                disabled={loading}
              />
            </div>

            {hasActiveSearch ? (
              <div className="filter-bar__field salary-toolbar__clear">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSearch('')}
                >
                  Clear search
                </button>
              </div>
            ) : null}
          </div>

          {allowDownload ? (
            <div className="salary-toolbar__actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleDownload}
                disabled={exporting || loading}
              >
                {exporting ? 'Exporting…' : 'Download audit Excel'}
              </button>
            </div>
          ) : null}
        </div>

        {totals ? (
          <div className="summary-row">
            <span className="stat-pill">Employees: {totals.employees}</span>
            <span className="stat-pill stat-pill--warning">LOP days: {totals.lopDays}</span>
            <span className="stat-pill stat-pill--error">
              LOP deduction: {formatINRCurrency(totals.lopDeduction)}
            </span>
            <span className="stat-pill stat-pill--success">
              Net total: {formatINRCurrency(totals.totalNetSalary)}
            </span>
          </div>
        ) : null}

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton label="Loading salary audit" />
        ) : employees.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.payroll}
            title="No audit rows"
            description="No employees in scope for this month."
          />
        ) : filteredEmployees.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.payroll}
            title="No employees match your search"
            description="Try a different name, code, or department, or clear search."
            action={(
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setSearch('')}>
                Clear search
              </button>
            )}
          />
        ) : (
          <div ref={tableWrapRef} className="table-wrap table-wrap--responsive salary-table-wrap">
            <table className="table data-table salary-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Code</th>
                  <th>Department</th>
                  <th className="salary-table__num">Gross</th>
                  <th className="salary-table__num">Present</th>
                  <th className="salary-table__num">Paid leave</th>
                  <th className="salary-table__num">Paid days / MTD</th>
                  <th className="salary-table__num">LOP</th>
                  <th className="salary-table__num">LOP deduction</th>
                  <th className="salary-table__num">Net</th>
                  <th>Status</th>
                  <th className="cell-actions-col--text">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.map((row) => {
                  const status = auditStatusBadge(row.status);
                  return (
                    <tr key={row.employeeId}>
                      <td data-label="Employee" className="cell-ellipsis salary-table__name">
                        {row.employeeName}
                      </td>
                      <td data-label="Code" className="salary-table__code">
                        {row.employeeCode || '—'}
                      </td>
                      <td data-label="Department">{row.departmentName || '—'}</td>
                      <td data-label="Gross" className="salary-table__num">
                        {row.hasSalaryConfigured ? formatINRCurrency(row.grossSalary) : '—'}
                      </td>
                      <td data-label="Present" className="salary-table__num">
                        {row.presentDays ?? '—'}
                      </td>
                      <td data-label="Paid leave" className="salary-table__num">
                        {row.paidLeaveDays ?? '—'}
                      </td>
                      <td data-label="Paid days / MTD" className="salary-table__num">
                        {row.hasSalaryConfigured && row.paidDaysOutOf30 != null ? (
                          <>
                            {row.paidDaysOutOf30}
                            <div className="muted small">
                              {row.payableEstimate != null
                                ? formatINRCurrency(row.payableEstimate)
                                : '—'}
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td data-label="LOP" className="salary-table__num">
                        {row.lopDays ?? '—'}
                      </td>
                      <td data-label="LOP deduction" className="salary-table__num">
                        {row.lopDeduction != null ? formatINRCurrency(row.lopDeduction) : '—'}
                      </td>
                      <td data-label="Net" className="salary-table__num salary-table__net">
                        {formatNetSalary(row)}
                      </td>
                      <td data-label="Status">
                        <span className={status.className}>{status.label}</span>
                      </td>
                      <td data-label="Actions" className="cell-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openAuditDetail(row)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <StickyHScrollBar targetRef={tableWrapRef} syncKey={filteredEmployees.length} />

        <SalaryDetailModal
          open={auditDetailOpen}
          month={auditDetailMonth}
          summary={auditDetail?.summary ?? null}
          balances={auditDetail?.balances ?? []}
          loading={auditDetailLoading}
          error={auditDetailError}
          inactive={auditDetail?.inactive === true}
          onClose={closeAuditDetail}
        />
      </section>
    </>
  );
}
