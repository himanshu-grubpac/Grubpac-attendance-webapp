import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { adminResetPasswordSchema } from '@shared/validation/auth.js';
import { PERMISSIONS } from '@shared/permissions.js';
import { adminApi, getErrorMessage, salaryApi } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { formatISTDate, formatISTDateTime } from '../../utils/datetime.js';
import { validateForm } from '../../utils/validation.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import BackLink from '../../components/BackLink.jsx';
import DateField from '../../components/DateField.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import FieldError from '../../components/FieldError.jsx';
import InrInput from '../../components/InrInput.jsx';
import PasswordInput from '../../components/PasswordInput.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import PageLoading from '../../components/PageLoading.jsx';
import SelectField from '../../components/SelectField.jsx';
import { formatInrCurrency, formatInrInput, parseInrInput } from '../../utils/formatNumber.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

const emptyResetForm = {
  newPassword: '',
  confirmPassword: '',
};

const emptyOrgForm = {
  roleId: '',
  departmentId: '',
  reportingManagerId: '',
  delegateApproverId: '',
  monthlySalary: '',
  salaryEffectiveFrom: '',
  firstName: '',
  lastName: '',
  designation: '',
  joiningDate: '',
  endingDate: '',
};

function getInitials(name) {
  if (!name?.trim()) return '?';
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function displayValue(value) {
  if (value == null || value === '') return '—';
  return value;
}

function DetailLabel({ children, optional = false }) {
  return (
    <span className="label employee-detail-label">
      {children}
      {optional ? <span className="employee-detail-label__optional muted"> (Optional)</span> : null}
    </span>
  );
}

function DetailField({ label, value, valueClassName, fullWidth = false }) {
  return (
    <div className={`employee-detail-field${fullWidth ? ' employee-detail-field--full' : ''}`}>
      <dt>{label}</dt>
      <dd className={valueClassName}>{displayValue(value)}</dd>
    </div>
  );
}

function EmploymentEditFields({
  employee,
  orgForm,
  setOrgForm,
  roles,
  departments,
  managers,
}) {
  function updateField(key, value) {
    setOrgForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="employee-detail-form__grid">
      <label className="employee-detail-field-control">
        <DetailLabel>First name</DetailLabel>
        <input
          className="input"
          type="text"
          value={orgForm.firstName}
          onChange={(e) => updateField('firstName', e.target.value)}
          maxLength={50}
          autoComplete="given-name"
        />
      </label>

      <label className="employee-detail-field-control">
        <DetailLabel>Last name</DetailLabel>
        <input
          className="input"
          type="text"
          value={orgForm.lastName}
          onChange={(e) => updateField('lastName', e.target.value)}
          maxLength={50}
          autoComplete="family-name"
        />
      </label>

      <label className="employee-detail-field-control">
        <DetailLabel optional>Designation</DetailLabel>
        <input
          className="input"
          type="text"
          value={orgForm.designation}
          onChange={(e) => updateField('designation', e.target.value)}
          placeholder="Optional"
          maxLength={100}
        />
      </label>

      <div className="employee-detail-field-control">
        <DetailLabel>Joining date</DetailLabel>
        <DateField
          value={orgForm.joiningDate}
          onChange={(value) => updateField('joiningDate', value)}
          aria-label="Joining date"
        />
      </div>

      <div className="employee-detail-field-control">
        <DetailLabel optional>Ending date</DetailLabel>
        <DateField
          value={orgForm.endingDate}
          onChange={(value) => updateField('endingDate', value)}
          aria-label="Ending date"
        />
      </div>

      <div className="employee-detail-field-control">
        <DetailLabel>Role</DetailLabel>
        <SelectField
          value={orgForm.roleId}
          onChange={(value) => updateField('roleId', value)}
          options={roles
            .filter((role) => role.slug !== 'admin')
            .map((role) => ({ value: role.id, label: role.name }))}
          aria-label="Role"
        />
      </div>

      <div className="employee-detail-field-control">
        <DetailLabel>Department</DetailLabel>
        <SelectField
          value={orgForm.departmentId}
          onChange={(value) => updateField('departmentId', value)}
          options={departments
            .filter((dept) => dept.isActive)
            .map((dept) => ({ value: dept.id, label: dept.name }))}
          placeholder="Select department"
          aria-label="Department"
        />
      </div>

      <div className="employee-detail-field-control">
        <DetailLabel optional>Reporting manager</DetailLabel>
        <SelectField
          value={orgForm.reportingManagerId}
          onChange={(value) => updateField('reportingManagerId', value)}
          options={managers
            .filter((manager) => manager.id !== employee.id)
            .map((manager) => ({
              value: manager.id,
              label: `${manager.name} (${manager.roleName})`,
            }))}
          placeholder="Select reporting manager"
          aria-label="Reporting manager"
        />
      </div>

      <div className="employee-detail-field-control employee-detail-field-control--full">
        <DetailLabel optional>Delegate approver (while manager away)</DetailLabel>
        <SelectField
          value={orgForm.delegateApproverId}
          onChange={(value) => updateField('delegateApproverId', value)}
          options={managers
            .filter((manager) => manager.id !== employee.id)
            .map((manager) => ({
              value: manager.id,
              label: `${manager.name} (${manager.roleName})`,
            }))}
          placeholder="Select delegate approver"
          aria-label="Delegate approver"
        />
      </div>
    </div>
  );
}

function SalaryEditFields({ orgForm, setOrgForm }) {
  function updateField(key, value) {
    setOrgForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="employee-detail-form__grid">
      <label className="employee-detail-field-control">
        <DetailLabel optional>Monthly salary (INR)</DetailLabel>
        <InrInput
          className="input"
          value={orgForm.monthlySalary}
          onChange={(next) => updateField('monthlySalary', next)}
          placeholder="Optional"
        />
      </label>

      <div className="employee-detail-field-control">
        <DetailLabel optional>Salary effective from</DetailLabel>
        <DateField
          value={orgForm.salaryEffectiveFrom}
          onChange={(value) => updateField('salaryEffectiveFrom', value)}
          aria-label="Salary effective from"
        />
      </div>
    </div>
  );
}

export default function AdminEmployeeDetail() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const canManageSalary = hasPermission(PERMISSIONS.SALARY_WRITE);
  const canWriteUsers = hasPermission(PERMISSIONS.USERS_WRITE);
  const { setMeta } = usePageMetaContext();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

  const orgSectionRef = useRef(null);
  const resetModalRef = useRef(null);
  const resetPreviouslyFocusedRef = useRef(null);
  const editParamHandledRef = useRef('');
  const resetModalTitleId = useId();
  const resetModalDescId = useId();

  const [employee, setEmployee] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [roles, setRoles] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [managers, setManagers] = useState([]);

  const [orgEditing, setOrgEditing] = useState(false);
  const [orgForm, setOrgForm] = useState(emptyOrgForm);
  const [orgSubmitting, setOrgSubmitting] = useState(false);
  const [orgMessage, setOrgMessage] = useState('');
  const [orgError, setOrgError] = useState('');

  const [resetOpen, setResetOpen] = useState(false);
  const [resetForm, setResetForm] = useState(emptyResetForm);
  const [resetFieldErrors, setResetFieldErrors] = useState({});
  const [resetMessage, setResetMessage] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);

  async function loadEmployee() {
    setLoading(true);
    setError('');
    try {
      const data = await adminApi.getEmployee(id);
      setEmployee(data.employee);
    } catch (err) {
      setEmployee(null);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEmployee();
  }, [id]);

  useEffect(() => {
    Promise.all([adminApi.listRoles(), adminApi.listDepartments()])
      .then(([rolesData, departmentsData]) => {
        setRoles(rolesData.roles ?? []);
        setDepartments(departmentsData.departments ?? []);
      })
      .catch(() => {});
    adminApi
      .listManagers({ limit: 100 })
      .then((managersData) => setManagers(managersData.managers ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!employee) return undefined;
    setMeta({
      title: employee.name || 'Employee details',
      subtitle: employee.email || '',
    });
    return () => setMeta(null);
  }, [employee, setMeta]);

  function buildOrgFormFromEmployee(emp) {
    return {
      roleId: emp.roleId ?? '',
      departmentId: emp.departmentId ?? '',
      reportingManagerId: emp.reportingManagerId ?? '',
      delegateApproverId: emp.delegateApproverId ?? '',
      monthlySalary:
        emp.monthlySalary != null && emp.monthlySalary !== ''
          ? formatInrInput(emp.monthlySalary)
          : '',
      salaryEffectiveFrom: emp.salaryEffectiveFrom
        ? String(emp.salaryEffectiveFrom).slice(0, 10)
        : '',
      firstName: emp.firstName ?? '',
      lastName: emp.lastName ?? '',
      designation: emp.designation ?? '',
      joiningDate: emp.joiningDate ? String(emp.joiningDate).slice(0, 10) : '',
      endingDate: emp.endingDate ? String(emp.endingDate).slice(0, 10) : '',
    };
  }

  function clearEditParam() {
    if (searchParams.has('edit')) {
      setSearchParams({}, { replace: true });
    }
  }

  function openOrgEdit() {
    if (!employee) return;
    setOrgForm(buildOrgFormFromEmployee(employee));
    setOrgMessage('');
    setOrgError('');
    setOrgEditing(true);
    setResetOpen(false);
    requestAnimationFrame(() => {
      orgSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function closeOrgEdit() {
    setOrgEditing(false);
    setOrgForm(emptyOrgForm);
    setOrgMessage('');
    setOrgError('');
    clearEditParam();
  }

  function openReset() {
    setResetForm(emptyResetForm);
    setResetFieldErrors({});
    setResetMessage('');
    setResetError('');
    setResetOpen(true);
    setOrgEditing(false);
  }

  function closeReset() {
    setResetOpen(false);
    setResetForm(emptyResetForm);
    setResetFieldErrors({});
    setResetMessage('');
    setResetError('');
    clearEditParam();
  }

  useEffect(() => {
    editParamHandledRef.current = '';
  }, [id]);

  useEffect(() => {
    if (!employee || !canWriteUsers) return;

    const editParam = searchParams.get('edit');
    if (!editParam) {
      editParamHandledRef.current = '';
      return;
    }

    const key = `${employee.id}:${editParam}`;
    if (editParamHandledRef.current === key) return;
    editParamHandledRef.current = key;

    if (editParam === 'employment' || editParam === 'org') {
      setOrgForm(buildOrgFormFromEmployee(employee));
      setOrgMessage('');
      setOrgError('');
      setOrgEditing(true);
      setResetOpen(false);
      requestAnimationFrame(() => {
        orgSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } else if (editParam === 'reset') {
      setResetForm(emptyResetForm);
      setResetFieldErrors({});
      setResetMessage('');
      setResetError('');
      setResetOpen(true);
      setOrgEditing(false);
    }
  }, [employee, canWriteUsers, searchParams]);

  useEscapeKey(resetOpen && !resetSubmitting, closeReset);

  useEffect(() => {
    if (!resetOpen) return undefined;

    resetPreviouslyFocusedRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(() => {
      document.getElementById('reset-new-password')?.focus();
    });

    function handleKeyDown(event) {
      if (event.key !== 'Tab' || resetSubmitting) return;
      const root = resetModalRef.current;
      if (!root) return;

      const focusables = root.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;

      const list = Array.from(focusables);
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    resetModalRef.current?.addEventListener('keydown', handleKeyDown);

    return () => {
      resetModalRef.current?.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (resetPreviouslyFocusedRef.current instanceof HTMLElement) {
        resetPreviouslyFocusedRef.current.focus();
      }
    };
  }, [resetOpen, resetSubmitting]);

  async function handleOrgSave(event) {
    event.preventDefault();
    if (!employee) return;

    setOrgSubmitting(true);
    setOrgMessage('');
    setOrgError('');

    try {
      await adminApi.updateEmployee(employee.id, {
        roleId: orgForm.roleId || undefined,
        departmentId: orgForm.departmentId || null,
        reportingManagerId: orgForm.reportingManagerId || null,
        delegateApproverId: orgForm.delegateApproverId || null,
        firstName: orgForm.firstName || undefined,
        lastName: orgForm.lastName || undefined,
        designation: orgForm.designation || null,
        joiningDate: orgForm.joiningDate || undefined,
        endingDate: orgForm.endingDate || null,
      });

      if (canManageSalary) {
        const salaryPayload = {};
        if (orgForm.monthlySalary !== '') {
          const parsedSalary = parseInrInput(orgForm.monthlySalary);
          if (parsedSalary === '') {
            throw new Error('Monthly salary must be a valid number.');
          }
          salaryPayload.monthlySalary = parsedSalary;
        } else if (employee.monthlySalary != null) {
          salaryPayload.monthlySalary = null;
        }
        if (orgForm.salaryEffectiveFrom !== '') {
          salaryPayload.salaryEffectiveFrom = orgForm.salaryEffectiveFrom;
        } else if (employee.salaryEffectiveFrom) {
          salaryPayload.salaryEffectiveFrom = null;
        }
        if (Object.keys(salaryPayload).length > 0) {
          await salaryApi.updateUserSalary(employee.id, salaryPayload);
        }
      }

      setOrgMessage('Employment details updated.');
      await loadEmployee();
      closeOrgEdit();
    } catch (err) {
      setOrgError(getErrorMessage(err));
    } finally {
      setOrgSubmitting(false);
    }
  }

  async function handleResetPassword(event) {
    event.preventDefault();
    if (!employee) return;

    setResetSubmitting(true);
    setResetMessage('');
    setResetError('');

    const validation = validateForm(adminResetPasswordSchema, resetForm);
    if (!validation.data) {
      setResetFieldErrors(validation.errors);
      setResetSubmitting(false);
      return;
    }

    setResetFieldErrors({});

    await requestConfirm({
      title: 'Reset password?',
      message: `Set a new password for ${employee.name} (${employee.email})? They will need this password to sign in.`,
      confirmLabel: 'Reset password',
      variant: 'danger',
      onConfirm: async () => {
        const result = await adminApi.resetEmployeePassword(employee.id, validation.data);
        setResetMessage(result.message || 'Password reset successfully.');
        setResetForm(emptyResetForm);
      },
    });
    setResetSubmitting(false);
  }

  async function toggleStatus() {
    if (!employee) return;
    const nextActive = !employee.isActive;
    await requestConfirm({
      title: nextActive ? 'Activate employee?' : 'Deactivate employee?',
      message: nextActive
        ? `Activate ${employee.name}? They will be able to sign in again.`
        : `Deactivate ${employee.name}? They will no longer be able to sign in.`,
      confirmLabel: nextActive ? 'Activate' : 'Deactivate',
      variant: nextActive ? 'default' : 'danger',
      onConfirm: async () => {
        await adminApi.updateEmployeeStatus(employee.id, nextActive);
        await loadEmployee();
      },
    });
  }

  if (loading) {
    return (
      <div className="page page--employee-detail">
        <PageLoading text="Loading employee…" />
      </div>
    );
  }

  if (!employee) {
    return (
      <div className="page page--employee-detail">
        <nav className="employee-detail-back" aria-label="Back navigation">
          <BackLink to="/admin/users">Employee list</BackLink>
        </nav>
        <div className="employee-detail-empty card">
          <EmptyState
            icon={EMPTY_ICONS.users}
            title="Employee not found"
            description={
              error ||
              'This employee may have been removed, or you may not have access to view them.'
            }
            action={
              <Link to="/admin/users" className="btn btn-primary btn-sm">
                Back to Employee list
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const departmentLabel = employee.departmentName || employee.department;
  const summaryLine = [employee.roleName, departmentLabel, employee.designation]
    .filter(Boolean)
    .join(' · ');
  const inFocusedMode = orgEditing;

  const actionItems = canWriteUsers
    ? [
        {
          key: 'employment',
          label: 'Edit employment details',
          onClick: openOrgEdit,
        },
        {
          key: 'reset',
          label: 'Reset password',
          onClick: openReset,
        },
        {
          key: 'toggle',
          label: employee.isActive ? 'Deactivate' : 'Activate',
          variant: employee.isActive ? 'danger' : 'default',
          onClick: toggleStatus,
        },
      ]
    : [];

  const identityMetaLine = [employee.employeeCode, employee.email].filter(Boolean).join(' · ');

  return (
    <div className="page page--employee-detail">
      <header className="employee-detail-header">
        <nav className="employee-detail-back" aria-label="Back navigation">
          <BackLink to="/admin/users">Employee list</BackLink>
        </nav>

        <div className="employee-detail-identity" aria-label="Employee summary">
          <div className="employee-detail-identity__main">
            <span className="employee-detail-identity__avatar" aria-hidden="true">
              {getInitials(employee.name)}
            </span>
            <div className="employee-detail-identity__text">
              <div className="employee-detail-identity__title-row">
                <h1 className="employee-detail-identity__name">{employee.name}</h1>
              </div>
              {identityMetaLine ? (
                <p className="employee-detail-identity__meta">{identityMetaLine}</p>
              ) : null}
              {summaryLine ? (
                <p className="employee-detail-identity__summary">{summaryLine}</p>
              ) : null}
            </div>
          </div>
          {actionItems.length > 0 && !inFocusedMode ? (
            <div className="employee-detail-identity__actions">
              <ActionMenu label={`Actions for ${employee.name}`} items={actionItems} />
            </div>
          ) : null}
        </div>
      </header>

      {error ? <div className="alert alert--error">{error}</div> : null}

      <div className="employee-detail-stack">
        {orgEditing && canWriteUsers ? (
          <form className="employee-detail-form" onSubmit={handleOrgSave} noValidate>
            <section
              ref={orgSectionRef}
              className="employee-detail-section card employee-detail-section--editing"
              aria-labelledby="employee-employment-title"
            >
              <header className="employee-detail-section__header employee-detail-section__header--row">
                <div className="employee-detail-section__heading">
                  <h2 id="employee-employment-title" className="employee-detail-section__title">
                    Employment details
                  </h2>
                  <p className="employee-detail-section__lead muted">
                    Update role, department, designation, and reporting lines.
                  </p>
                </div>
                <span className="employee-detail-edit-badge">Editing</span>
              </header>

              <EmploymentEditFields
                employee={employee}
                orgForm={orgForm}
                setOrgForm={setOrgForm}
                roles={roles}
                departments={departments}
                managers={managers}
              />
            </section>

            {canManageSalary ? (
              <section
                className="employee-detail-section card employee-detail-section--editing"
                aria-labelledby="employee-salary-title"
              >
                <header className="employee-detail-section__header">
                  <h2 id="employee-salary-title" className="employee-detail-section__title">
                    Salary
                  </h2>
                  <p className="employee-detail-section__lead muted">
                    Monthly compensation and effective date for payroll.
                  </p>
                </header>
                <SalaryEditFields orgForm={orgForm} setOrgForm={setOrgForm} />
              </section>
            ) : null}

            <div className="employee-detail-form__actions form-actions form-actions--sticky">
              <button type="submit" className="btn btn-primary" disabled={orgSubmitting}>
                {orgSubmitting ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                className="btn btn-ghost employee-detail-form__cancel"
                onClick={closeOrgEdit}
                disabled={orgSubmitting}
              >
                Cancel
              </button>
            </div>

            {orgMessage ? <div className="alert alert--success">{orgMessage}</div> : null}
            {orgError ? <div className="alert alert--error">{orgError}</div> : null}
          </form>
        ) : (
          <>
            <section className="employee-detail-section card" aria-labelledby="employee-account-title">
              <header className="employee-detail-section__header">
                <h2 id="employee-account-title" className="employee-detail-section__title">
                  Account details
                </h2>
                <p className="employee-detail-section__lead muted">
                  Sign-in credentials and account status.
                </p>
              </header>
              <dl className="employee-detail-fields employee-detail-fields--account">
                <DetailField
                  label="Email"
                  value={employee.email}
                  valueClassName="employee-detail-field__value--email"
                />
                <DetailField label="Mobile" value={employee.mobile} />
                <DetailField label="Employee code" value={employee.employeeCode} />
                <DetailField
                  label="Status"
                  value={<StatusBadge active={employee.isActive} />}
                />
                <DetailField
                  label="Last login"
                  value={
                    employee.lastLoginAt
                      ? formatISTDateTime(employee.lastLoginAt)
                      : 'Never signed in'
                  }
                  fullWidth
                />
              </dl>
            </section>

            <section
              ref={orgSectionRef}
              className="employee-detail-section card"
              aria-labelledby="employee-employment-title"
            >
              <header className="employee-detail-section__header">
                <h2 id="employee-employment-title" className="employee-detail-section__title">
                  Employment details
                </h2>
                <p className="employee-detail-section__lead muted">
                  Role, department, and reporting structure.
                </p>
              </header>
              <dl className="employee-detail-fields">
                <DetailField label="First name" value={employee.firstName} />
                <DetailField label="Last name" value={employee.lastName} />
                <DetailField label="Role" value={employee.roleName} />
                <DetailField label="Department" value={departmentLabel} />
                <DetailField label="Designation" value={employee.designation} />
                <DetailField label="Reporting manager" value={employee.reportingManagerName} />
                <DetailField label="Delegate approver" value={employee.delegateApproverName} />
                <DetailField label="Joining date" value={formatISTDate(employee.joiningDate)} />
                <DetailField
                  label="Ending date"
                  value={employee.endingDate ? formatISTDate(employee.endingDate) : null}
                />
              </dl>
            </section>

            {canManageSalary ? (
              <section className="employee-detail-section card" aria-labelledby="employee-salary-title">
                <header className="employee-detail-section__header">
                  <h2 id="employee-salary-title" className="employee-detail-section__title">
                    Salary
                  </h2>
                  <p className="employee-detail-section__lead muted">
                    Monthly compensation and effective date for payroll.
                  </p>
                </header>
                <dl className="employee-detail-fields">
                  <DetailField
                    label="Monthly salary"
                    value={
                      employee.monthlySalary != null && employee.monthlySalary !== ''
                        ? formatInrCurrency(employee.monthlySalary)
                        : null
                    }
                  />
                  <DetailField
                    label="Salary effective from"
                    value={
                      employee.salaryEffectiveFrom
                        ? formatISTDate(employee.salaryEffectiveFrom)
                        : null
                    }
                  />
                </dl>
              </section>
            ) : null}
          </>
        )}
      </div>

      {resetOpen && canWriteUsers
        ? createPortal(
            <div
              className="modal__backdrop"
              role="presentation"
              onClick={resetSubmitting ? undefined : closeReset}
            >
              <div
                ref={resetModalRef}
                className="modal modal--compact"
                role="dialog"
                aria-modal="true"
                aria-labelledby={resetModalTitleId}
                aria-describedby={resetModalDescId}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="modal__header">
                  <h2 id={resetModalTitleId} className="modal__title">
                    Reset password
                  </h2>
                  <p id={resetModalDescId} className="modal__lead muted">
                    Set a new sign-in password for {employee.email}.
                  </p>
                </header>

                <form className="modal__form" onSubmit={handleResetPassword} noValidate>
                  <div className="modal__body">
                    <label className="modal__field">
                      <DetailLabel>New password</DetailLabel>
                      <PasswordInput
                        id="reset-new-password"
                        value={resetForm.newPassword}
                        onChange={(e) =>
                          setResetForm({ ...resetForm, newPassword: e.target.value })
                        }
                        placeholder="Enter new password"
                        autoComplete="new-password"
                        maxLength={128}
                        showGenerate
                        disabled={resetSubmitting}
                      />
                      <FieldError message={resetFieldErrors.newPassword} />
                    </label>
                    <label className="modal__field">
                      <DetailLabel>Confirm new password</DetailLabel>
                      <PasswordInput
                        value={resetForm.confirmPassword}
                        onChange={(e) =>
                          setResetForm({ ...resetForm, confirmPassword: e.target.value })
                        }
                        placeholder="Confirm new password"
                        autoComplete="new-password"
                        maxLength={128}
                        disabled={resetSubmitting}
                      />
                      <FieldError message={resetFieldErrors.confirmPassword} />
                    </label>
                    {resetMessage ? (
                      <div className="alert alert--success modal__alert">{resetMessage}</div>
                    ) : null}
                    {resetError ? (
                      <div className="alert alert--error modal__alert">{resetError}</div>
                    ) : null}
                  </div>

                  <footer className="modal__footer">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={closeReset}
                      disabled={resetSubmitting}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={resetSubmitting}>
                      {resetSubmitting ? 'Saving…' : 'Reset password'}
                    </button>
                  </footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}

      {confirmDialog}
    </div>
  );
}
