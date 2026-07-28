import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { adjustLeaveBalanceSchema, createLeavePolicySchema, createLeaveTypeSchema, updateLeavePolicySchema } from '@shared/validation/leave.js';
import { PERMISSIONS } from '@shared/permissions.js';
import { adminApi, leaveApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { validateForm } from '../../utils/validation.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import FieldError from '../../components/FieldError.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const currentCalendarYear = new Date().getFullYear();

const emptyCreditForm = {
  userId: '',
  leaveTypeId: '',
  fromYear: currentCalendarYear - 1,
  toYear: currentCalendarYear,
  carried: '',
  reason: '',
};

const emptyTypeForm = {
  code: '',
  name: '',
  isActive: true,
};

const emptyPolicyForm = {
  leaveTypeId: '',
  year: String(currentCalendarYear),
  annualQuota: '',
  accrualPerMonth: '0',
  carryForwardMax: '0',
  maxAccumulation: '0',
  requireDocAfterConsecutiveDays: '',
  encashmentMaxPerYear: '0',
  combinedCarryGroup: '',
  paid: true,
  isActive: true,
};

function buildYearOptions() {
  const years = [];
  for (let year = currentCalendarYear - 2; year <= currentCalendarYear + 1; year += 1) {
    years.push({ value: String(year), label: String(year) });
  }
  return years;
}

const balanceYearOptions = buildYearOptions();

const MIN_BALANCE_YEAR = 2000;
const MAX_BALANCE_YEAR = 2100;

function isValidBalanceYear(year) {
  const numericYear = Number(year);
  return (
    year !== '' &&
    year != null &&
    !Number.isNaN(numericYear) &&
    numericYear >= MIN_BALANCE_YEAR &&
    numericYear <= MAX_BALANCE_YEAR
  );
}

function buildCarryAuditReason(fromYear, toYear, userReason) {
  const prefix = `Carry from ${fromYear} to ${toYear}`;
  const trimmed = userReason.trim();
  if (!trimmed) return prefix;
  return `${prefix}: ${trimmed}`;
}

function TableSkeleton() {
  return (
    <div className="leave-policies-table-skeleton" aria-busy="true" aria-label="Loading leave policies">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

function formatDays(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : String(value);
}

function policyToForm(policy) {
  return {
    annualQuota: policy.annualQuota,
    accrualPerMonth: policy.accrualPerMonth,
    carryForwardMax: policy.carryForwardMax,
    maxAccumulation: policy.maxAccumulation,
    requireDocAfterConsecutiveDays:
      policy.requireDocAfterConsecutiveDays == null
        ? ''
        : String(policy.requireDocAfterConsecutiveDays),
    encashmentMaxPerYear: policy.encashmentMaxPerYear,
    combinedCarryGroup: policy.combinedCarryGroup ?? '',
    paid: Boolean(policy.paid),
    isActive: Boolean(policy.isActive),
  };
}

function formToPayload(form) {
  return {
    annualQuota: Number(form.annualQuota),
    accrualPerMonth: Number(form.accrualPerMonth),
    carryForwardMax: Number(form.carryForwardMax),
    maxAccumulation: Number(form.maxAccumulation),
    encashmentMaxPerYear: Number(form.encashmentMaxPerYear),
    paid: Boolean(form.paid),
    isActive: Boolean(form.isActive),
    requireDocAfterConsecutiveDays:
      form.requireDocAfterConsecutiveDays === ''
        ? null
        : Number(form.requireDocAfterConsecutiveDays),
    combinedCarryGroup: form.combinedCarryGroup.trim() === '' ? null : form.combinedCarryGroup.trim(),
  };
}

function createPolicyFormToPayload(form) {
  return {
    leaveTypeId: form.leaveTypeId,
    year: Number(form.year),
    ...formToPayload(form),
  };
}

export default function AdminLeavePolicies() {
  const { showSuccess } = useToast();
  const { hasPermission } = useAuth();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const editModalTitleId = useId();
  const balanceModalTitleId = useId();
  const addTypeModalTitleId = useId();
  const addPolicyModalTitleId = useId();
  const canAdjustBalances = hasPermission(PERMISSIONS.LEAVE_ADJUST_BALANCES);
  const canManagePolicies = hasPermission(PERMISSIONS.LEAVE_MANAGE_POLICIES);

  const [policies, setPolicies] = useState([]);
  const [policyYear, setPolicyYear] = useState(String(currentCalendarYear));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modalPolicy, setModalPolicy] = useState(null);
  const [form, setForm] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [modalError, setModalError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [balanceModalOpen, setBalanceModalOpen] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const debouncedEmployeeSearch = useDebouncedValue(employeeSearch, 350);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [balances, setBalances] = useState([]);
  const [fromBalances, setFromBalances] = useState([]);
  const [creditForm, setCreditForm] = useState(emptyCreditForm);
  const [creditErrors, setCreditErrors] = useState({});
  const [balanceError, setBalanceError] = useState('');
  const [creditSubmitting, setCreditSubmitting] = useState(false);

  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [typeForm, setTypeForm] = useState(emptyTypeForm);
  const [typeFieldErrors, setTypeFieldErrors] = useState({});
  const [typeModalError, setTypeModalError] = useState('');
  const [typeSubmitting, setTypeSubmitting] = useState(false);

  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const [policyForm, setPolicyForm] = useState(emptyPolicyForm);
  const [policyFieldErrors, setPolicyFieldErrors] = useState({});
  const [policyModalError, setPolicyModalError] = useState('');
  const [policySubmitting, setPolicySubmitting] = useState(false);

  const requestKeyRef = useRef('');

  const loadPolicies = useCallback(async () => {
    const requestKey = String(Date.now());
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError('');

    try {
      const data = await leaveApi.listPolicies({ year: Number(policyYear) });
      if (requestKeyRef.current !== requestKey) return;
      setPolicies(data.policies ?? []);
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
      }
    }
  }, [policyYear]);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

  const loadLeaveTypes = useCallback(async () => {
    try {
      const typeData = await leaveApi.listTypes();
      setLeaveTypes(typeData.types ?? []);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!canManagePolicies) return;
    loadLeaveTypes();
  }, [canManagePolicies, loadLeaveTypes]);

  useEffect(() => {
    if (!canAdjustBalances || !balanceModalOpen) return;

    adminApi
      .listEmployees({
        page: 1,
        limit: 100,
        search: debouncedEmployeeSearch || undefined,
      })
      .then((employeeData) => setEmployees(employeeData.employees ?? []))
      .catch((err) => setBalanceError(getErrorMessage(err)));
  }, [canAdjustBalances, balanceModalOpen, debouncedEmployeeSearch]);

  useEffect(() => {
    if (!canAdjustBalances || !balanceModalOpen || !creditForm.userId) {
      setBalances([]);
      setFromBalances([]);
      return;
    }

    if (!isValidBalanceYear(creditForm.fromYear) || !isValidBalanceYear(creditForm.toYear)) {
      setBalances([]);
      setFromBalances([]);
      setBalanceError('');
      return;
    }

    Promise.all([
      leaveApi.getBalances({ userId: creditForm.userId, year: creditForm.toYear }),
      leaveApi.getBalances({ userId: creditForm.userId, year: creditForm.fromYear }),
    ])
      .then(([toYearData, fromYearData]) => {
        setBalances(toYearData.balances ?? []);
        setFromBalances(fromYearData.balances ?? []);
      })
      .catch((err) => setBalanceError(getErrorMessage(err)));
  }, [
    canAdjustBalances,
    balanceModalOpen,
    creditForm.userId,
    creditForm.fromYear,
    creditForm.toYear,
  ]);

  async function refreshBalances() {
    if (!creditForm.userId) return;
    if (!isValidBalanceYear(creditForm.fromYear) || !isValidBalanceYear(creditForm.toYear)) {
      setBalances([]);
      setFromBalances([]);
      return;
    }
    const [toYearData, fromYearData] = await Promise.all([
      leaveApi.getBalances({ userId: creditForm.userId, year: creditForm.toYear }),
      leaveApi.getBalances({ userId: creditForm.userId, year: creditForm.fromYear }),
    ]);
    setBalances(toYearData.balances ?? []);
    setFromBalances(fromYearData.balances ?? []);
  }

  async function handleCreditSubmit(event) {
    event.preventDefault();
    setBalanceError('');

    if (!creditForm.userId) {
      setBalanceError('Select an employee.');
      return;
    }

    const fromYear = Number(creditForm.fromYear);
    const toYear = Number(creditForm.toYear);
    const yearErrors = {};

    if (!creditForm.fromYear || Number.isNaN(fromYear)) {
      yearErrors.fromYear = 'Select the source (from) year.';
    }
    if (!creditForm.toYear || Number.isNaN(toYear)) {
      yearErrors.toYear = 'Select the target (to) year.';
    }
    if (
      !Number.isNaN(fromYear) &&
      !Number.isNaN(toYear) &&
      creditForm.fromYear &&
      creditForm.toYear &&
      toYear < fromYear
    ) {
      yearErrors.toYear = 'To year must be the same as or after from year.';
    }
    if (Object.keys(yearErrors).length > 0) {
      setCreditErrors(yearErrors);
      return;
    }

    if (creditForm.carried === '' || Number.isNaN(Number(creditForm.carried))) {
      setCreditErrors({ carried: 'Enter the number of carried days.' });
      return;
    }

    const payload = {
      leaveTypeId: creditForm.leaveTypeId,
      year: toYear,
      carried: Number(creditForm.carried),
      reason: buildCarryAuditReason(fromYear, toYear, creditForm.reason),
    };

    const validation = validateForm(adjustLeaveBalanceSchema, payload);
    if (!validation.data) {
      setCreditErrors(validation.errors);
      return;
    }

    setCreditErrors({});

    await requestConfirm({
      title: 'Apply manual leave credit?',
      message: `Credit ${validation.data.carried} carried day(s) from ${fromYear} to ${validation.data.year} for the selected employee and leave type?`,
      confirmLabel: 'Apply credit',
      variant: 'danger',
      onConfirm: async () => {
        setCreditSubmitting(true);
        try {
          await leaveApi.adjustBalance(creditForm.userId, validation.data);
          showSuccess('Leave credit applied.');
          setCreditForm((prev) => ({ ...prev, carried: '', reason: '' }));
          await refreshBalances();
        } catch (err) {
          setBalanceError(getErrorMessage(err));
        } finally {
          setCreditSubmitting(false);
        }
      },
    });
  }

  function openBalanceModal() {
    const year = Number(policyYear);
    setCreditForm({
      ...emptyCreditForm,
      fromYear: year - 1,
      toYear: year,
    });
    setCreditErrors({});
    setBalanceError('');
    setEmployeeSearch('');
    setBalances([]);
    setFromBalances([]);
    setBalanceModalOpen(true);
  }

  function closeBalanceModal() {
    if (creditSubmitting) return;
    setBalanceModalOpen(false);
    setCreditForm(emptyCreditForm);
    setCreditErrors({});
    setBalanceError('');
    setEmployeeSearch('');
    setBalances([]);
    setFromBalances([]);
  }

  function openEditModal(policy) {
    setForm(policyToForm(policy));
    setFieldErrors({});
    setModalError('');
    setModalPolicy(policy);
  }

  function closeModal() {
    if (submitting) return;
    setModalPolicy(null);
    setForm(null);
    setFieldErrors({});
    setModalError('');
  }

  function openTypeModal() {
    setTypeForm(emptyTypeForm);
    setTypeFieldErrors({});
    setTypeModalError('');
    setTypeModalOpen(true);
  }

  function closeTypeModal() {
    if (typeSubmitting) return;
    setTypeModalOpen(false);
    setTypeForm(emptyTypeForm);
    setTypeFieldErrors({});
    setTypeModalError('');
  }

  function openPolicyModal() {
    setPolicyForm({
      ...emptyPolicyForm,
      year: policyYear,
    });
    setPolicyFieldErrors({});
    setPolicyModalError('');
    setPolicyModalOpen(true);
  }

  function closePolicyModal() {
    if (policySubmitting) return;
    setPolicyModalOpen(false);
    setPolicyForm(emptyPolicyForm);
    setPolicyFieldErrors({});
    setPolicyModalError('');
  }

  useEscapeKey(Boolean(modalPolicy), closeModal);
  useEscapeKey(balanceModalOpen && !creditSubmitting, closeBalanceModal);
  useEscapeKey(typeModalOpen && !typeSubmitting, closeTypeModal);
  useEscapeKey(policyModalOpen && !policySubmitting, closePolicyModal);

  async function handleTypeSubmit(event) {
    event.preventDefault();
    setTypeModalError('');

    const payload = {
      code: typeForm.code.trim().toUpperCase(),
      name: typeForm.name.trim(),
      isActive: Boolean(typeForm.isActive),
    };
    const validation = validateForm(createLeaveTypeSchema, payload);

    if (!validation.data) {
      setTypeFieldErrors(validation.errors);
      return;
    }

    setTypeFieldErrors({});
    setTypeSubmitting(true);

    try {
      await leaveApi.createType(validation.data);
      showSuccess(`Leave type ${validation.data.code} created.`);
      closeTypeModal();
      await loadLeaveTypes();
    } catch (err) {
      setTypeModalError(getErrorMessage(err));
    } finally {
      setTypeSubmitting(false);
    }
  }

  async function handlePolicyCreateSubmit(event) {
    event.preventDefault();
    setPolicyModalError('');

    if (!policyForm.leaveTypeId) {
      setPolicyFieldErrors({ leaveTypeId: 'Select a leave type.' });
      return;
    }

    const payload = createPolicyFormToPayload(policyForm);
    const validation = validateForm(createLeavePolicySchema, payload);

    if (!validation.data) {
      setPolicyFieldErrors(validation.errors);
      return;
    }

    setPolicyFieldErrors({});
    setPolicySubmitting(true);

    try {
      await leaveApi.createPolicy(validation.data);
      const typeLabel = leaveTypes.find((item) => item.id === validation.data.leaveTypeId);
      showSuccess(
        `Policy for ${typeLabel?.code ?? 'leave type'} (${validation.data.year}) created.`,
      );
      closePolicyModal();
      if (String(validation.data.year) !== policyYear) {
        setPolicyYear(String(validation.data.year));
      } else {
        await loadPolicies();
      }
    } catch (err) {
      setPolicyModalError(getErrorMessage(err));
    } finally {
      setPolicySubmitting(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!modalPolicy || !form) return;

    setSubmitting(true);
    setError('');
    setModalError('');

    const payload = formToPayload(form);
    const validation = validateForm(updateLeavePolicySchema, payload);

    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});

    try {
      await leaveApi.updatePolicy(modalPolicy.id, validation.data);
      showSuccess(`Policy for ${modalPolicy.leaveTypeCode} (${policyYear}) updated.`);
      closeModal();
      await loadPolicies();
    } catch (err) {
      setModalError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function getActionItems(policy) {
    return [
      {
        key: 'edit',
        label: 'Edit policy',
        onClick: () => openEditModal(policy),
      },
    ];
  }

  return (
    <div className="page page--leave-policies">
      <section className="leave-policies-panel card card--table" aria-label="Leave policies">
        <div className="leave-policies-toolbar card__toolbar">
          <div className="leave-policies-toolbar__filters filter-bar">
            <label className="field-inline filter-bar__field leave-policies-toolbar__field">
              <span className="label">Policy year</span>
              <SelectField
                value={policyYear}
                onChange={setPolicyYear}
                options={balanceYearOptions}
                aria-label="Policy year"
              />
            </label>
            <span className="badge badge-muted leave-policies-toolbar__year-badge">
              Showing {policyYear}
            </span>
          </div>
          {canManagePolicies ? (
            <div className="leave-policies-toolbar__actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={openTypeModal}>
                Add leave type
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={openPolicyModal}>
                Add policy
              </button>
            </div>
          ) : null}
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : policies.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title={`No leave policies for ${policyYear}`}
            description="Policies are configured per leave type and calendar year. Add a leave type and policy for this year."
            action={
              canManagePolicies ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={openPolicyModal}>
                  Add policy
                </button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap table-wrap--responsive leave-policies-table-wrap">
            <table className="table data-table leave-policies-table">
              <thead>
                <tr>
                  <th>Leave type</th>
                  <th>Annual quota</th>
                  <th>Accrual/mo</th>
                  <th>Max stock</th>
                  <th>CF max</th>
                  <th>Encash/yr</th>
                  <th>Paid</th>
                  <th>Status</th>
                  <th className="cell-actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td data-label="Leave type" className="leave-policies-table__type">
                      <code className="leave-policies-table__code">{policy.leaveTypeCode}</code>
                      <span className="leave-policies-table__name">{policy.leaveTypeName}</span>
                    </td>
                    <td data-label="Annual quota" className="leave-policies-table__num">
                      {formatDays(policy.annualQuota)}
                    </td>
                    <td data-label="Accrual/mo" className="leave-policies-table__num">
                      {formatDays(policy.accrualPerMonth)}
                    </td>
                    <td data-label="Max stock" className="leave-policies-table__num">
                      {formatDays(policy.maxAccumulation)}
                    </td>
                    <td data-label="CF max" className="leave-policies-table__num">
                      {formatDays(policy.carryForwardMax)}
                    </td>
                    <td data-label="Encash/yr" className="leave-policies-table__num">
                      {formatDays(policy.encashmentMaxPerYear)}
                    </td>
                    <td data-label="Paid">
                      <span className={`badge ${policy.paid ? 'badge-success' : 'badge-muted'}`}>
                        {policy.paid ? 'Paid' : 'Unpaid'}
                      </span>
                    </td>
                    <td data-label="Status">
                      <StatusBadge active={policy.isActive} />
                    </td>
                    <td data-label="Actions" className="cell-actions-col">
                      <ActionMenu
                        ariaLabel={`Actions for ${policy.leaveTypeCode} policy`}
                        items={getActionItems(policy)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canAdjustBalances ? (
        <section className="card leave-carry-forward-panel" aria-label="Manual leave balance entry">
          <div className="leave-carry-forward-panel__header">
            <div>
              <p className="card__section-title">Manual leave balance entry</p>
              <p className="muted small leave-carry-forward-panel__lead">
                Enter opening carried days for each employee and leave type at year start (enhanced
                leave, cash-in, or last-year balance). Amounts are typed manually — the system does
                not auto-calculate carry-forward.
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={openBalanceModal}>
              Add carried days
            </button>
          </div>
        </section>
      ) : null}

      {balanceModalOpen
        ? createPortal(
            <div className="modal__backdrop" role="presentation" onClick={closeBalanceModal}>
              <div
                className="modal modal--wide leave-policies-modal leave-carry-forward-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={balanceModalTitleId}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="modal__header leave-carry-forward-modal__header">
                  <div className="leave-carry-forward-modal__header-top">
                    <div className="leave-carry-forward-modal__header-titles">
                      <h2 id={balanceModalTitleId} className="modal__title">
                        Manual leave balance entry
                      </h2>
                      <p className="modal__lead muted">
                        Type carried days manually for an employee and leave type. Choose the source
                        year (leftover context) and target year (where days are credited). The
                        system does not auto-calculate carry-forward.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost leave-carry-forward-modal__close"
                      onClick={closeBalanceModal}
                      disabled={creditSubmitting}
                      aria-label="Close"
                    >
                      ×
                    </button>
                  </div>
                </header>

                <form className="modal__form" onSubmit={handleCreditSubmit}>
                  <div className="modal__body leave-policies-modal__body leave-carry-forward-modal__body">
                    {balanceError ? (
                      <div className="alert alert--error modal__alert">{balanceError}</div>
                    ) : null}

                    <label className="modal__field form-grid__full">
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

                    <div className="leave-policies-modal__grid">
                      <label className="modal__field">
                        <span className="label">Leave type</span>
                        <SelectField
                          value={creditForm.leaveTypeId}
                          onChange={(value) => setCreditForm({ ...creditForm, leaveTypeId: value })}
                          options={[
                            { value: '', label: 'Select type' },
                            ...leaveTypes
                              .filter((item) => item.isActive)
                              .map((item) => ({
                              value: item.id,
                              label: `${item.code} — ${item.name}`,
                            })),
                          ]}
                          placeholder="Select type"
                          aria-label="Leave type"
                        />
                        <FieldError message={creditErrors.leaveTypeId} />
                      </label>

                      <label className="modal__field">
                        <span className="label">From year</span>
                        <SelectField
                          value={String(creditForm.fromYear)}
                          onChange={(value) =>
                            setCreditForm({ ...creditForm, fromYear: value ? Number(value) : '' })
                          }
                          options={[
                            { value: '', label: 'Select year' },
                            ...balanceYearOptions,
                          ]}
                          placeholder="Select year"
                          aria-label="From year"
                        />
                        <FieldError message={creditErrors.fromYear} />
                      </label>

                      <label className="modal__field">
                        <span className="label">To year</span>
                        <SelectField
                          value={String(creditForm.toYear)}
                          onChange={(value) =>
                            setCreditForm({ ...creditForm, toYear: value ? Number(value) : '' })
                          }
                          options={[
                            { value: '', label: 'Select year' },
                            ...balanceYearOptions,
                          ]}
                          placeholder="Select year"
                          aria-label="To year"
                        />
                        <FieldError message={creditErrors.toYear} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Carried days</span>
                        <input
                          autoFocus
                          className="input input--narrow"
                          type="number"
                          step="0.5"
                          min="0"
                          max="365"
                          placeholder="e.g. 5"
                          value={creditForm.carried}
                          onChange={(event) =>
                            setCreditForm({ ...creditForm, carried: event.target.value })
                          }
                        />
                        <FieldError message={creditErrors.carried} />
                      </label>
                    </div>

                    <label className="modal__field">
                      <span className="label">Reason</span>
                      <input
                        className="input"
                        type="text"
                        value={creditForm.reason}
                        onChange={(event) =>
                          setCreditForm({ ...creditForm, reason: event.target.value })
                        }
                        placeholder="e.g. Year-end carry-in approved by HR (from→to years are recorded automatically)"
                      />
                      <FieldError message={creditErrors.reason} />
                    </label>

                    {fromBalances.length > 0 ? (
                      <div>
                        <p className="card__section-title">
                          Source year balances ({creditForm.fromYear})
                        </p>
                        <div className="table-wrap table-wrap--responsive leave-carry-forward-modal__table-wrap">
                          <table className="table data-table leave-carry-forward-table">
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
                              {fromBalances.map((item) => (
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
                    ) : null}

                    {balances.length > 0 ? (
                      <div>
                        <p className="card__section-title">
                          Target year balances ({creditForm.toYear})
                        </p>
                        <div className="table-wrap table-wrap--responsive leave-carry-forward-modal__table-wrap">
                          <table className="table data-table leave-carry-forward-table">
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
                    ) : null}
                  </div>

                  <footer className="modal__footer">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={closeBalanceModal}
                      disabled={creditSubmitting}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={creditSubmitting}>
                      {creditSubmitting ? 'Applying…' : 'Apply carried days'}
                    </button>
                  </footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}

      {confirmDialog}

      {typeModalOpen
        ? createPortal(
            <div className="modal__backdrop" role="presentation" onClick={closeTypeModal}>
              <div
                className="modal leave-policies-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={addTypeModalTitleId}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="modal__header">
                  <h2 id={addTypeModalTitleId} className="modal__title">
                    Add leave type
                  </h2>
                  <p className="modal__lead muted">
                    Create a new leave type code and name. Policies are added separately per year.
                  </p>
                </header>

                <form className="modal__form" onSubmit={handleTypeSubmit}>
                  <div className="modal__body leave-policies-modal__body">
                    {typeModalError ? (
                      <div className="alert alert--error modal__alert">{typeModalError}</div>
                    ) : null}

                    <div className="leave-policies-modal__grid">
                      <label className="modal__field">
                        <span className="label">Code</span>
                        <input
                          autoFocus
                          className="input input--narrow"
                          type="text"
                          maxLength={5}
                          placeholder="e.g. SL"
                          value={typeForm.code}
                          onChange={(event) =>
                            setTypeForm({ ...typeForm, code: event.target.value.toUpperCase() })
                          }
                        />
                        <FieldError message={typeFieldErrors.code} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Name</span>
                        <input
                          className="input"
                          type="text"
                          maxLength={100}
                          placeholder="e.g. Sick Leave"
                          value={typeForm.name}
                          onChange={(event) =>
                            setTypeForm({ ...typeForm, name: event.target.value })
                          }
                        />
                        <FieldError message={typeFieldErrors.name} />
                      </label>
                    </div>

                    <div className="leave-policies-modal__flags">
                      <label className="field-checkbox">
                        <input
                          type="checkbox"
                          checked={typeForm.isActive}
                          onChange={(event) =>
                            setTypeForm({ ...typeForm, isActive: event.target.checked })
                          }
                        />
                        <span>Active leave type</span>
                      </label>
                      <FieldError message={typeFieldErrors.isActive} />
                    </div>
                  </div>

                  <footer className="modal__footer">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={closeTypeModal}
                      disabled={typeSubmitting}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={typeSubmitting}>
                      {typeSubmitting ? 'Creating…' : 'Create leave type'}
                    </button>
                  </footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}

      {policyModalOpen
        ? createPortal(
            <div className="modal__backdrop" role="presentation" onClick={closePolicyModal}>
              <div
                className="modal modal--wide leave-policies-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={addPolicyModalTitleId}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="modal__header">
                  <h2 id={addPolicyModalTitleId} className="modal__title">
                    Add leave policy
                  </h2>
                  <p className="modal__lead muted">
                    Configure quota and rules for a leave type in a calendar year.
                  </p>
                </header>

                <form className="modal__form" onSubmit={handlePolicyCreateSubmit}>
                  <div className="modal__body leave-policies-modal__body">
                    {policyModalError ? (
                      <div className="alert alert--error modal__alert">{policyModalError}</div>
                    ) : null}

                    <div className="leave-policies-modal__grid">
                      <label className="modal__field">
                        <span className="label">Leave type</span>
                        <SelectField
                          value={policyForm.leaveTypeId}
                          onChange={(value) =>
                            setPolicyForm({ ...policyForm, leaveTypeId: value })
                          }
                          options={[
                            { value: '', label: 'Select type' },
                            ...leaveTypes.map((item) => ({
                              value: item.id,
                              label: `${item.code} — ${item.name}`,
                            })),
                          ]}
                          placeholder="Select type"
                          aria-label="Leave type"
                        />
                        <FieldError message={policyFieldErrors.leaveTypeId} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Policy year</span>
                        <SelectField
                          value={policyForm.year}
                          onChange={(value) => setPolicyForm({ ...policyForm, year: value })}
                          options={balanceYearOptions}
                          aria-label="Policy year"
                        />
                        <FieldError message={policyFieldErrors.year} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Annual quota (days)</span>
                        <input
                          className="input input--narrow"
                          type="number"
                          min={0}
                          max={365}
                          value={policyForm.annualQuota}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, annualQuota: event.target.value })
                          }
                        />
                        <FieldError message={policyFieldErrors.annualQuota} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Accrual per month</span>
                        <input
                          className="input input--narrow"
                          type="number"
                          min={0}
                          max={31}
                          step="0.5"
                          value={policyForm.accrualPerMonth}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, accrualPerMonth: event.target.value })
                          }
                        />
                        <FieldError message={policyFieldErrors.accrualPerMonth} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Max accumulation (days)</span>
                        <input
                          className="input input--narrow"
                          type="number"
                          min={0}
                          max={365}
                          value={policyForm.maxAccumulation}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, maxAccumulation: event.target.value })
                          }
                        />
                        <FieldError message={policyFieldErrors.maxAccumulation} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Carry-forward max (days)</span>
                        <input
                          className="input input--narrow"
                          type="number"
                          min={0}
                          max={365}
                          value={policyForm.carryForwardMax}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, carryForwardMax: event.target.value })
                          }
                        />
                        <FieldError message={policyFieldErrors.carryForwardMax} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Encashment max per year</span>
                        <input
                          className="input input--narrow"
                          type="number"
                          min={0}
                          max={365}
                          value={policyForm.encashmentMaxPerYear}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, encashmentMaxPerYear: event.target.value })
                          }
                        />
                        <FieldError message={policyFieldErrors.encashmentMaxPerYear} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Doc required after (consecutive days)</span>
                        <input
                          className="input input--narrow"
                          type="number"
                          min={1}
                          max={30}
                          placeholder="Not required"
                          value={policyForm.requireDocAfterConsecutiveDays}
                          onChange={(event) =>
                            setPolicyForm({
                              ...policyForm,
                              requireDocAfterConsecutiveDays: event.target.value,
                            })
                          }
                        />
                        <FieldError message={policyFieldErrors.requireDocAfterConsecutiveDays} />
                      </label>

                      <label className="modal__field">
                        <span className="label">Combined carry group</span>
                        <input
                          className="input input--narrow"
                          type="text"
                          maxLength={20}
                          placeholder="Optional"
                          value={policyForm.combinedCarryGroup}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, combinedCarryGroup: event.target.value })
                          }
                        />
                        <FieldError message={policyFieldErrors.combinedCarryGroup} />
                      </label>
                    </div>

                    <div className="leave-policies-modal__flags">
                      <label className="field-checkbox">
                        <input
                          type="checkbox"
                          checked={policyForm.paid}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, paid: event.target.checked })
                          }
                        />
                        <span>Paid leave</span>
                      </label>
                      <FieldError message={policyFieldErrors.paid} />

                      <label className="field-checkbox">
                        <input
                          type="checkbox"
                          checked={policyForm.isActive}
                          onChange={(event) =>
                            setPolicyForm({ ...policyForm, isActive: event.target.checked })
                          }
                        />
                        <span>Active policy</span>
                      </label>
                      <FieldError message={policyFieldErrors.isActive} />
                    </div>
                  </div>

                  <footer className="modal__footer">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={closePolicyModal}
                      disabled={policySubmitting}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={policySubmitting}>
                      {policySubmitting ? 'Creating…' : 'Create policy'}
                    </button>
                  </footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}

      {modalPolicy && form ? (
        <div className="modal__backdrop" role="presentation" onClick={closeModal}>
          <div
            className="modal modal--wide leave-policies-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={editModalTitleId}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal__header">
              <h2 id={editModalTitleId} className="modal__title">
                Edit policy: {modalPolicy.leaveTypeCode} ({policyYear})
              </h2>
              <p className="modal__lead muted">
                Update quota, accrual, carry-forward, and encashment rules for{' '}
                {modalPolicy.leaveTypeName} in calendar year {policyYear}.
              </p>
            </header>

            <form className="modal__form" onSubmit={handleSubmit}>
              <div className="modal__body leave-policies-modal__body">
                {modalError ? <div className="alert alert--error modal__alert">{modalError}</div> : null}

                <div className="leave-policies-modal__grid">
                  <label className="modal__field">
                    <span className="label">Annual quota (days)</span>
                    <input
                      autoFocus
                      className="input input--narrow"
                      type="number"
                      min={0}
                      max={365}
                      value={form.annualQuota}
                      onChange={(event) =>
                        setForm({ ...form, annualQuota: event.target.value })
                      }
                    />
                    <FieldError message={fieldErrors.annualQuota} />
                  </label>

                  <label className="modal__field">
                    <span className="label">Accrual per month</span>
                    <input
                      className="input input--narrow"
                      type="number"
                      min={0}
                      max={31}
                      step="0.5"
                      value={form.accrualPerMonth}
                      onChange={(event) =>
                        setForm({ ...form, accrualPerMonth: event.target.value })
                      }
                    />
                    <FieldError message={fieldErrors.accrualPerMonth} />
                  </label>

                  <label className="modal__field">
                    <span className="label">Max accumulation (days)</span>
                    <input
                      className="input input--narrow"
                      type="number"
                      min={0}
                      max={365}
                      value={form.maxAccumulation}
                      onChange={(event) =>
                        setForm({ ...form, maxAccumulation: event.target.value })
                      }
                    />
                    <FieldError message={fieldErrors.maxAccumulation} />
                  </label>

                  <label className="modal__field">
                    <span className="label">Carry-forward max (days)</span>
                    <input
                      className="input input--narrow"
                      type="number"
                      min={0}
                      max={365}
                      value={form.carryForwardMax}
                      onChange={(event) =>
                        setForm({ ...form, carryForwardMax: event.target.value })
                      }
                    />
                    <FieldError message={fieldErrors.carryForwardMax} />
                  </label>

                  <label className="modal__field">
                    <span className="label">Encashment max per year</span>
                    <input
                      className="input input--narrow"
                      type="number"
                      min={0}
                      max={365}
                      value={form.encashmentMaxPerYear}
                      onChange={(event) =>
                        setForm({ ...form, encashmentMaxPerYear: event.target.value })
                      }
                    />
                    <FieldError message={fieldErrors.encashmentMaxPerYear} />
                  </label>

                  <label className="modal__field">
                    <span className="label">Doc required after (consecutive days)</span>
                    <input
                      className="input input--narrow"
                      type="number"
                      min={1}
                      max={30}
                      placeholder="Not required"
                      value={form.requireDocAfterConsecutiveDays}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          requireDocAfterConsecutiveDays: event.target.value,
                        })
                      }
                    />
                    <FieldError message={fieldErrors.requireDocAfterConsecutiveDays} />
                  </label>

                  <label className="modal__field">
                    <span className="label">Combined carry group</span>
                    <input
                      className="input input--narrow"
                      type="text"
                      maxLength={20}
                      placeholder="Optional"
                      value={form.combinedCarryGroup}
                      onChange={(event) =>
                        setForm({ ...form, combinedCarryGroup: event.target.value })
                      }
                    />
                    <FieldError message={fieldErrors.combinedCarryGroup} />
                  </label>
                </div>

                <div className="leave-policies-modal__flags">
                  <label className="field-checkbox">
                    <input
                      type="checkbox"
                      checked={form.paid}
                      onChange={(event) => setForm({ ...form, paid: event.target.checked })}
                    />
                    <span>Paid leave</span>
                  </label>
                  <FieldError message={fieldErrors.paid} />

                  <label className="field-checkbox">
                    <input
                      type="checkbox"
                      checked={form.isActive}
                      onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                    />
                    <span>Active policy</span>
                  </label>
                  <FieldError message={fieldErrors.isActive} />
                </div>
              </div>

              <footer className="modal__footer">
                <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={submitting}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Saving…' : 'Save changes'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
