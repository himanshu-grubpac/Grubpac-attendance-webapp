import { useEffect, useState } from 'react';
import { adjustLeaveBalanceSchema, encashLeaveSchema } from '@shared/validation/leave.js';
import { adminApi, leaveApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import SearchInput from '../../components/SearchInput.jsx';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import SelectField from '../../components/SelectField.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

const emptyForm = {
  userId: '',
  leaveTypeId: '',
  year: new Date().getFullYear(),
  entitled: '',
  used: '',
  pending: '',
  carried: '',
  encashed: '',
  reason: '',
};

const emptyEncashForm = {
  days: '',
  reason: '',
};

export default function AdminLeaveBalanceAdjust() {
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [employees, setEmployees] = useState([]);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const debouncedEmployeeSearch = useDebouncedValue(employeeSearch, 350);
  const [types, setTypes] = useState([]);
  const [balances, setBalances] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [encashForm, setEncashForm] = useState(emptyEncashForm);
  const [cfYear, setCfYear] = useState(new Date().getFullYear() - 1);
  const [fieldErrors, setFieldErrors] = useState({});
  const [encashErrors, setEncashErrors] = useState({});
  const [error, setError] = useState('');
  const [cfSubmitting, setCfSubmitting] = useState(false);

  useEffect(() => {
    adminApi
      .listEmployees({
        page: 1,
        limit: 100,
        search: debouncedEmployeeSearch || undefined,
      })
      .then((employeeData) => setEmployees(employeeData.employees ?? []))
      .catch((err) => setError(getErrorMessage(err)));
  }, [debouncedEmployeeSearch]);

  useEffect(() => {
    leaveApi.listTypes().then((typeData) => {
      setTypes((typeData.types ?? []).filter((item) => item.isActive));
    }).catch((err) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => {
    if (!form.userId) {
      setBalances([]);
      return;
    }

    leaveApi
      .getBalances({ userId: form.userId, year: form.year })
      .then((data) => setBalances(data.balances ?? []))
      .catch((err) => setError(getErrorMessage(err)));
  }, [form.userId, form.year]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    const payload = {
      leaveTypeId: form.leaveTypeId,
      year: Number(form.year),
      reason: form.reason,
      ...(form.entitled !== '' ? { entitled: Number(form.entitled) } : {}),
      ...(form.used !== '' ? { used: Number(form.used) } : {}),
      ...(form.pending !== '' ? { pending: Number(form.pending) } : {}),
      ...(form.carried !== '' ? { carried: Number(form.carried) } : {}),
      ...(form.encashed !== '' ? { encashed: Number(form.encashed) } : {}),
    };

    const validation = validateForm(adjustLeaveBalanceSchema, payload);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      return;
    }

    if (!form.userId) {
      setError('Select an employee.');
      return;
    }

    await requestConfirm({
      title: 'Apply balance adjustment?',
      message: 'This updates leave balances for the selected employee. Confirm only if the values are correct.',
      confirmLabel: 'Save adjustment',
      variant: 'danger',
      onConfirm: async () => {
        setFieldErrors({});
        await leaveApi.adjustBalance(form.userId, validation.data);
        showSuccess('Balance adjusted.');
        const data = await leaveApi.getBalances({ userId: form.userId, year: form.year });
        setBalances(data.balances ?? []);
      },
    });
  }

  async function handleEncash(event) {
    event.preventDefault();
    setError('');

    if (!form.userId || !form.leaveTypeId) {
      setError('Select employee and leave type for encashment.');
      return;
    }

    const payload = {
      leaveTypeId: form.leaveTypeId,
      year: Number(form.year),
      days: Number(encashForm.days),
      reason: encashForm.reason,
    };

    const validation = validateForm(encashLeaveSchema, payload);
    if (!validation.data) {
      setEncashErrors(validation.errors);
      return;
    }

    setEncashErrors({});

    await requestConfirm({
      title: 'Record encashment?',
      message: `Record ${validation.data.days} day(s) of encashment? Available balance will be reduced.`,
      confirmLabel: 'Record encashment',
      variant: 'danger',
      onConfirm: async () => {
        await leaveApi.encashBalance(form.userId, validation.data);
        showSuccess('Encashment recorded (balance reduced; not a payroll payout).');
        setEncashForm(emptyEncashForm);
        const data = await leaveApi.getBalances({ userId: form.userId, year: form.year });
        setBalances(data.balances ?? []);
      },
    });
  }

  async function handleCarryForward() {
    await requestConfirm({
      title: 'Apply year-end carry-forward?',
      message: `Apply carry-forward from ${cfYear} to ${cfYear + 1} for all active employees? This affects leave balances company-wide.`,
      confirmLabel: 'Apply carry-forward',
      variant: 'danger',
      onConfirm: async () => {
        setCfSubmitting(true);
        setError('');
        try {
          const result = await leaveApi.applyCarryForward({ fromYear: cfYear });
          showSuccess(
            `Carry-forward applied: ${result.adjustments} balance adjustment(s) for ${cfYear} → ${result.toYear}.`,
          );
          if (form.userId) {
            const data = await leaveApi.getBalances({ userId: form.userId, year: form.year });
            setBalances(data.balances ?? []);
          }
        } finally {
          setCfSubmitting(false);
        }
      },
    });
  }

  return (
    <div className="page page--form">
      {error ? (
        <div className="page-alerts">
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <div className="card">
        <div className="toolbar-row">
          <label className="field-inline form-field--sm">
            <span className="label">Carry-forward from year</span>
            <input
              className="input--narrow"
              type="number"
              min="2000"
              max="2100"
              value={cfYear}
              onChange={(event) => setCfYear(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={cfSubmitting}
            onClick={handleCarryForward}
          >
            {cfSubmitting ? 'Applying…' : 'Apply year-end carry-forward'}
          </button>
          <span className="muted small form-actions__hint">
            SL max CF 23; CL+EL combined CF 20 (handbook caps).
          </span>
        </div>
      </div>

      <form className="card card--form form-grid" onSubmit={handleSubmit}>
        <p className="card__section-title form-grid__full">Adjust balance</p>
        <label className="form-grid__full">
          <span className="label">Employee</span>
          <div className="field-stack">
            <SearchInput
              value={employeeSearch}
              onChange={(event) => setEmployeeSearch(event.target.value)}
              placeholder="Search employees…"
              ariaLabel="Search employees"
            />
            <SelectField
              value={form.userId}
              onChange={(value) => setForm({ ...form, userId: value })}
              options={[
                { value: '', label: 'Select employee' },
                ...employees.map((employee) => ({
                  value: employee.id,
                  label: `${employee.name} (${employee.email})`,
                })),
              ]}
              placeholder="Select employee"
              aria-label="Employee"
            />
          </div>
        </label>

        <label>
          <span className="label">Leave type</span>
          <SelectField
            value={form.leaveTypeId}
            onChange={(value) => setForm({ ...form, leaveTypeId: value })}
            options={[
              { value: '', label: 'Select type' },
              ...types.map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` })),
            ]}
            placeholder="Select type"
            aria-label="Leave type"
          />
          <FieldError message={fieldErrors.leaveTypeId} />
        </label>

        <label className="form-field--sm">
          <span className="label">Year</span>
          <input
            className="input--narrow"
            type="number"
            value={form.year}
            onChange={(event) => setForm({ ...form, year: Number(event.target.value) })}
          />
        </label>

        {['entitled', 'used', 'pending', 'carried', 'encashed'].map((field) => (
          <label key={field} className="form-field--sm">
            <span className="label">{field.charAt(0).toUpperCase() + field.slice(1)}</span>
            <input
              className="input--narrow"
              type="number"
              step="0.5"
              placeholder="Leave blank to keep unchanged"
              value={form[field]}
              onChange={(event) => setForm({ ...form, [field]: event.target.value })}
            />
          </label>
        ))}

        <label className="form-grid__full">
          <span className="label">Reason</span>
          <input
            type="text"
            value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })}
          />
          <FieldError message={fieldErrors.reason} />
        </label>

        <div className="form-actions form-actions--sticky">
          <button type="submit" className="btn btn-primary">
            Save adjustment
          </button>
        </div>
      </form>

      <form className="card card--form form-grid" onSubmit={handleEncash}>
        <p className="card__section-title form-grid__full">Record encashment</p>
        <p className="muted small form-grid__full">
          Increments encashed and reduces available balance (max 10/year for CL/EL). Not a payroll payout.
        </p>
        <label className="form-field--sm">
          <span className="label">Days to encash</span>
          <input
            className="input--narrow"
            type="number"
            step="0.5"
            min="0.5"
            value={encashForm.days}
            onChange={(event) => setEncashForm({ ...encashForm, days: event.target.value })}
          />
          <FieldError message={encashErrors.days} />
        </label>
        <label className="form-grid__full">
          <span className="label">Reason</span>
          <input
            type="text"
            value={encashForm.reason}
            onChange={(event) => setEncashForm({ ...encashForm, reason: event.target.value })}
          />
          <FieldError message={encashErrors.reason} />
        </label>
        <div className="form-actions form-actions--sticky">
          <button type="submit" className="btn btn-primary">
            Record encashment
          </button>
        </div>
      </form>

      {balances.length > 0 && (
        <div className="card card--table">
          <div className="card__section">
            <p className="card__section-title">Current balances</p>
          <div className="table-wrap table-wrap--responsive">
            <table className="table data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Entitled</th>
                  <th>Carried</th>
                  <th>Used</th>
                  <th>Pending</th>
                  <th>Encashed</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Type">{item.leaveTypeCode}</td>
                    <td data-label="Entitled">{item.entitled}</td>
                    <td data-label="Carried">{item.carried}</td>
                    <td data-label="Used">{item.used}</td>
                    <td data-label="Pending">{item.pending}</td>
                    <td data-label="Encashed">{item.encashed}</td>
                    <td data-label="Available">{item.available}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
