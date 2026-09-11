import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, getErrorMessage, leaveApi, salaryApi } from '../../services/api.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { formatINRCurrency } from '../../utils/datetime.js';
import { getTodayMonthIst } from '../../components/MonthField.jsx';
import SalaryDetailModal from '../../components/SalaryDetailModal.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';

const HISTORY_PAGE_SIZE = 20;

function currentIstYear() {
  return Number(getTodayMonthIst().split('-')[0]);
}

function buildYearOptions() {
  const currentYear = currentIstYear();
  const years = [];
  for (let year = currentYear; year >= currentYear - 4; year -= 1) {
    years.push({ value: String(year), label: String(year) });
  }
  return years;
}

const HISTORY_YEAR_OPTIONS = buildYearOptions();

const AUDIT_MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1).padStart(2, '0'),
  label: new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2020, index, 1))),
}));

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

  const loadDetail = useCallback(async (userId, periodKey) => {
    setDetailOpen(true);
    setDetailMonth(periodKey);
    setDetailLoading(true);
    setDetailError('');
    try {
      const isSelf = userId === user?.id;
      const [summaryData, balanceData] = await Promise.all([
        salaryApi.getSummary({ month: periodKey, userId }),
        isSelf
          ? leaveApi.getMyBalances({ year: Number(periodKey.split('-')[0]) })
          : leaveApi.getBalances({ userId, year: Number(periodKey.split('-')[0]) }),
      ]);
      setDetail({
        summary: summaryData.summary ?? null,
        balances: balanceData.balances ?? [],
      });
    } catch (err) {
      setDetail(null);
      setDetailError(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, [user?.id]);

  const employeeOptions = useMemo(
    () =>
      employees.map((employee) => ({
        value: employee.id,
        label: `${employee.name}${employee.employeeCode ? ` (${employee.employeeCode})` : ''}`,
      })),
    [employees],
  );

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
              options={HISTORY_YEAR_OPTIONS}
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
                  <th className="salary-table__num">Payable</th>
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
                      <td data-label="Payable" className="salary-table__num">
                        {row.payableDays ?? '—'}
                      </td>
                      <td data-label="LOP days" className="salary-table__num">
                        {row.lopDays ?? '—'}
                      </td>
                      <td data-label="LOP deduction" className="salary-table__num">
                        {row.lopDeduction != null ? formatINRCurrency(row.lopDeduction) : '—'}
                      </td>
                      <td data-label="Net" className="salary-table__num salary-table__net">
                        {row.netSalary != null ? formatINRCurrency(row.netSalary) : '—'}
                      </td>
                      <td data-label="Transfer">{row.transferStatus ?? '—'}</td>
                      <td data-label="Status">
                        <span className={status.className}>{status.label}</span>
                      </td>
                      <td data-label="Actions" className="cell-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => loadDetail(selectedId, row.periodKey)}
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
  const [yearFilter, setYearFilter] = useState(() => getTodayMonthIst().split('-')[0]);
  const [monthPartFilter, setMonthPartFilter] = useState(() => getTodayMonthIst().split('-')[1]);
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState([]);
  const periodKey = `${yearFilter}-${monthPartFilter}`;

  const [employees, setEmployees] = useState([]);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [auditDetail, setAuditDetail] = useState(null);
  const [auditDetailLoading, setAuditDetailLoading] = useState(false);
  const [auditDetailError, setAuditDetailError] = useState('');
  const [auditDetailOpen, setAuditDetailOpen] = useState(false);
  const [auditDetailMonth, setAuditDetailMonth] = useState(null);

  function closeAuditDetail() {
    setAuditDetailOpen(false);
    setAuditDetail(null);
    setAuditDetailError('');
    setAuditDetailMonth(null);
  }

  const openAuditDetail = useCallback(async (row) => {
    setAuditDetailOpen(true);
    setAuditDetailMonth(row.periodKey);
    setAuditDetailLoading(true);
    setAuditDetailError('');
    try {
      const [summaryData, balanceData] = await Promise.all([
        salaryApi.getSummary({ month: row.periodKey, userId: row.employeeId }),
        leaveApi
          .getBalances({ userId: row.employeeId, year: Number(String(row.periodKey).split('-')[0]) })
          .catch(() =>
            leaveApi.getMyBalances({ year: Number(String(row.periodKey).split('-')[0]) }),
          ),
      ]);
      setAuditDetail({
        summary: summaryData.summary ?? null,
        balances: balanceData.balances ?? [],
      });
    } catch (err) {
      setAuditDetail(null);
      setAuditDetailError(getErrorMessage(err));
    } finally {
      setAuditDetailLoading(false);
    }
  }, []);

  // Close stale modal when the audit period changes.

  useEffect(() => {
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch(() => setDepartments([]));
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
      setTotals(data.totals ?? null);
    } catch (err) {
      setEmployees([]);
      setTotals(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAudit(periodKey, departmentId);
  }, [periodKey, departmentId, loadAudit]);

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

  return (
    <>
      <p className="salary-disclaimer muted small">
        Settled months show finalized LOP and transfer amounts; pending months show live estimates.
      </p>

      <section className="salary-panel card card--table" aria-label={title}>
        <div className="salary-toolbar card__toolbar">
          <div className="salary-toolbar__filters filter-bar">
            <div className="field-inline filter-bar__field salary-toolbar__field salary-toolbar__field--period">
              <span className="label">Pay period</span>
              <div className="salary-toolbar__period">
                <SelectField
                  value={yearFilter}
                  onChange={setYearFilter}
                  options={HISTORY_YEAR_OPTIONS}
                  aria-label="Audit year"
                  disabled={loading}
                />
                <SelectField
                  value={monthPartFilter}
                  onChange={setMonthPartFilter}
                  options={AUDIT_MONTH_OPTIONS}
                  aria-label="Audit month"
                  disabled={loading}
                />
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
        ) : (
          <div className="table-wrap table-wrap--responsive salary-table-wrap">
            <table className="table data-table salary-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Code</th>
                  <th>Department</th>
                  <th className="salary-table__num">Gross</th>
                  <th className="salary-table__num">Present</th>
                  <th className="salary-table__num">Paid leave</th>
                  <th className="salary-table__num">Payable</th>
                  <th className="salary-table__num">LOP</th>
                  <th className="salary-table__num">LOP deduction</th>
                  <th className="salary-table__num">Net</th>
                  <th>Status</th>
                  <th className="cell-actions-col--text">Actions</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((row) => {
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
                      <td data-label="Payable" className="salary-table__num">
                        {row.payableDays ?? '—'}
                      </td>
                      <td data-label="LOP" className="salary-table__num">
                        {row.lopDays ?? '—'}
                      </td>
                      <td data-label="LOP deduction" className="salary-table__num">
                        {row.lopDeduction != null ? formatINRCurrency(row.lopDeduction) : '—'}
                      </td>
                      <td data-label="Net" className="salary-table__num salary-table__net">
                        {row.netSalary != null ? formatINRCurrency(row.netSalary) : '—'}
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

        <SalaryDetailModal
          open={auditDetailOpen}
          month={auditDetailMonth}
          summary={auditDetail?.summary ?? null}
          balances={auditDetail?.balances ?? []}
          loading={auditDetailLoading}
          error={auditDetailError}
          onClose={closeAuditDetail}
        />
      </section>
    </>
  );
}
