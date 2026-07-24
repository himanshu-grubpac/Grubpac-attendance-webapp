import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import { getErrorMessage, salaryApi } from '../../services/api.js';
import {
  formatINRCurrency,
  formatISTDate,
  getISTMonthInputValue,
  previousISTMonthInput,
} from '../../utils/datetime.js';

import PageLoading from '../../components/PageLoading.jsx';

function SummaryCard({ title, summary, loading, error }) {
  if (loading) {
    return (
      <div className="card">
        <p className="card__section-title">{title}</p>
        <PageLoading compact text="Loading estimate…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <p className="card__section-title">{title}</p>
        <div className="alert alert--error">{error}</div>
      </div>
    );
  }

  if (!summary) {
    return null;
  }

  return (
    <div className="card">
      <p className="card__section-title">{title}</p>
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
                <th>Month</th>
                <td data-label="Month">{summary.month}</td>
              </tr>
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
                <th>LOP / unpaid estimate</th>
                <td data-label="LOP / unpaid estimate">{summary.lopDays}</td>
              </tr>
              <tr>
                <th>Payable estimate (INR)</th>
                <td data-label="Payable estimate (INR)">{formatINRCurrency(summary.payableEstimate)}</td>
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
  const currentMonth = getISTMonthInputValue();
  const previousMonth = previousISTMonthInput(currentMonth);

  const [currentSummary, setCurrentSummary] = useState(null);
  const [previousSummary, setPreviousSummary] = useState(null);
  const [currentLoading, setCurrentLoading] = useState(true);
  const [previousLoading, setPreviousLoading] = useState(true);
  const [currentError, setCurrentError] = useState('');
  const [previousError, setPreviousError] = useState('');

  useEffect(() => {
    if (!user?.id) return;

    setCurrentLoading(true);
    salaryApi
      .getSummary({ month: currentMonth, userId: user.id })
      .then((data) => {
        setCurrentSummary(data.summary ?? null);
        setCurrentError('');
      })
      .catch((err) => setCurrentError(getErrorMessage(err)))
      .finally(() => setCurrentLoading(false));

    setPreviousLoading(true);
    salaryApi
      .getSummary({ month: previousMonth, userId: user.id })
      .then((data) => {
        setPreviousSummary(data.summary ?? null);
        setPreviousError('');
      })
      .catch((err) => setPreviousError(getErrorMessage(err)))
      .finally(() => setPreviousLoading(false));
  }, [user?.id, currentMonth, previousMonth]);

  return (
    <div className="page">
      <SummaryCard
        title={`Current month (${currentMonth})`}
        summary={currentSummary}
        loading={currentLoading}
        error={currentError}
      />
      <SummaryCard
        title={`Previous month (${previousMonth})`}
        summary={previousSummary}
        loading={previousLoading}
        error={previousError}
      />
    </div>
  );
}
