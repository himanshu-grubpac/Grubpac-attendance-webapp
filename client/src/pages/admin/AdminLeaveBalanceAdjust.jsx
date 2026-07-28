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

const emptyCreditForm = {
  userId: '',
  leaveTypeId: '',
  year: new Date().getFullYear(),
  carried: '',
  reason: '',
};

const emptyAdjustForm = {
  entitled: '',
  used: '',
  pending: '',
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
  const [creditForm, setCreditForm] = useState(emptyCreditForm);
  const [adjustForm, setAdjustForm] = useState(emptyAdjustForm);
  const [encashForm, setEncashForm] = useState(emptyEncashForm);
  const [creditErrors, setCreditErrors] = useState({});
  const [adjustErrors, setAdjustErrors] = useState({});
  const [encashErrors, setEncashErrors] = useState({});
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

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
    if (!creditForm.userId) {
      setBalances([]);
      return;
    }

    leaveApi
      .getBalances({ userId: creditForm.userId, year: creditForm.year })
      .then((data) => setBalances(data.balances ?? []))
      .catch((err) => setError(getErrorMessage(err)));
  }, [creditForm.userId, creditForm.year]);

  async function refreshBalances() {
    if (!creditForm.userId) return;
    const data = await leaveApi.getBalances({ userId: creditForm.userId, year: creditForm.year });
    setBalances(data.balances ?? []);
  }

  async function handleCreditSubmit(event) {
    event.preventDefault();
    setError('');

    if (!creditForm.userId) {
      setError('Select an employee.');
      return;
    }

    if (creditForm.carried === '' || Number.isNaN(Number(creditForm.carried))) {
      setCreditErrors({ carried: 'Enter the number of carried days.' });
      return;
    }

    const payload = {
      leaveTypeId: creditForm.leaveTypeId,
      year: Number(creditForm.year),
      carried: Number(creditForm.carried),
      reason: creditForm.reason.trim(),
    };

    const validation = validateForm(adjustLeaveBalanceSchema, payload);
    if (!validation.data) {
      setCreditErrors(validation.errors);
      return;
    }

    setCreditErrors({});

    await requestConfirm({
      title: 'Apply manual leave credit?',
      message: `Set ${validation.data.carried} carried day(s) for the selected employee and leave type in ${validation.data.year}?`,
      confirmLabel: 'Apply credit',
      variant: 'danger',
      onConfirm: async () => {
        await leaveApi.adjustBalance(creditForm.userId, validation.data);
        showSuccess('Leave credit applied.');
        setCreditForm((prev) => ({ ...prev, carried: '', reason: '' }));
        await refreshBalances();
      },
    });
  }

  async function handleAdjustSubmit(event) {
    event.preventDefault();
    setError('');

    if (!creditForm.userId || !creditForm.leaveTypeId) {
      setError('Select employee and leave type before adjusting other fields.');
      return;
    }

    const payload = {
      leaveTypeId: creditForm.leaveTypeId,
      year: Number(creditForm.year),
      reason: adjustForm.reason,
      ...(adjustForm.entitled !== '' ? { entitled: Number(adjustForm.entitled) } : {}),
      ...(adjustForm.used !== '' ? { used: Number(adjustForm.used) } : {}),
      ...(adjustForm.pending !== '' ? { pending: Number(adjustForm.pending) } : {}),
      ...(adjustForm.encashed !== '' ? { encashed: Number(adjustForm.encashed) } : {}),
    };

    const validation = validateForm(adjustLeaveBalanceSchema, payload);
    if (!validation.data) {
      setAdjustErrors(validation.errors);
      return;
    }

    const hasFieldChange =
      validation.data.entitled !== undefined ||
      validation.data.used !== undefined ||
      validation.data.pending !== undefined ||
      validation.data.encashed !== undefined;

    if (!hasFieldChange) {
      setAdjustErrors({ entitled: 'Enter at least one balance field to adjust.' });
      return;
    }

    setAdjustErrors({});

    await requestConfirm({
      title: 'Apply balance adjustment?',
      message: 'This updates leave balances for the selected employee. Confirm only if the values are correct.',
      confirmLabel: 'Save adjustment',
      variant: 'danger',
      onConfirm: async () => {
        await leaveApi.adjustBalance(creditForm.userId, validation.data);
        showSuccess('Balance adjusted.');
        setAdjustForm(emptyAdjustForm);
        await refreshBalances();
      },
    });
  }

  async function handleEncash(event) {
    event.preventDefault();
    setError('');

    if (!creditForm.userId || !creditForm.leaveTypeId) {
      setError('Select employee and leave type for encashment.');
      return;
    }

    const payload = {
      leaveTypeId: creditForm.leaveTypeId,
      year: Number(creditForm.year),
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
        await leaveApi.encashBalance(creditForm.userId, validation.data);
        showSuccess('Encashment recorded (balance reduced; not a payroll payout).');
        setEncashForm(emptyEncashForm);
        await refreshBalances();
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
        <p className="card__section-title">Manual leave balance entry</p>
        <p className="muted small">
          Enter opening carried days for each employee and leave type at year start (enhanced leave,
          cash-in, or last-year balance). Amounts are typed manually — the system does not auto-calculate
          carry-forward.
        </p>
      </div>

      <form className="card card--form form-grid" onSubmit={handleCreditSubmit}>
        <p className="card__section-title form-grid__full">Add carried days</p>
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
              value={creditForm.userId}
              onChange={(value) => setCreditForm({ ...creditForm, userId: value })}
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
            value={creditForm.leaveTypeId}
            onChange={(value) => setCreditForm({ ...creditForm, leaveTypeId: value })}
            options={[
              { value: '', label: 'Select type' },
              ...types.map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` })),
            ]}
            placeholder="Select type"
            aria-label="Leave type"
          />
          <FieldError message={creditErrors.leaveTypeId} />
        </label>

        <label className="form-field--sm">
          <span className="label">Target year</span>
          <input
            className="input--narrow"
            type="number"
            min="2000"
            max="2100"
            value={creditForm.year}
            onChange={(event) => setCreditForm({ ...creditForm, year: Number(event.target.value) })}
          />
          <FieldError message={creditErrors.year} />
        </label>

        <label className="form-field--sm">
          <span className="label">Carried days</span>
          <input
            className="input--narrow"
            type="number"
            step="0.5"
            min="0"
            max="365"
            placeholder="e.g. 5"
            value={creditForm.carried}
            onChange={(event) => setCreditForm({ ...creditForm, carried: event.target.value })}
          />
          <FieldError message={creditErrors.carried} />
        </label>

        <label className="form-grid__full">
          <span className="label">Reason</span>
          <input
            type="text"
            value={creditForm.reason}
            onChange={(event) => setCreditForm({ ...creditForm, reason: event.target.value })}
            placeholder="e.g. Year-end carry-in approved by HR"
          />
          <FieldError message={creditErrors.reason} />
        </label>

        <div className="form-actions form-actions--sticky">
          <button type="submit" className="btn btn-primary">
            Apply carried days
          </button>
        </div>
      </form>

      <div className="card">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowAdvanced((value) => !value)}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? 'Hide advanced adjustment' : 'Show advanced adjustment'}
        </button>
      </div>

      {showAdvanced ? (
        <form className="card card--form form-grid" onSubmit={handleAdjustSubmit}>
          <p className="card__section-title form-grid__full">Adjust other balance fields</p>
          <p className="muted small form-grid__full">
            Uses the employee, leave type, and target year selected above. Leave fields blank to keep
            unchanged.
          </p>

          {['entitled', 'used', 'pending', 'encashed'].map((field) => (
            <label key={field} className="form-field--sm">
              <span className="label">{field.charAt(0).toUpperCase() + field.slice(1)}</span>
              <input
                className="input--narrow"
                type="number"
                step="0.5"
                placeholder="Leave blank to keep unchanged"
                value={adjustForm[field]}
                onChange={(event) => setAdjustForm({ ...adjustForm, [field]: event.target.value })}
              />
              <FieldError message={adjustErrors[field]} />
            </label>
          ))}

          <label className="form-grid__full">
            <span className="label">Reason</span>
            <input
              type="text"
              value={adjustForm.reason}
              onChange={(event) => setAdjustForm({ ...adjustForm, reason: event.target.value })}
            />
            <FieldError message={adjustErrors.reason} />
          </label>

          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary">
              Save adjustment
            </button>
          </div>
        </form>
      ) : null}

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
