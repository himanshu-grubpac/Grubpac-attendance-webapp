import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import PageLoading from '../../components/PageLoading.jsx';
import { getErrorMessage, salaryApi } from '../../services/api.js';
import {
  formatINRCurrency,
  formatISTDate,
  getISTMonthInputValue,
} from '../../utils/datetime.js';
import { getTodayMonthIst } from '../../components/MonthField.jsx';
import { SalaryHistorySection } from '../admin/SalaryAuditSections.jsx';

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

const YEAR_OPTIONS = buildYearOptions();

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1).padStart(2, '0'),
  label: new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2020, index, 1))),
}));

function formatLopDate(entry) {
  if (typeof entry === 'string') return entry;
  if (entry == null) return '';
  return entry.unpaidDays != null && Number(entry.unpaidDays) !== 1
    ? `${entry.date} (${entry.unpaidDays} day)`
    : String(entry.date ?? entry);
}

function MonthBreakdown({ summary, loading, error }) {
  if (loading) {
    return (
      <div className="card">
        <p className="card__section-title">Month breakdown</p>
        <PageLoading compact text="Loading estimate…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <p className="card__section-title">Month breakdown</p>
        <div className="alert alert--error">{error}</div>
      </div>
    );
  }

  if (!summary) {
    return null;
  }

  return (
    <div className="card">
      <p className="card__section-title">Month breakdown ({summary.month})</p>
      <p className="card__lead">
        Estimate only — not a payslip or bank payout.
      </p>
      {!summary.hasSalaryConfigured ? (
        <EmptyState
          compact
          icon={EMPTY_ICONS.payroll}
          title="Salary not configured"
          description="Monthly salary is not set for your account. Contact HR for details."
        />
      ) : (
        <div className="table-wrap table-wrap--kv">
          <table className="kv-table">
            <tbody>
              <tr>
                <th>Gross salary (INR)</th>
                <td data-label="Gross salary (INR)">{formatINRCurrency(summary.monthlySalary)}</td>
              </tr>
              {summary.salaryEffectiveFrom && (
                <tr>
                  <th>Effective from</th>
                  <td data-label="Effective from">{formatISTDate(summary.salaryEffectiveFrom)}</td>
                </tr>
              )}
              <tr>
                <th>Working days</th>
                <td data-label="Working days">{summary.workingDaysInMonth}</td>
              </tr>
              <tr>
                <th>Present days</th>
                <td data-label="Present days">{summary.presentDays}</td>
              </tr>
              <tr>
                <th>Paid leave days</th>
                <td data-label="Paid leave days">{summary.paidLeaveDays}</td>
              </tr>
              <tr>
                <th>Payable days</th>
                <td data-label="Payable days">{summary.payableDays}</td>
              </tr>
              <tr>
                <th>LOP days</th>
                <td data-label="LOP days">{summary.lopDays}</td>
              </tr>
              <tr>
                <th>LOP dates</th>
                <td data-label="LOP dates">
                  {(summary.lopDates ?? []).length === 0
                    ? 'None — no loss of pay this month.'
                    : (summary.lopDates ?? []).map(formatLopDate).join(', ')}
                </td>
              </tr>
              <tr>
                <th>LOP amount (INR)</th>
                <td data-label="LOP amount (INR)">{formatINRCurrency(summary.lopDeduction)}</td>
              </tr>
              <tr>
                <th>Net payable (INR)</th>
                <td data-label="Net payable (INR)">{formatINRCurrency(summary.payableEstimate)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function EmployeePayEstimate() {
  const { user } = useAuth();
  const [yearFilter, setYearFilter] = useState(() => getISTMonthInputValue().split('-')[0]);
  const [monthPartFilter, setMonthPartFilter] = useState(() => getISTMonthInputValue().split('-')[1]);
  const month = `${yearFilter}-${monthPartFilter}`;

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.id) return;

    setLoading(true);
    setError('');
    salaryApi
      .getSummary({ month, userId: user.id })
      .then((data) => {
        setSummary(data.summary ?? null);
      })
      .catch((err) => {
        setSummary(null);
        setError(getErrorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [user?.id, month]);

  return (
    <div className="page">
      <section className="salary-panel card card--table" aria-label="Pay month picker">
        <div className="salary-toolbar card__toolbar">
          <div className="salary-toolbar__filters filter-bar">
            <div className="field-inline filter-bar__field salary-toolbar__field salary-toolbar__field--period">
              <span className="label">Pay period</span>
              <div className="salary-toolbar__period">
                <SelectField
                  value={yearFilter}
                  onChange={setYearFilter}
                  options={YEAR_OPTIONS}
                  aria-label="Pay year"
                  disabled={loading}
                />
                <SelectField
                  value={monthPartFilter}
                  onChange={setMonthPartFilter}
                  options={MONTH_OPTIONS}
                  aria-label="Pay month"
                  disabled={loading}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <MonthBreakdown summary={summary} loading={loading} error={error} />

      {user?.id ? (
        <SalaryHistorySection fixedUserId={user.id} title="My salary history" />
      ) : null}
    </div>
  );
}
