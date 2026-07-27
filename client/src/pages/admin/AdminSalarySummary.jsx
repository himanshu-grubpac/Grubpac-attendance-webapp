import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import {
  updateSalarySettingsSchema,
  updateUserSalarySchema,
} from '@shared/validation/salary.js';
import { getErrorMessage, salaryApi } from '../../services/api.js';
import { validateForm } from '../../utils/validation.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { formatINRCurrency, formatISTDate, formatISTDateTime } from '../../utils/datetime.js';
import { formatInrInput, parseInrInput } from '../../utils/formatNumber.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import SelectField from '../../components/SelectField.jsx';
import DateField from '../../components/DateField.jsx';
import InrInput from '../../components/InrInput.jsx';
import { getTodayMonthIst } from '../../components/MonthField.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import FieldError from '../../components/FieldError.jsx';

const PAGE_SIZE = 20;
const STRUCTURE_PAGE_SIZE = 20;

const SALARY_TABS = [
  { id: 'monthly', label: 'Monthly Payroll' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'structure', label: 'Salary Structure' },
  { id: 'settings', label: 'Settings' },
];

const PAYROLL_DAY_OPTIONS = [
  { value: '', label: 'Not set' },
  ...Array.from({ length: 28 }, (_, index) => {
    const day = index + 1;
    return { value: String(day), label: `Day ${day} of each month` };
  }),
];

const STAT_CARDS = [
  {
    key: 'totalPayroll',
    label: 'TOTAL PAYROLL THIS MONTH',
    hint: 'Sum of net pay estimates for selected month',
    icon: '₹',
    format: 'currency',
  },
  {
    key: 'employeesPaid',
    label: 'EMPLOYEES PAID',
    hint: 'With monthly estimate / salary configured',
    icon: '👥',
    format: 'ratio',
  },
  {
    key: 'pendingTransfers',
    label: 'PENDING TRANSFERS',
    hint: 'Bank disbursements awaiting payment for selected month',
    icon: '↗',
    format: 'count',
  },
  {
    key: 'nextPayrollDate',
    label: 'NEXT PAYROLL DATE',
    hintKey: 'nextPayrollHint',
    icon: '📅',
    format: 'date',
  },
];

const TRANSFER_STAT_CARDS = [
  {
    key: 'pendingCount',
    label: 'PENDING',
    hint: 'Awaiting bank disbursement',
    icon: '⏳',
    format: 'count',
  },
  {
    key: 'paidCount',
    label: 'PAID',
    hint: 'Marked as disbursed',
    icon: '✓',
    format: 'count',
  },
  {
    key: 'failedCount',
    label: 'FAILED',
    hint: 'Transfer failed or rejected',
    icon: '✕',
    format: 'count',
  },
  {
    key: 'totalPendingAmount',
    label: 'TOTAL PENDING AMOUNT',
    hint: 'Sum of pending transfer amounts',
    icon: '₹',
    format: 'currency',
  },
];

const TRANSFER_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
];

function transferStatusBadge(status) {
  if (status === 'paid') {
    return { label: 'Paid', className: 'badge badge-success salary-status' };
  }
  if (status === 'failed') {
    return { label: 'Failed', className: 'badge badge-muted salary-status' };
  }
  return { label: 'Pending', className: 'badge badge-warning salary-status' };
}

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

const SALARY_MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1).padStart(2, '0'),
  label: new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2020, index, 1))),
}));

const YEAR_OPTIONS = buildYearOptions();

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function computeLopDeduction(item) {
  if (item.monthlySalary == null || item.payableEstimate == null) return null;
  return roundMoney(Math.max(0, item.monthlySalary - item.payableEstimate));
}

function payStatusBadge(item) {
  if (!item.hasSalaryConfigured) {
    return { label: 'No salary', className: 'badge badge-muted salary-status' };
  }
  if (item.lopDays > 0) {
    return { label: 'LOP applied', className: 'badge badge-warning salary-status' };
  }
  return { label: 'Full estimate', className: 'badge badge-success salary-status' };
}

function formatPayrollDateKey(dateKey) {
  if (!dateKey) return '—';
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatStatValue(key, statValues, format) {
  const value = statValues[key];
  if (format === 'currency') {
    return value == null ? '—' : formatINRCurrency(value);
  }
  if (format === 'ratio') {
    if (value == null) return '—';
    return `${value.withEstimate} / ${value.configured}`;
  }
  if (format === 'date') {
    return formatPayrollDateKey(value);
  }
  if (value == null) return '—';
  return String(value);
}

function StatCardSkeleton() {
  return (
    <div className="salary-stat card salary-stat--skeleton" aria-hidden="true">
      <div className="salary-stat__head">
        <div className="skeleton salary-stat__skeleton-label" />
        <div className="skeleton salary-stat__skeleton-icon" />
      </div>
      <div className="skeleton salary-stat__skeleton-value" />
      <div className="skeleton salary-stat__skeleton-hint" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="salary-table-skeleton" aria-busy="true" aria-label="Loading salary estimates">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

function SalaryStatsGrid({ loading, statValues, dynamicHints, statCards = STAT_CARDS }) {
  return (
    <section className="salary-stats" aria-label="Salary summary">
      <div className="salary-stats__grid">
        {loading
          ? statCards.map((card) => <StatCardSkeleton key={card.key} />)
          : statCards.map((card) => (
              <article key={card.key} className="salary-stat card">
                <div className="salary-stat__head">
                  <span className="salary-stat__label">{card.label}</span>
                  <span className="salary-stat__icon" aria-hidden="true">
                    {card.icon}
                  </span>
                </div>
                <strong className="salary-stat__value">
                  {formatStatValue(card.key, statValues, card.format)}
                </strong>
                <p className="salary-stat__hint muted small">
                  {card.hintKey ? dynamicHints[card.hintKey] : card.hint}
                </p>
              </article>
            ))}
      </div>
    </section>
  );
}

function MonthlyPayrollTab({
  month,
  yearFilter,
  monthPartFilter,
  setYearFilter,
  setMonthPartFilter,
  summaries,
  meta,
  loading,
  error,
  exporting,
  onExport,
  search,
  setSearch,
  page,
  setPage,
  selectedId,
  setSelectedId,
}) {
  const debouncedSearch = useDebouncedValue(search, 350);

  const filtered = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return summaries;
    return summaries.filter(
      (item) =>
        item.userName?.toLowerCase().includes(query) ||
        item.employeeCode?.toLowerCase().includes(query),
    );
  }, [summaries, debouncedSearch]);

  const footerTotals = useMemo(() => {
    const rows = filtered.filter((item) => item.monthlySalary != null);
    let baseTotal = 0;
    let deductionTotal = 0;
    let netTotal = 0;

    for (const item of rows) {
      baseTotal += item.monthlySalary ?? 0;
      const deduction = computeLopDeduction(item);
      if (deduction != null) deductionTotal += deduction;
      if (item.payableEstimate != null) netTotal += item.payableEstimate;
    }

    return {
      baseTotal: roundMoney(baseTotal),
      deductionTotal: roundMoney(deductionTotal),
      netTotal: roundMoney(netTotal),
      rowCount: rows.length,
    };
  }, [filtered]);

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

  const hasActiveFilters = Boolean(debouncedSearch.trim());

  const emptyTitle = useMemo(() => {
    if (hasActiveFilters) return 'No employees match your search';
    return 'No pay estimates for this month';
  }, [hasActiveFilters]);

  const emptyDescription = useMemo(() => {
    if (hasActiveFilters) {
      return 'Try a different name or employee code, or clear search to browse all estimates.';
    }
    return 'Estimates appear once employees have salary configured and attendance recorded for the selected month.';
  }, [hasActiveFilters]);

  const statValues = {
    totalPayroll: loading ? null : meta?.totalPayroll ?? 0,
    employeesPaid: loading
      ? null
      : {
          withEstimate: meta?.employeesWithEstimate ?? 0,
          configured: meta?.employeesConfigured ?? 0,
        },
    pendingTransfers: loading ? null : meta?.pendingTransfers ?? 0,
    nextPayrollDate: loading ? null : meta?.nextPayrollDate ?? null,
  };

  const dynamicHints = {
    nextPayrollHint: meta?.payrollDayOfMonth
      ? `Scheduled on day ${meta.payrollDayOfMonth} each month`
      : 'Set payroll day in Settings',
  };

  return (
    <>
      <p className="salary-disclaimer muted small">
        Attendance-based pay estimates for the selected month — not a payroll run, bank transfer, or
        payslip.
      </p>

      <SalaryStatsGrid loading={loading} statValues={statValues} dynamicHints={dynamicHints} />

      <section className="salary-panel card card--table" aria-label="Monthly pay estimates">
        <div className="salary-toolbar card__toolbar">
          <div className="salary-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search salary-toolbar__search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or employee code…"
              ariaLabel="Search salary estimates"
            />

            <div className="field-inline filter-bar__field salary-toolbar__field salary-toolbar__field--period">
              <span className="label">Pay period</span>
              <div className="salary-toolbar__period">
                <SelectField
                  value={yearFilter}
                  onChange={(value) => setYearFilter(clampYearToCurrent(value))}
                  options={YEAR_OPTIONS}
                  aria-label="Salary year"
                  disabled={loading}
                />
                <SelectField
                  value={monthPartFilter}
                  onChange={setMonthPartFilter}
                  options={SALARY_MONTH_OPTIONS}
                  aria-label="Salary month"
                  disabled={loading}
                />
              </div>
            </div>

            {hasActiveFilters ? (
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

          <div className="salary-toolbar__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onExport}
              disabled={exporting || loading}
            >
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.payroll}
            title={emptyTitle}
            description={emptyDescription}
            action={
              hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setSearch('')}>
                  Clear search
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive salary-table-wrap">
              <table className="table data-table salary-table">
                <thead>
                  <tr>
                    <th scope="col" className="salary-table__col-row-num">
                      #
                    </th>
                    <th>Employee</th>
                    <th>Code</th>
                    <th className="salary-table__num">Base salary</th>
                    <th className="salary-table__num">LOP deduction</th>
                    <th className="salary-table__num">Net estimate</th>
                    <th>Status</th>
                    <th className="cell-actions-col--text">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((item, index) => {
                    const deduction = computeLopDeduction(item);
                    const status = payStatusBadge(item);
                    const isSelected = selectedId === item.userId;
                    const rowNumber = (page - 1) * PAGE_SIZE + index + 1;

                    return (
                      <tr
                        key={item.userId}
                        className={isSelected ? 'table-row--selected' : undefined}
                      >
                        <td
                          data-label="#"
                          className="salary-table__row-num"
                          aria-label={`Row ${rowNumber}`}
                        >
                          {rowNumber}
                        </td>
                        <td data-label="Employee">
                          <Link
                            to={`/admin/users/${item.userId}`}
                            className="table-link cell-ellipsis salary-table__name"
                            title={item.userName}
                          >
                            {item.userName}
                          </Link>
                          <div className="muted small">
                            Present {item.presentDays} · Paid leave {item.paidLeaveDays}
                          </div>
                        </td>
                        <td data-label="Code" className="salary-table__code">
                          {item.employeeCode || '—'}
                        </td>
                        <td data-label="Base salary" className="salary-table__num">
                          {formatINRCurrency(item.monthlySalary)}
                        </td>
                        <td data-label="LOP deduction" className="salary-table__num">
                          {deduction == null ? '—' : formatINRCurrency(deduction)}
                        </td>
                        <td data-label="Net estimate" className="salary-table__num salary-table__net">
                          {formatINRCurrency(item.payableEstimate)}
                        </td>
                        <td data-label="Status">
                          <span className={status.className}>{status.label}</span>
                        </td>
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
                            {isSelected ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {footerTotals.rowCount > 0 ? (
                  <tfoot>
                    <tr className="salary-table__totals">
                      <td colSpan={3}>
                        <strong>Totals</strong>
                        <span className="muted small">
                          {' '}
                          ({footerTotals.rowCount} employee
                          {footerTotals.rowCount === 1 ? '' : 's'}
                          {hasActiveFilters ? ' matching search' : ''})
                        </span>
                      </td>
                      <td className="salary-table__num">{formatINRCurrency(footerTotals.baseTotal)}</td>
                      <td className="salary-table__num">
                        {formatINRCurrency(footerTotals.deductionTotal)}
                      </td>
                      <td className="salary-table__num salary-table__net">
                        {formatINRCurrency(footerTotals.netTotal)}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
            <PaginationBar pagination={pagination} onPageChange={setPage} />
          </>
        )}
      </section>

      {selectedSummary ? (
        <section className="salary-detail card" aria-label="Employee pay estimate details">
          <div className="salary-detail__head">
            <div>
              <h2 className="salary-detail__title">{selectedSummary.userName}</h2>
              {selectedSummary.employeeCode ? (
                <p className="muted small">{selectedSummary.employeeCode}</p>
              ) : null}
            </div>
            <Link to={`/admin/users/${selectedSummary.userId}`} className="btn btn-ghost btn-sm">
              View profile
            </Link>
          </div>
          <dl className="detail-list detail-list--grid salary-detail__grid">
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
              <dt>LOP days</dt>
              <dd>{selectedSummary.lopDays}</dd>
            </div>
            <div>
              <dt>Per day (INR)</dt>
              <dd>{formatINRCurrency(selectedSummary.perDaySalary)}</dd>
            </div>
            <div>
              <dt>Net estimate (INR)</dt>
              <dd>{formatINRCurrency(selectedSummary.payableEstimate)}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </>
  );
}

function SalaryStructureTab({ canManageSalary }) {
  const { showSuccess } = useToast();
  const [employees, setEmployees] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: STRUCTURE_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ monthlySalary: '', salaryEffectiveFrom: '' });
  const [editError, setEditError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const editModalTitleId = 'salary-structure-edit-title';

  const loadStructure = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await salaryApi.listStructure({
        page,
        limit: STRUCTURE_PAGE_SIZE,
        search: debouncedSearch.trim() || undefined,
      });
      setEmployees(data.employees ?? []);
      setPagination(
        data.pagination ?? {
          page: 1,
          limit: STRUCTURE_PAGE_SIZE,
          total: 0,
          totalPages: 1,
        },
      );
    } catch (err) {
      setEmployees([]);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page]);

  useEffect(() => {
    loadStructure();
  }, [loadStructure]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  function openEdit(employee) {
    setEditing(employee);
    setEditForm({
      monthlySalary:
        employee.monthlySalary != null ? formatInrInput(employee.monthlySalary) : '',
      salaryEffectiveFrom: employee.salaryEffectiveFrom ?? '',
    });
    setEditError('');
    setFieldErrors({});
  }

  const closeEdit = useCallback(() => {
    if (saving) return;
    setEditing(null);
    setEditForm({ monthlySalary: '', salaryEffectiveFrom: '' });
    setEditError('');
    setFieldErrors({});
  }, [saving]);

  useEscapeKey(Boolean(editing), closeEdit);

  async function handleSaveEdit(event) {
    event.preventDefault();
    if (!editing) return;

    setSaving(true);
    setEditError('');
    setFieldErrors({});

    const payload = {};
    if (editForm.monthlySalary !== '') {
      const parsedSalary = parseInrInput(editForm.monthlySalary);
      if (parsedSalary === '') {
        setFieldErrors({ monthlySalary: 'Monthly salary must be a valid number.' });
        setSaving(false);
        return;
      }
      payload.monthlySalary = parsedSalary;
    } else if (editing.monthlySalary != null) {
      payload.monthlySalary = null;
    }

    if (editForm.salaryEffectiveFrom) {
      payload.salaryEffectiveFrom = editForm.salaryEffectiveFrom;
    } else if (editing.salaryEffectiveFrom) {
      payload.salaryEffectiveFrom = null;
    }

    if (Object.keys(payload).length === 0) {
      closeEdit();
      setSaving(false);
      return;
    }

    const validation = validateForm(updateUserSalarySchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSaving(false);
      return;
    }

    try {
      await salaryApi.updateUserSalary(editing.id, validation.data);
      showSuccess(`Salary updated for ${editing.name}.`);
      closeEdit();
      await loadStructure();
    } catch (err) {
      setEditError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const hasActiveFilters = Boolean(debouncedSearch.trim());

  return (
    <>
      <p className="salary-disclaimer muted small">
        Base monthly salaries used for attendance-based pay estimates. Changes apply from the
        effective date onward.
      </p>

      <section className="salary-panel card card--table" aria-label="Salary structure">
        <div className="salary-toolbar card__toolbar">
          <div className="salary-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search salary-toolbar__search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or employee code…"
              ariaLabel="Search salary structure"
            />
            {hasActiveFilters ? (
              <div className="filter-bar__field salary-toolbar__clear">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSearch('')}>
                  Clear search
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : employees.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.payroll}
            title={hasActiveFilters ? 'No employees match your search' : 'No active employees'}
            description={
              hasActiveFilters
                ? 'Try a different name or employee code.'
                : 'Active employees will appear here for salary configuration.'
            }
            action={
              hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setSearch('')}>
                  Clear search
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive salary-table-wrap">
              <table className="table data-table salary-table salary-structure-table">
                <thead>
                  <tr>
                    <th scope="col" className="salary-table__col-row-num">
                      #
                    </th>
                    <th>Employee</th>
                    <th>Code</th>
                    <th>Department</th>
                    <th className="salary-table__num">Monthly salary</th>
                    <th>Effective from</th>
                    <th className="cell-actions-col--text">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((employee, index) => {
                    const rowNumber = (pagination.page - 1) * pagination.limit + index + 1;

                    return (
                    <tr key={employee.id}>
                      <td
                        data-label="#"
                        className="salary-table__row-num"
                        aria-label={`Row ${rowNumber}`}
                      >
                        {rowNumber}
                      </td>
                      <td data-label="Employee">
                        <Link
                          to={`/admin/users/${employee.id}`}
                          className="table-link cell-ellipsis salary-table__name"
                          title={employee.name}
                        >
                          {employee.name}
                        </Link>
                        {employee.designation ? (
                          <div className="muted small">{employee.designation}</div>
                        ) : null}
                      </td>
                      <td data-label="Code" className="salary-table__code">
                        {employee.employeeCode || '—'}
                      </td>
                      <td data-label="Department">{employee.department || '—'}</td>
                      <td data-label="Monthly salary" className="salary-table__num">
                        {formatINRCurrency(employee.monthlySalary)}
                      </td>
                      <td data-label="Effective from">
                        {employee.salaryEffectiveFrom
                          ? formatISTDate(employee.salaryEffectiveFrom)
                          : '—'}
                      </td>
                      <td data-label="Actions" className="cell-actions">
                        {canManageSalary ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => openEdit(employee)}
                          >
                            Edit salary
                          </button>
                        ) : (
                          <span className="muted small">View only</span>
                        )}
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

      {editing
        ? createPortal(
            <div className="modal__backdrop" role="presentation" onClick={closeEdit}>
              <div
                className="modal modal--compact salary-structure-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={editModalTitleId}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="modal__header">
                  <h2 id={editModalTitleId} className="modal__title">
                    Edit salary — {editing.name}
                  </h2>
                  <p className="modal__lead muted">
                    Set the base monthly salary and when it takes effect. Estimates use this from
                    the effective date onward.
                  </p>
                </header>
                <form className="modal__form" onSubmit={handleSaveEdit}>
                  <div className="modal__body">
                    {editError ? (
                      <div className="alert alert--error modal__alert">{editError}</div>
                    ) : null}

                    <label className="modal__field">
                      <span className="label" htmlFor="structure-monthly-salary">
                        Monthly salary (INR)
                      </span>
                      <InrInput
                        id="structure-monthly-salary"
                        value={editForm.monthlySalary}
                        onChange={(value) =>
                          setEditForm((current) => ({ ...current, monthlySalary: value }))
                        }
                        placeholder="e.g. 50,000"
                        disabled={saving}
                      />
                      <FieldError message={fieldErrors.monthlySalary} />
                      <p className="muted small">Leave empty to clear salary for this employee.</p>
                    </label>

                    <label className="modal__field">
                      <span className="label" htmlFor="structure-effective-from">
                        Effective from
                      </span>
                      <DateField
                        id="structure-effective-from"
                        value={editForm.salaryEffectiveFrom}
                        onChange={(value) =>
                          setEditForm((current) => ({ ...current, salaryEffectiveFrom: value }))
                        }
                        disabled={saving}
                      />
                      <FieldError message={fieldErrors.salaryEffectiveFrom} />
                    </label>
                  </div>
                  <footer className="modal__footer">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={closeEdit}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : 'Save salary'}
                    </button>
                  </footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function TransfersTab({ month, yearFilter, monthPartFilter, setYearFilter, setMonthPartFilter, canManageSalary }) {
  const { showSuccess } = useToast();
  const [transfers, setTransfers] = useState([]);
  const [stats, setStats] = useState(null);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  const [error, setError] = useState('');
  const [failModal, setFailModal] = useState(null);
  const [failReason, setFailReason] = useState('');
  const [failError, setFailError] = useState('');
  const failModalTitleId = 'salary-transfer-fail-title';

  const loadTransfers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await salaryApi.listTransfers({
        month,
        page,
        limit: PAGE_SIZE,
        status: statusFilter || undefined,
      });
      setTransfers(data.transfers ?? []);
      setStats(data.stats ?? null);
      setPagination(
        data.pagination ?? {
          page: 1,
          limit: PAGE_SIZE,
          total: 0,
          totalPages: 1,
        },
      );
    } catch (err) {
      setTransfers([]);
      setStats(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [month, page, statusFilter]);

  useEffect(() => {
    loadTransfers();
  }, [loadTransfers]);

  useEffect(() => {
    setPage(1);
  }, [month, statusFilter]);

  const closeFailModal = useCallback(() => {
    if (updatingId) return;
    setFailModal(null);
    setFailReason('');
    setFailError('');
  }, [updatingId]);

  useEscapeKey(Boolean(failModal), closeFailModal);

  async function handleGenerate() {
    setGenerating(true);
    setError('');
    try {
      const data = await salaryApi.generateTransfers({ month });
      setPage(1);
      if (data.created > 0) {
        showSuccess(`Generated ${data.created} pending transfer${data.created === 1 ? '' : 's'}.`);
      } else if (data.skipped > 0) {
        showSuccess('All eligible employees already have transfer records for this month.');
      } else {
        showSuccess('No eligible employees with salary configured for this month.');
      }
      const listData = await salaryApi.listTransfers({
        month,
        page: 1,
        limit: PAGE_SIZE,
        status: statusFilter || undefined,
      });
      setTransfers(listData.transfers ?? []);
      setStats(listData.stats ?? null);
      setPagination(
        listData.pagination ?? {
          page: 1,
          limit: PAGE_SIZE,
          total: 0,
          totalPages: 1,
        },
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleStatusUpdate(transfer, status, failureReason) {
    setUpdatingId(transfer.id);
    setError('');
    try {
      const payload = { status };
      if (failureReason !== undefined) {
        payload.failureReason = failureReason;
      }
      await salaryApi.updateTransfer(transfer.id, payload);
      showSuccess(`Transfer marked as ${status}.`);
      closeFailModal();
      await loadTransfers();
    } catch (err) {
      if (failModal) {
        setFailError(getErrorMessage(err));
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setUpdatingId(null);
    }
  }

  function openFailModal(transfer) {
    setFailModal(transfer);
    setFailReason(transfer.failureReason ?? '');
    setFailError('');
  }

  async function handleConfirmFail(event) {
    event.preventDefault();
    if (!failModal) return;
    await handleStatusUpdate(failModal, 'failed', failReason.trim() || undefined);
  }

  const statValues = {
    pendingCount: loading ? null : stats?.pendingCount ?? 0,
    paidCount: loading ? null : stats?.paidCount ?? 0,
    failedCount: loading ? null : stats?.failedCount ?? 0,
    totalPendingAmount: loading ? null : stats?.totalPendingAmount ?? 0,
  };

  const hasActiveFilters = Boolean(statusFilter);

  return (
    <>
      <p className="salary-disclaimer muted small">
        Manual bank disbursement tracking for the selected month. Generate pending rows from net pay
        estimates, then mark each transfer paid or failed after processing outside this portal.
      </p>

      <SalaryStatsGrid loading={loading} statValues={statValues} dynamicHints={{}} statCards={TRANSFER_STAT_CARDS} />

      <section className="salary-panel card card--table" aria-label="Salary transfers">
        <div className="salary-toolbar card__toolbar">
          <div className="salary-toolbar__filters filter-bar">
            <div className="field-inline filter-bar__field salary-toolbar__field salary-toolbar__field--period">
              <span className="label">Pay period</span>
              <div className="salary-toolbar__period">
                <SelectField
                  value={yearFilter}
                  onChange={(value) => setYearFilter(clampYearToCurrent(value))}
                  options={YEAR_OPTIONS}
                  aria-label="Transfer year"
                  disabled={loading || generating}
                />
                <SelectField
                  value={monthPartFilter}
                  onChange={setMonthPartFilter}
                  options={SALARY_MONTH_OPTIONS}
                  aria-label="Transfer month"
                  disabled={loading || generating}
                />
              </div>
            </div>

            <div className="field-inline filter-bar__field salary-toolbar__field">
              <span className="label">Status</span>
              <SelectField
                value={statusFilter}
                onChange={setStatusFilter}
                options={TRANSFER_STATUS_OPTIONS}
                aria-label="Transfer status filter"
                disabled={loading || generating}
              />
            </div>

            {hasActiveFilters ? (
              <div className="filter-bar__field salary-toolbar__clear">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setStatusFilter('')}
                >
                  Clear filter
                </button>
              </div>
            ) : null}
          </div>

          {canManageSalary ? (
            <div className="salary-toolbar__actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleGenerate}
                disabled={generating || loading}
              >
                {generating ? 'Generating…' : 'Generate pending transfers'}
              </button>
            </div>
          ) : null}
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : transfers.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.payroll}
            title={hasActiveFilters ? 'No transfers match this filter' : 'No transfer records yet'}
            description={
              hasActiveFilters
                ? 'Try a different status or clear the filter.'
                : canManageSalary
                  ? 'Generate pending transfers from eligible employees’ net pay estimates for this month.'
                  : 'Transfer records will appear here once an admin generates them for this month.'
            }
            action={
              hasActiveFilters ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setStatusFilter('')}
                >
                  Clear filter
                </button>
              ) : canManageSalary ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleGenerate}
                  disabled={generating}
                >
                  {generating ? 'Generating…' : 'Generate pending transfers'}
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive salary-table-wrap">
              <table className="table data-table salary-table">
                <thead>
                  <tr>
                    <th scope="col" className="salary-table__col-row-num">
                      #
                    </th>
                    <th>Employee</th>
                    <th>Code</th>
                    <th className="salary-table__num">Amount</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Note / reason</th>
                    {canManageSalary ? <th className="cell-actions-col--text">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((transfer, index) => {
                    const status = transferStatusBadge(transfer.status);
                    const rowNumber = (pagination.page - 1) * pagination.limit + index + 1;
                    const noteText = transfer.failureReason || transfer.note || '—';
                    const isUpdating = updatingId === transfer.id;

                    return (
                      <tr key={transfer.id}>
                        <td
                          data-label="#"
                          className="salary-table__row-num"
                          aria-label={`Row ${rowNumber}`}
                        >
                          {rowNumber}
                        </td>
                        <td data-label="Employee">
                          <Link
                            to={`/admin/users/${transfer.userId}`}
                            className="table-link cell-ellipsis salary-table__name"
                            title={transfer.userName}
                          >
                            {transfer.userName}
                          </Link>
                        </td>
                        <td data-label="Code" className="salary-table__code">
                          {transfer.employeeCode || '—'}
                        </td>
                        <td data-label="Amount" className="salary-table__num salary-table__net">
                          {formatINRCurrency(transfer.amount)}
                        </td>
                        <td data-label="Status">
                          <span className={status.className}>{status.label}</span>
                          {transfer.paidAt ? (
                            <div className="muted small">Paid {formatISTDate(transfer.paidAt)}</div>
                          ) : null}
                        </td>
                        <td data-label="Updated" className="salary-table__updated">
                          {transfer.updatedAt ? formatISTDateTime(transfer.updatedAt) : '—'}
                        </td>
                        <td data-label="Note / reason" className="cell-ellipsis" title={noteText}>
                          {noteText}
                        </td>
                        {canManageSalary ? (
                          <td data-label="Actions" className="cell-actions">
                            <div className="cell-actions__group">
                              {transfer.status !== 'paid' ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={isUpdating || generating}
                                  onClick={() => handleStatusUpdate(transfer, 'paid')}
                                >
                                  Mark paid
                                </button>
                              ) : null}
                              {transfer.status !== 'failed' ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={isUpdating || generating}
                                  onClick={() => openFailModal(transfer)}
                                >
                                  Mark failed
                                </button>
                              ) : null}
                              {transfer.status !== 'pending' ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={isUpdating || generating}
                                  onClick={() => handleStatusUpdate(transfer, 'pending')}
                                >
                                  Mark pending
                                </button>
                              ) : null}
                            </div>
                          </td>
                        ) : null}
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

      {failModal
        ? createPortal(
            <div className="modal__backdrop" role="presentation" onClick={closeFailModal}>
              <div
                className="modal modal--compact salary-transfer-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={failModalTitleId}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="modal__header">
                  <h2 id={failModalTitleId} className="modal__title">
                    Mark failed — {failModal.userName}
                  </h2>
                  <p className="modal__lead muted">
                    Record why this disbursement failed. The amount stays on file for follow-up.
                  </p>
                </header>
                <form className="modal__form" onSubmit={handleConfirmFail}>
                  <div className="modal__body">
                    {failError ? (
                      <div className="alert alert--error modal__alert">{failError}</div>
                    ) : null}

                    <label className="modal__field">
                      <span className="label" htmlFor="transfer-failure-reason">
                        Failure reason (optional)
                      </span>
                      <textarea
                        id="transfer-failure-reason"
                        className="input"
                        rows={3}
                        value={failReason}
                        onChange={(event) => setFailReason(event.target.value)}
                        placeholder="e.g. Invalid account number, bank rejection…"
                        disabled={Boolean(updatingId)}
                        maxLength={500}
                      />
                    </label>
                  </div>
                  <footer className="modal__footer">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={closeFailModal}
                      disabled={Boolean(updatingId)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={Boolean(updatingId)}>
                      {updatingId ? 'Saving…' : 'Mark failed'}
                    </button>
                  </footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SalarySettingsTab({ onSettingsSaved, onGoToTransfers }) {
  const { showSuccess } = useToast();
  const { hasPermission } = useAuth();
  const canManageSalary = hasPermission(PERMISSIONS.SALARY_WRITE);
  const [payrollDay, setPayrollDay] = useState('');
  const [nextPayrollDate, setNextPayrollDate] = useState(null);
  const [pendingTransfersCount, setPendingTransfersCount] = useState(0);
  const [transferStatsMonth, setTransferStatsMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    setLoading(true);
    setError('');
    salaryApi
      .getSettings()
      .then((data) => {
        const settings = data.settings ?? {};
        setPayrollDay(
          settings.payrollDayOfMonth != null ? String(settings.payrollDayOfMonth) : '',
        );
        setNextPayrollDate(settings.nextPayrollDate ?? null);
        setPendingTransfersCount(data.transferStats?.pendingCount ?? 0);
        setTransferStatsMonth(data.transferStats?.month ?? '');
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(event) {
    event.preventDefault();
    if (!canManageSalary) return;

    setSaving(true);
    setError('');
    setFieldErrors({});

    const payload = {
      payrollDayOfMonth: payrollDay === '' ? null : Number(payrollDay),
    };

    const validation = validateForm(updateSalarySettingsSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSaving(false);
      return;
    }

    try {
      const data = await salaryApi.updateSettings(validation.data);
      const settings = data.settings ?? {};
      setPayrollDay(settings.payrollDayOfMonth != null ? String(settings.payrollDayOfMonth) : '');
      setNextPayrollDate(settings.nextPayrollDate ?? null);
      showSuccess('Payroll schedule saved.');
      onSettingsSaved?.(settings);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="card card--form salary-settings" aria-label="Payroll schedule settings">
        <div className="skeleton-stack" aria-busy="true" aria-label="Loading payroll settings">
          <div className="skeleton skeleton--title" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </div>
      </section>
    );
  }

  return (
    <section className="card card--form salary-settings" aria-label="Payroll schedule settings">
      <p className="card__section-title">Payroll schedule</p>
      <p className="card__lead">
        Configure when payroll is scheduled each month. This date drives the Next Payroll Date stat
        on Monthly Payroll — it does not trigger bank transfers or payslip generation.
      </p>

      {error ? <div className="alert alert--error">{error}</div> : null}

      <form className="form-grid salary-settings__form" onSubmit={handleSave}>
        <label>
          Payroll day of month
          <SelectField
            id="payroll-day-of-month"
            value={payrollDay}
            onChange={setPayrollDay}
            options={PAYROLL_DAY_OPTIONS}
            aria-label="Payroll day of month"
            disabled={!canManageSalary || saving}
          />
          <FieldError message={fieldErrors.payrollDayOfMonth} />
          <p className="muted small">
            Day 1–28 of each month (IST). Shorter months use the last day when needed.
          </p>
        </label>

        <div className="salary-settings__preview" aria-live="polite">
          <span className="label">Next payroll date</span>
          <strong>{formatPayrollDateKey(nextPayrollDate)}</strong>
          <p className="muted small">
            {payrollDay
              ? `Calculated from day ${payrollDay} of each month (IST).`
              : 'Set a payroll day to show the next scheduled date.'}
          </p>
        </div>

        <div className="salary-settings__note form-grid__full muted small">
          <strong>Pending transfers:</strong>{' '}
          {pendingTransfersCount}{' '}
          {transferStatsMonth ? `for ${transferStatsMonth}` : 'this month'} awaiting disbursement.{' '}
          {onGoToTransfers ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onGoToTransfers}>
              Manage in Transfers tab
            </button>
          ) : null}
        </div>

        {canManageSalary ? (
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save schedule'}
            </button>
          </div>
        ) : (
          <p className="muted small form-grid__full salary-settings__readonly">
            You need salary write permission to change payroll schedule.
          </p>
        )}
      </form>
    </section>
  );
}

export default function AdminSalarySummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = SALARY_TABS.some((tab) => tab.id === searchParams.get('tab'))
    ? searchParams.get('tab')
    : 'monthly';

  const [yearFilter, setYearFilter] = useState(() =>
    clampYearToCurrent(parseMonthFilterValue(getTodayMonthIst()).year),
  );
  const [monthPartFilter, setMonthPartFilter] = useState(
    () => parseMonthFilterValue(getTodayMonthIst()).month,
  );
  const [transferYearFilter, setTransferYearFilter] = useState(() =>
    clampYearToCurrent(parseMonthFilterValue(getTodayMonthIst()).year),
  );
  const [transferMonthPartFilter, setTransferMonthPartFilter] = useState(
    () => parseMonthFilterValue(getTodayMonthIst()).month,
  );
  const month = useMemo(
    () => toMonthFilterValue(yearFilter, monthPartFilter),
    [yearFilter, monthPartFilter],
  );
  const transferMonth = useMemo(
    () => toMonthFilterValue(transferYearFilter, transferMonthPartFilter),
    [transferYearFilter, transferMonthPartFilter],
  );
  const [summaries, setSummaries] = useState([]);
  const [meta, setMeta] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const setActiveTab = useCallback(
    (tabId) => {
      setSearchParams(tabId === 'monthly' ? {} : { tab: tabId }, { replace: true });
    },
    [setSearchParams],
  );

  const loadSummaries = useCallback(async () => {
    setLoading(true);
    setError('');
    setSelectedId(null);
    try {
      const data = await salaryApi.listSummaries(month);
      setSummaries(data.summaries ?? []);
      setMeta(data.meta ?? null);
    } catch (err) {
      setSummaries([]);
      setMeta(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    if (activeTab === 'monthly') {
      loadSummaries();
    }
  }, [activeTab, loadSummaries]);

  useEffect(() => {
    setPage(1);
  }, [month, search]);

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

  const handleSettingsSaved = useCallback(
    (settings) => {
      setMeta((current) =>
        current
          ? {
              ...current,
              payrollDayOfMonth: settings.payrollDayOfMonth ?? null,
              nextPayrollDate: settings.nextPayrollDate ?? null,
            }
          : current,
      );
    },
    [],
  );

  const { hasPermission } = useAuth();
  const canManageSalary = hasPermission(PERMISSIONS.SALARY_WRITE);

  return (
    <div className="page page--salary">
      <nav className="salary-tabs" aria-label="Salary management sections">
        {SALARY_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`salary-tabs__tab${activeTab === tab.id ? ' salary-tabs__tab--active' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'monthly' ? (
        <MonthlyPayrollTab
          month={month}
          yearFilter={yearFilter}
          monthPartFilter={monthPartFilter}
          setYearFilter={setYearFilter}
          setMonthPartFilter={setMonthPartFilter}
          summaries={summaries}
          meta={meta}
          loading={loading}
          error={error}
          exporting={exporting}
          onExport={handleExport}
          search={search}
          setSearch={setSearch}
          page={page}
          setPage={setPage}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
        />
      ) : null}

      {activeTab === 'structure' ? <SalaryStructureTab canManageSalary={canManageSalary} /> : null}

      {activeTab === 'transfers' ? (
        <TransfersTab
          month={transferMonth}
          yearFilter={transferYearFilter}
          monthPartFilter={transferMonthPartFilter}
          setYearFilter={setTransferYearFilter}
          setMonthPartFilter={setTransferMonthPartFilter}
          canManageSalary={canManageSalary}
        />
      ) : null}

      {activeTab === 'settings' ? (
        <SalarySettingsTab
          onSettingsSaved={handleSettingsSaved}
          onGoToTransfers={() => setActiveTab('transfers')}
        />
      ) : null}
    </div>
  );
}
