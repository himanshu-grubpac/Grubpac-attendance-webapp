import { useEffect, useState } from 'react';
import { getISTDateInputValue } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

export default function EmployeeLeaveBalances() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [balances, setBalances] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadData() {
    setLoading(true);
    setError('');
    try {
      const [balanceData, policyData] = await Promise.all([
        leaveApi.getMyBalances({ year }),
        leaveApi.listPolicies(),
      ]);
      setBalances(balanceData.balances ?? []);
      setPolicies(policyData.policies ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [year]);

  return (
    <div className="page">
      {error && <div className="alert alert--error">{error}</div>}

      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline form-field--sm">
            <span className="label">Year</span>
            <input
              className="input--narrow"
              type="number"
              min="2020"
              max="2100"
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
            />
          </label>
          <span className="muted small form-actions__hint">As of {getISTDateInputValue()}</span>
        </div>

        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : balances.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No leave balances for this year"
            description="Balances appear once leave policies are assigned to your account."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Entitled</th>
                  <th>Carried</th>
                  <th>Used</th>
                  <th>Pending</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Type">
                      <strong>{item.leaveTypeCode}</strong>
                      <div className="muted small">{item.leaveTypeName}</div>
                    </td>
                    <td data-label="Entitled">{item.entitled}</td>
                    <td data-label="Carried">{item.carried}</td>
                    <td data-label="Used">{item.used}</td>
                    <td data-label="Pending">{item.pending}</td>
                    <td data-label="Available">
                      <strong>{item.available}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {policies.length > 0 && (
        <div className="card">
          <p className="card__section-title">Company policy summary</p>
          <ul className="policy-list">
            {policies.map((policy) => (
              <li key={policy.id}>
                <strong>{policy.leaveTypeCode}</strong>: {policy.annualQuota}/year
                {policy.accrualPerMonth > 0 ? ` (${policy.accrualPerMonth}/month accrual)` : ''}
                {policy.requireDocAfterConsecutiveDays
                  ? ` · Medical cert if >${policy.requireDocAfterConsecutiveDays} consecutive days`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
