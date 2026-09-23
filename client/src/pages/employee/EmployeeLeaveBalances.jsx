import { useCallback, useEffect, useState } from 'react';
import { getISTDateInputValue, getISTYear } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import { usePortalSync } from '../../hooks/usePortalSync.js';
import { PORTAL_TOPICS } from '../../utils/portalSync.js';

function normalizeYears(years) {
  const currentYear = getISTYear();
  return [...new Set(
    [...(years ?? []), currentYear]
      .map(Number)
      .filter((year) => Number.isInteger(year) && year <= currentYear),
  )].sort((a, b) => b - a);
}

function buildYearOptions(years) {
  return normalizeYears(years).map((year) => ({ value: String(year), label: String(year) }));
}

function resolveDefaultYear(years) {
  const currentYear = getISTYear();
  const merged = normalizeYears(years);
  if (merged.includes(currentYear)) return String(currentYear);
  return String(merged[0] ?? currentYear);
}

export default function EmployeeLeaveBalances() {
  const [year, setYear] = useState(() => String(getISTYear()));
  const [yearOptions, setYearOptions] = useState(() => buildYearOptions([]));
  const [balances, setBalances] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await leaveApi.getMyYears();
        if (cancelled) return;
        const years = Array.isArray(data?.years) ? data.years : [];
        const options = buildYearOptions(years);
        setYearOptions(options);
        setYear((prev) => {
          if (options.some((opt) => opt.value === prev)) return prev;
          return resolveDefaultYear(years);
        });
      } catch {
        if (cancelled) return;
        setYearOptions(buildYearOptions([]));
        setYear(String(getISTYear()));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [balanceData, policyData] = await Promise.all([
        leaveApi.getMyBalances({ year: Number(year) }),
        leaveApi.listPolicies({ year: Number(year) }),
      ]);
      setBalances(balanceData.balances ?? []);
      setPolicies(policyData.policies ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  usePortalSync(() => {
    void loadData();
  }, { topics: [PORTAL_TOPICS.LEAVE, PORTAL_TOPICS.PAYROLL, PORTAL_TOPICS.POLICY] });

  return (
    <div className="page">
      {error && <div className="alert alert--error">{error}</div>}

      <div className="card card--table">
        <div className="card__toolbar">
          <label className="field-inline form-field--sm">
            <span className="label">Year</span>
            <SelectField
              value={year}
              onChange={setYear}
              options={yearOptions}
              aria-label="Year"
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
          <div className="table-wrap table-wrap--responsive leave-balances-table-wrap">
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
                {policy.accrualPerMonth > 0 ? ` (reference accrual rate ${policy.accrualPerMonth}/month; granted upfront)` : ''}
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
