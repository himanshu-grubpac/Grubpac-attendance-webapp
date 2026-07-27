import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { updateLeavePolicySchema } from '@shared/validation/leave.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { validateForm } from '../../utils/validation.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import FieldError from '../../components/FieldError.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

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

function summarizeCarryForwardEmployees(employees) {
  let eligibleEmployees = 0;
  let totalCarried = 0;
  let totalForfeited = 0;

  for (const employee of employees) {
    const pendingLines = employee.lines.filter((line) => !line.alreadyApplied && line.carried > 0);
    if (pendingLines.length === 0) continue;
    eligibleEmployees += 1;
    totalCarried += pendingLines.reduce((sum, line) => sum + (line.carried ?? 0), 0);
    totalForfeited += employee.lines
      .filter((line) => !line.alreadyApplied)
      .reduce((sum, line) => sum + (line.forfeited ?? 0), 0);
  }

  return {
    employeeCount: employees.length,
    eligibleEmployees,
    totalCarried,
    totalForfeited,
  };
}

function patchEmployeeAfterCarryForward(preview, userId, result) {
  if (!preview) return preview;

  const appliedByType = new Map(
    (result.details ?? []).map((detail) => [detail.leaveTypeId, detail]),
  );

  const employees = preview.employees.map((employee) => {
    if (employee.userId !== userId) return employee;

    const lines = employee.lines.map((line) => {
      const applied = appliedByType.get(line.leaveTypeId);
      if (!applied) return line;
      return {
        ...line,
        remaining: applied.remaining,
        carried: applied.carried,
        forfeited: applied.forfeited,
        alreadyApplied: true,
      };
    });

    const pendingLines = lines.filter((line) => !line.alreadyApplied && line.carried > 0);
    const appliedLines = lines.filter((line) => line.alreadyApplied);

    return {
      ...employee,
      lines,
      totalRemaining: lines.reduce((sum, line) => sum + (line.remaining ?? 0), 0),
      totalCarried: pendingLines.reduce((sum, line) => sum + (line.carried ?? 0), 0),
      totalForfeited: lines
        .filter((line) => !line.alreadyApplied)
        .reduce((sum, line) => sum + (line.forfeited ?? 0), 0),
      pendingAdjustments: pendingLines.length,
      alreadyAppliedCount: appliedLines.length,
      hasAlreadyApplied: appliedLines.length > 0,
    };
  });

  return {
    ...preview,
    employees,
    summary: summarizeCarryForwardEmployees(employees),
  };
}

function defaultCarryForwardYear() {
  return new Date().getFullYear() - 1;
}

function getCarryForwardLineStatus(line) {
  const badge = 'badge leave-carry-forward-table__badge';
  if (line.alreadyApplied) {
    return {
      label: 'Applied',
      title: 'Already applied',
      className: `${badge} badge-success`,
    };
  }
  if (line.carried > 0) {
    return {
      label: 'Pending',
      title: 'Pending carry forward',
      className: `${badge} badge-warning`,
    };
  }
  return {
    label: 'None',
    title: 'No carry forward',
    className: `${badge} badge-muted`,
  };
}

function filterCarryForwardEmployees(employees, { searchQuery, pendingOnly }) {
  const query = searchQuery.trim().toLowerCase();

  return employees.filter((employee) => {
    if (query) {
      const haystack = `${employee.name ?? ''} ${employee.email ?? ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (pendingOnly) {
      return employee.lines.some((line) => !line.alreadyApplied && line.carried > 0);
    }
    return true;
  });
}

function getVisibleCarryForwardLines(employee, pendingOnly) {
  if (!pendingOnly) return employee.lines;
  return employee.lines.filter((line) => !line.alreadyApplied && line.carried > 0);
}

function CarryForwardTableSkeleton() {
  return (
    <div
      className="leave-carry-forward-modal__table-wrap leave-carry-forward-modal__table-wrap--loading"
      aria-busy="true"
      aria-label="Loading carry-forward preview"
    >
      <div className="leave-carry-forward-modal__loading">
        <div className="spinner" aria-hidden="true" />
        <p className="muted small">Loading preview balances…</p>
      </div>
    </div>
  );
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

function CarryForwardPreviewModal({
  open,
  fromYear,
  preview,
  loading,
  error,
  submitting,
  applyingUserId,
  titleId,
  onClose,
  onApplyAll,
  onApplyEmployee,
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);

  useEffect(() => {
    if (open) {
      setSearchQuery('');
      setPendingOnly(false);
    }
  }, [open]);

  const toYear = fromYear + 1;
  const hasRows = preview?.employees?.length > 0;
  const canApplyAll = preview?.summary?.eligibleEmployees > 0;
  const isBusy = submitting || Boolean(applyingUserId);

  const filteredEmployees = useMemo(() => {
    if (!preview?.employees) return [];
    return filterCarryForwardEmployees(preview.employees, { searchQuery, pendingOnly });
  }, [pendingOnly, preview?.employees, searchQuery]);

  const hasFilteredRows = filteredEmployees.length > 0;
  const showToolbar = Boolean(preview && hasRows && !loading);

  if (!open) return null;

  return createPortal(
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wide leave-carry-forward-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={loading || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header leave-carry-forward-modal__header">
          <div className="leave-carry-forward-modal__header-top">
            <div className="leave-carry-forward-modal__header-titles">
              <h2 id={titleId} className="modal__title">
                Carry forward preview
              </h2>
              <p className="leave-carry-forward-modal__subtitle muted">
                {fromYear} → {toYear}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm leave-carry-forward-modal__close"
              onClick={onClose}
              disabled={isBusy}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <p className="modal__lead muted">
            Review remaining balances before rolling unused paid leave into the next year. Caps
            follow each policy&apos;s CF max (SL 23; CL+EL combined 20).
          </p>
          {preview && !loading ? (
            <div
              className="card-grid card-grid--stats leave-carry-forward-modal__stats"
              aria-label="Preview summary"
            >
              <div className="stat-card leave-carry-forward-modal__stat">
                <span className="stat-card__label">Eligible employees</span>
                <span className="stat-card__value">{preview.summary.eligibleEmployees}</span>
              </div>
              <div className="stat-card leave-carry-forward-modal__stat leave-carry-forward-modal__stat--carry">
                <span className="stat-card__label">Days to carry</span>
                <span className="stat-card__value">{formatDays(preview.summary.totalCarried)}</span>
              </div>
              <div className="stat-card leave-carry-forward-modal__stat leave-carry-forward-modal__stat--forfeit">
                <span className="stat-card__label">Days forfeited</span>
                <span className="stat-card__value">{formatDays(preview.summary.totalForfeited)}</span>
              </div>
            </div>
          ) : null}
        </header>

        <div className="modal__body leave-carry-forward-modal__body">
          {error ? <div className="alert alert--error modal__alert">{error}</div> : null}

          {showToolbar ? (
            <div className="leave-carry-forward-modal__toolbar toolbar-row">
              <label className="field-inline form-field--sm leave-carry-forward-modal__search">
                <span className="label">Search employee</span>
                <input
                  className="input"
                  type="search"
                  placeholder="Name or email…"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="field-checkbox leave-carry-forward-modal__pending-filter">
                <input
                  type="checkbox"
                  checked={pendingOnly}
                  onChange={(event) => setPendingOnly(event.target.checked)}
                />
                <span>Pending only</span>
              </label>
            </div>
          ) : null}

          {loading ? (
            <CarryForwardTableSkeleton />
          ) : preview && !hasRows ? (
            <EmptyState
              compact
              icon={EMPTY_ICONS.leave}
              className="leave-carry-forward-modal__empty"
              title="No eligible employees"
              description={`No employees with remaining balances in ${fromYear} for eligible leave types.`}
            />
          ) : hasRows && !hasFilteredRows ? (
            <EmptyState
              compact
              icon={EMPTY_ICONS.users}
              className="leave-carry-forward-modal__empty"
              title="No matching employees"
              description={
                pendingOnly
                  ? 'No employees have pending carry-forward adjustments. Try clearing filters.'
                  : 'No employees match your search. Try a different name or email.'
              }
            />
          ) : hasFilteredRows ? (
            <div className="table-wrap table-wrap--fit table-wrap--responsive leave-carry-forward-modal__table-wrap">
              <table className="table data-table leave-carry-forward-table">
                <colgroup>
                  <col className="leave-carry-forward-table__col-row" />
                  <col className="leave-carry-forward-table__col-employee" />
                  <col className="leave-carry-forward-table__col-type" />
                  <col className="leave-carry-forward-table__col-num" />
                  <col className="leave-carry-forward-table__col-num" />
                  <col className="leave-carry-forward-table__col-num" />
                  <col className="leave-carry-forward-table__col-status" />
                  <col className="leave-carry-forward-table__col-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className="employees-table__col-row-num">
                      #
                    </th>
                    <th scope="col">Employee</th>
                    <th scope="col">Type</th>
                    <th
                      scope="col"
                      className="leave-carry-forward-table__col-num"
                      title="Remaining balance"
                    >
                      Bal.
                    </th>
                    <th scope="col" className="leave-carry-forward-table__col-num">
                      Carry
                    </th>
                    <th scope="col" className="leave-carry-forward-table__col-num">
                      Forfeit
                    </th>
                    <th scope="col">Status</th>
                    <th className="cell-actions-col cell-actions-col--text leave-carry-forward-table__col-action" scope="col">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.flatMap((employee, employeeIndex) => {
                    const visibleLines = getVisibleCarryForwardLines(employee, pendingOnly);
                    if (visibleLines.length === 0) return [];

                    const rowNumber = employeeIndex + 1;
                    const lineStatus = (line) => getCarryForwardLineStatus(line);

                    return visibleLines.map((line, lineIndex) => (
                      <tr key={`${employee.userId}-${line.leaveTypeId}`}>
                        {lineIndex === 0 ? (
                          <td
                            className="employees-table__row-num"
                            data-label="#"
                            rowSpan={visibleLines.length}
                            aria-label={`Row ${rowNumber}`}
                          >
                            {rowNumber}
                          </td>
                        ) : null}
                        {lineIndex === 0 ? (
                          <td data-label="Employee" rowSpan={visibleLines.length}>
                            <span className="leave-carry-forward-table__name" title={employee.name}>
                              {employee.name}
                            </span>
                            <span
                              className="leave-carry-forward-table__email muted small"
                              title={employee.email}
                            >
                              {employee.email}
                            </span>
                          </td>
                        ) : null}
                        <td data-label="Leave type" className="leave-carry-forward-table__type-cell">
                          <span className="leave-carry-forward-table__type-inner">
                            <code className="leave-policies-table__code">{line.leaveTypeCode}</code>
                            {line.combinedGroup ? (
                              <span
                                className="badge badge-info leave-carry-forward-table__group-badge"
                                title={`Combined carry group: ${line.combinedGroup}`}
                              >
                                {line.combinedGroup}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td
                          data-label="Remaining"
                          className="leave-policies-table__num leave-carry-forward-table__col-num"
                        >
                          {formatDays(line.remaining)}
                        </td>
                        <td
                          data-label="Carry"
                          className="leave-policies-table__num leave-carry-forward-table__col-num"
                        >
                          {formatDays(line.carried)}
                        </td>
                        <td
                          data-label="Forfeit"
                          className="leave-policies-table__num leave-carry-forward-table__col-num"
                        >
                          {formatDays(line.forfeited)}
                        </td>
                        <td data-label="Status" className="leave-carry-forward-table__status-cell">
                          {(() => {
                            const status = lineStatus(line);
                            return (
                              <span className={status.className} title={status.title}>
                                {status.label}
                              </span>
                            );
                          })()}
                        </td>
                        {lineIndex === 0 ? (
                          <td
                            data-label="Action"
                            rowSpan={visibleLines.length}
                            className="cell-actions-col cell-actions-col--text leave-carry-forward-table__action-cell"
                          >
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={
                                submitting ||
                                applyingUserId === employee.userId ||
                                employee.pendingAdjustments === 0
                              }
                              onClick={() =>
                                onApplyEmployee({
                                  userId: employee.userId,
                                  userLabel: employee.name,
                                })
                              }
                            >
                              {applyingUserId === employee.userId ? 'Applying…' : 'Carry forward'}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <footer className="modal__footer leave-carry-forward-modal__footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={isBusy}
          >
            Close
          </button>
          {canApplyAll ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={loading || isBusy}
              onClick={onApplyAll}
            >
              {submitting
                ? 'Applying…'
                : `Carry forward all (${preview.summary.eligibleEmployees} employee${preview.summary.eligibleEmployees === 1 ? '' : 's'})`}
            </button>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function formToPayload(form) {
  const payload = {
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

  return payload;
}

export default function AdminLeavePolicies() {
  const { showSuccess, showError } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const editModalTitleId = useId();
  const cfPreviewModalTitleId = useId();

  const [policies, setPolicies] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [cfFromYear, setCfFromYear] = useState(defaultCarryForwardYear);
  const [cfPreviewModalOpen, setCfPreviewModalOpen] = useState(false);
  const [cfPreview, setCfPreview] = useState(null);
  const [cfPreviewLoading, setCfPreviewLoading] = useState(false);
  const [cfPreviewError, setCfPreviewError] = useState('');
  const [cfSubmitting, setCfSubmitting] = useState(false);
  const [cfApplyingUserId, setCfApplyingUserId] = useState('');

  const [modalPolicy, setModalPolicy] = useState(null);
  const [form, setForm] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [modalError, setModalError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const requestKeyRef = useRef('');

  const loadPolicies = useCallback(async () => {
    const requestKey = String(Date.now());
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError('');

    try {
      const data = await leaveApi.listPolicies();
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
  }, []);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

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

  useEscapeKey(Boolean(modalPolicy), closeModal);

  const closeCfPreviewModal = useCallback(() => {
    if (cfSubmitting || cfApplyingUserId) return;
    setCfPreviewModalOpen(false);
  }, [cfApplyingUserId, cfSubmitting]);

  useEscapeKey(cfPreviewModalOpen, closeCfPreviewModal);

  const loadCarryForwardPreview = useCallback(async (options = {}) => {
    const { userId } = options;
    setCfPreviewLoading(true);
    setCfPreviewError('');
    try {
      const data = await leaveApi.previewCarryForward({
        fromYear: cfFromYear,
        ...(userId ? { userId } : {}),
      });
      if (userId) {
        setCfPreview((prev) => {
          if (!prev) return data;
          const updatedEmployee = data.employees?.[0];
          if (!updatedEmployee) {
            return {
              ...prev,
              employees: prev.employees.filter((employee) => employee.userId !== userId),
              summary: summarizeCarryForwardEmployees(
                prev.employees.filter((employee) => employee.userId !== userId),
              ),
            };
          }
          const employees = prev.employees.some((employee) => employee.userId === userId)
            ? prev.employees.map((employee) =>
                employee.userId === userId ? updatedEmployee : employee,
              )
            : [...prev.employees, updatedEmployee];
          return {
            ...prev,
            employees,
            summary: summarizeCarryForwardEmployees(employees),
          };
        });
        return data;
      }
      setCfPreview(data);
      return data;
    } catch (err) {
      setCfPreview(null);
      setCfPreviewError(getErrorMessage(err));
      throw err;
    } finally {
      setCfPreviewLoading(false);
    }
  }, [cfFromYear]);

  function openCarryForwardPreview() {
    setCfPreviewModalOpen(true);
    setCfPreview(null);
    setCfPreviewError('');
    loadCarryForwardPreview();
  }

  async function applyCarryForward(options = {}) {
    const { userId, userLabel } = options;
    const scopeLabel = userLabel
      ? userLabel
      : `all active employees (${cfFromYear} → ${cfFromYear + 1})`;

    await requestConfirm({
      title: userId ? 'Carry forward for employee?' : 'Carry forward remaining leave?',
      message: userId
        ? `Carry unused leave from ${cfFromYear} to ${cfFromYear + 1} for ${userLabel}? Already-applied types are skipped automatically.`
        : `Carry unused leave from ${cfFromYear} to ${cfFromYear + 1} for ${scopeLabel}? Caps follow each policy's CF max (SL 23; CL+EL combined 20).`,
      confirmLabel: userId ? 'Carry forward' : 'Carry forward all',
      variant: 'danger',
      onConfirm: async () => {
        if (userId) setCfApplyingUserId(userId);
        else setCfSubmitting(true);
        setCfPreviewError('');
        try {
          const result = await leaveApi.applyCarryForward({
            fromYear: cfFromYear,
            ...(userId ? { userId } : {}),
          });
          showSuccess(
            `Carry-forward applied: ${result.adjustments} adjustment(s), ${formatDays(result.totalCarried)} day(s) carried${result.totalForfeited > 0 ? `, ${formatDays(result.totalForfeited)} forfeited` : ''}.`,
          );
          if (userId && cfPreview) {
            setCfPreview((prev) => patchEmployeeAfterCarryForward(prev, userId, result));
          } else {
            await loadCarryForwardPreview();
          }
        } catch (err) {
          const message = getErrorMessage(err);
          setCfPreviewError(message);
          showError(message);
          throw err;
        } finally {
          setCfSubmitting(false);
          setCfApplyingUserId('');
        }
      },
    });
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
      showSuccess(`Policy for ${modalPolicy.leaveTypeCode} updated.`);
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
      <section className="leave-carry-forward-panel card" aria-label="Year-end carry forward">
        <div className="leave-carry-forward-panel__header">
          <div>
            <h2 className="card__section-title">Year-end carry forward</h2>
            <p className="muted small leave-carry-forward-panel__lead">
              Cash in unused paid leave from a closing year into the next year&apos;s opening balance.
              Caps respect each policy&apos;s CF max (SL 23; CL+EL share a combined cap of 20).
            </p>
          </div>
        </div>

        <div className="leave-carry-forward-panel__toolbar toolbar-row">
          <label className="field-inline form-field--sm">
            <span className="label">Source year</span>
            <input
              className="input input--narrow"
              type="number"
              min="2000"
              max="2100"
              value={cfFromYear}
              onChange={(event) => {
                setCfFromYear(Number(event.target.value));
                setCfPreview(null);
                setCfPreviewModalOpen(false);
                setCfPreviewError('');
              }}
            />
          </label>
          <span className="leave-carry-forward-panel__arrow muted" aria-hidden="true">
            → {cfFromYear + 1}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={cfPreviewLoading || cfSubmitting}
            onClick={openCarryForwardPreview}
          >
            {cfPreviewLoading ? 'Loading preview…' : 'Preview balances'}
          </button>
        </div>
      </section>

      <section className="leave-policies-panel card card--table" aria-label="Leave policies">
        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : policies.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.leave}
            title="No leave policies yet"
            description="Leave types and their quota rules appear here once configured in the system."
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
                        label={`Actions for ${policy.leaveTypeCode} policy`}
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
                Edit policy: {modalPolicy.leaveTypeCode}
              </h2>
              <p className="modal__lead muted">
                Update quota, accrual, carry-forward, and encashment rules for{' '}
                {modalPolicy.leaveTypeName}.
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

      {confirmDialog}

      <CarryForwardPreviewModal
        open={cfPreviewModalOpen}
        fromYear={cfFromYear}
        preview={cfPreview}
        loading={cfPreviewLoading}
        error={cfPreviewError}
        submitting={cfSubmitting}
        applyingUserId={cfApplyingUserId}
        titleId={cfPreviewModalTitleId}
        onClose={closeCfPreviewModal}
        onApplyAll={() => applyCarryForward()}
        onApplyEmployee={applyCarryForward}
      />
    </div>
  );
}
