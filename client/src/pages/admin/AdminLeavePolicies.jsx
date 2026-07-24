import { useEffect, useState } from 'react';
import { updateLeavePolicySchema } from '@shared/validation/leave.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { validateForm } from '../../utils/validation.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

export default function AdminLeavePolicies() {
  const [policies, setPolicies] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadPolicies() {
    setLoading(true);
    setError('');
    try {
      const data = await leaveApi.listPolicies();
      setPolicies(data.policies ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPolicies();
  }, []);

  function startEdit(policy) {
    setEditing(policy.id);
    setForm({
      annualQuota: policy.annualQuota,
      accrualPerMonth: policy.accrualPerMonth,
      carryForwardMax: policy.carryForwardMax,
      maxAccumulation: policy.maxAccumulation,
      requireDocAfterConsecutiveDays: policy.requireDocAfterConsecutiveDays,
      encashmentMaxPerYear: policy.encashmentMaxPerYear,
      isActive: policy.isActive,
    });
  }

  useEscapeKey(Boolean(editing), () => setEditing(null));

  async function saveEdit(id) {
    const validation = validateForm(updateLeavePolicySchema, form);
    if (!validation.data) {
      setError(Object.values(validation.errors).join(' '));
      return;
    }

    try {
      await leaveApi.updatePolicy(id, validation.data);
      setMessage('Policy updated.');
      setEditing(null);
      await loadPolicies();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div className="page">
      {message && <div className="alert alert-success">{message}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="card card--table">
        {loading ? (
          <div className="skeleton-stack">
            <div className="skeleton skeleton--row" />
            <div className="skeleton skeleton--row" />
          </div>
        ) : policies.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No leave policies"
            description="Leave types and policies are configured in the system."
          />
        ) : (
          <div className="table-wrap table-wrap--responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Annual quota</th>
                  <th>Accrual/mo</th>
                  <th>Max stock</th>
                  <th>CF max</th>
                  <th>Encash/yr</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td data-label="Type">
                      <strong>{policy.leaveTypeCode}</strong>
                      <div className="muted small">{policy.leaveTypeName}</div>
                    </td>
                    <td data-label="Annual quota">
                      {editing === policy.id ? (
                        <input
                          className="input--narrow"
                          type="number"
                          value={form.annualQuota}
                          onChange={(event) =>
                            setForm({ ...form, annualQuota: Number(event.target.value) })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              saveEdit(policy.id);
                            }
                          }}
                        />
                      ) : (
                        policy.annualQuota
                      )}
                    </td>
                    <td data-label="Accrual/mo">
                      {editing === policy.id ? (
                        <input
                          className="input--narrow"
                          type="number"
                          step="0.5"
                          value={form.accrualPerMonth}
                          onChange={(event) =>
                            setForm({ ...form, accrualPerMonth: Number(event.target.value) })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              saveEdit(policy.id);
                            }
                          }}
                        />
                      ) : (
                        policy.accrualPerMonth
                      )}
                    </td>
                    <td data-label="Max stock">{policy.maxAccumulation}</td>
                    <td data-label="CF max">{policy.carryForwardMax}</td>
                    <td data-label="Encash/yr">{policy.encashmentMaxPerYear}</td>
                    <td data-label="Action" className="cell-actions">
                      {editing === policy.id ? (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => saveEdit(policy.id)}>
                            Save
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEdit(policy)}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
