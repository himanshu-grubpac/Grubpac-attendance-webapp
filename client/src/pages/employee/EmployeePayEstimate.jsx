import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import PageLoading from '../../components/PageLoading.jsx';
import { getErrorMessage, salaryApi } from '../../services/api.js';
import {
  formatINRCurrency,
  formatISTDate,
} from '../../utils/datetime.js';
import {
  buildSalaryMonthOptions,
  buildSalaryYearOptions,
  clampMonthPartForYear,
  clampMonthValue,
  clampYearToCurrentIst,
  getTodayMonthIst,
} from '../../components/MonthField.jsx';
import { SalaryHistorySection } from '../admin/SalaryAuditSections.jsx';
import { usePortalSync } from '../../hooks/usePortalSync.js';
import { PORTAL_TOPICS } from '../../utils/portalSync.js';

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
                <th>Monthly salary (INR)</th>
                <td data-label="Monthly salary (INR)">{formatINRCurrency(summary.monthlySalary)}</td>
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
                <th>Loss of pay (days)</th>
                <td data-label="Loss of pay (days)">{summary.lopDays}</td>
              </tr>
              <tr>
                <th>Paid days (out of 30)</th>
                <td data-label="Paid days (out of 30)">{summary.paidDaysOutOf30 ?? '—'}</td>
              </tr>
              <tr>
                <th>LOP dates</th>
                <td data-label="LOP dates">
                  {(summary.lopDates ?? []).length === 0 ? (
                    'None — no loss of pay this month.'
                  ) : (
                    <span className="salary-detail__lop-tags">
                      {(summary.lopDates ?? []).map((entry, i) => (
                        <span key={i} className="salary-detail__lop-tag">
                          {formatLopDate(entry)}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
              <tr>
                <th>Loss of pay till date (INR)</th>
                <td data-label="Loss of pay till date (INR)">{formatINRCurrency(summary.lopDeduction)}</td>
              </tr>
              <tr>
                <th>Month-to-date payable (INR)</th>
                <td data-label="Month-to-date payable (INR)">{formatINRCurrency(summary.payableEstimate)}</td>
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
  const employeeBounds = useMemo(
    () => ({
      joiningDate: user?.joiningDate ?? null,
      endingDate: user?.endingDate ?? null,
    }),
    [user?.joiningDate, user?.endingDate],
  );
  const initialPeriod = useMemo(() => {
    const [year, month] = getTodayMonthIst().split('-');
    const clamped = clampMonthValue(`${year}-${month}`, employeeBounds);
    const [clampedYear, clampedMonth] = clamped.split('-');
    return {
      year: clampedYear,
      month: clampedMonth,
    };
  }, [employeeBounds]);
  const [yearFilter, setYearFilter] = useState(initialPeriod.year);
  const [monthPartFilter, setMonthPartFilter] = useState(initialPeriod.month);
  const yearOptions = useMemo(
    () => buildSalaryYearOptions(employeeBounds),
    [employeeBounds, yearFilter, monthPartFilter],
  );
  const monthOptions = useMemo(
    () => buildSalaryMonthOptions(yearFilter, employeeBounds),
    [employeeBounds, yearFilter],
  );
  const month = `${yearFilter}-${monthPartFilter}`;

  useEffect(() => {
    if (!user?.id) return;
    const clamped = clampMonthValue(`${yearFilter}-${monthPartFilter}`, employeeBounds);
    const [nextYear, nextMonth] = clamped.split('-');
    if (nextYear !== yearFilter) {
      setYearFilter(nextYear);
    }
    if (nextMonth !== monthPartFilter) {
      setMonthPartFilter(nextMonth);
    }
  }, [user?.id, employeeBounds, yearFilter, monthPartFilter]);

  const handleYearChange = (value) => {
    const nextYear = clampYearToCurrentIst(value, employeeBounds);
    setYearFilter(nextYear);
    setMonthPartFilter((currentMonth) =>
      clampMonthPartForYear(nextYear, currentMonth, employeeBounds),
    );
  };

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadSummary = useCallback(async () => {
    if (!user?.id) return;

    setLoading(true);
    setError('');
    try {
      const data = await salaryApi.getSummary({ month, userId: user.id });
      setSummary(data.summary ?? null);
    } catch (err) {
      setSummary(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [month, user?.id]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  usePortalSync(loadSummary, {
    topics: [PORTAL_TOPICS.PAYROLL],
    userId: user?.id,
    month,
  });

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
                  onChange={handleYearChange}
                  options={yearOptions}
                  aria-label="Pay year"
                  disabled={loading}
                />
                <SelectField
                  value={monthPartFilter}
                  onChange={setMonthPartFilter}
                  options={monthOptions}
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
