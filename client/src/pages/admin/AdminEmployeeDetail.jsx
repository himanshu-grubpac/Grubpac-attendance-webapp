import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { adminResetPasswordSchema } from '@shared/validation/auth.js';
import { PERMISSIONS } from '@shared/permissions.js';
import { adminApi, getErrorMessage, salaryApi } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { formatISTDate, formatISTDateTime } from '../../utils/datetime.js';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import InrInput from '../../components/InrInput.jsx';
import PasswordInput from '../../components/PasswordInput.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import PageLoading from '../../components/PageLoading.jsx';
import SelectField from '../../components/SelectField.jsx';
import { formatInrInput, parseInrInput } from '../../utils/formatNumber.js';

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

function DetailField({ label, value }) {
  return (
    <div className="employee-detail-field">
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </div>
  );
}

function OrgEditForm({
  employee,
  orgForm,
  setOrgForm,
  roles,
  departments,
  managers,
  canManageSalary,
  orgSubmitting,
  onSubmit,
  onCancel,
}) {
  return (
    <form className="employee-detail-inline-form form-grid" onSubmit={onSubmit}>
      <label>
        First name
        <input
          className="input"
          type="text"
          value={orgForm.firstName}
          onChange={(e) => setOrgForm({ ...orgForm, firstName: e.target.value })}
          maxLength={50}
        />
      </label>
      <label>
        Last name
        <input
          className="input"
          type="text"
          value={orgForm.lastName}
          onChange={(e) => setOrgForm({ ...orgForm, lastName: e.target.value })}
          maxLength={50}
        />
      </label>
      <label>
        Designation
        <input
          className="input"
          type="text"
          value={orgForm.designation}
          onChange={(e) => setOrgForm({ ...orgForm, designation: e.target.value })}
          placeholder="Optional"
          maxLength={100}
        />
      </label>
      <label>
        Joining date
        <input
          className="input"
          type="date"
          value={orgForm.joiningDate}
          onChange={(e) => setOrgForm({ ...orgForm, joiningDate: e.target.value })}
        />
      </label>
      <label>
        Ending date
        <input
          className="input"
          type="date"
          value={orgForm.endingDate}
          onChange={(e) => setOrgForm({ ...orgForm, endingDate: e.target.value })}
        />
      </label>
      <label>
        <span className="label">Role</span>
        <SelectField
          value={orgForm.roleId}
          onChange={(value) => setOrgForm({ ...orgForm, roleId: value })}
          options={[
            { value: '', label: 'Keep current' },
            ...roles
              .filter((role) => role.slug !== 'admin')
              .map((role) => ({ value: role.id, label: role.name })),
          ]}
          aria-label="Role"
        />
      </label>
      <label>
        <span className="label">Department</span>
        <SelectField
          value={orgForm.departmentId}
          onChange={(value) => setOrgForm({ ...orgForm, departmentId: value })}
          options={[
            { value: '', label: 'None' },
            ...departments
              .filter((dept) => dept.isActive)
              .map((dept) => ({ value: dept.id, label: dept.name })),
          ]}
          aria-label="Department"
        />
      </label>
      <label>
        <span className="label">Reporting manager</span>
        <SelectField
          value={orgForm.reportingManagerId}
          onChange={(value) => setOrgForm({ ...orgForm, reportingManagerId: value })}
          options={[
            { value: '', label: 'None' },
            ...managers
              .filter((manager) => manager.id !== employee.id)
              .map((manager) => ({
                value: manager.id,
                label: `${manager.name} (${manager.roleName})`,
              })),
          ]}
          aria-label="Reporting manager"
        />
      </label>
      <label>
        <span className="label">Delegate approver (while manager away)</span>
        <SelectField
          value={orgForm.delegateApproverId}
          onChange={(value) => setOrgForm({ ...orgForm, delegateApproverId: value })}
          options={[
            { value: '', label: 'None' },
            ...managers
              .filter((manager) => manager.id !== employee.id)
              .map((manager) => ({
                value: manager.id,
                label: `${manager.name} (${manager.roleName})`,
              })),
          ]}
          aria-label="Delegate approver"
        />
      </label>
      {canManageSalary ? (
        <>
          <label>
            Monthly salary (INR)
            <InrInput
              className="input"
              value={orgForm.monthlySalary}
              onChange={(next) => setOrgForm({ ...orgForm, monthlySalary: next })}
              placeholder="Optional"
            />
          </label>
          <label>
            Salary effective from
            <input
              className="input"
              type="date"
              value={orgForm.salaryEffectiveFrom}
              onChange={(e) =>
                setOrgForm({ ...orgForm, salaryEffectiveFrom: e.target.value })
              }
            />
          </label>
        </>
      ) : null}
      <div className="form-actions employee-detail-inline-form__actions">
        <button type="submit" className="btn btn-primary" disabled={orgSubmitting}>
          {orgSubmitting ? 'Saving…' : 'Save employment details'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={orgSubmitting}>
          Cancel
        </button>
      </div>
    </form>
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
  const resetSectionRef = useRef(null);
  const editParamHandledRef = useRef('');

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
      .catch(() => { });
    adminApi
      .listManagers({ limit: 100 })
      .then((managersData) => setManagers(managersData.managers ?? []))
      .catch(() => { });
  }, []);

  useEffect(() => {
    if (!employee) return undefined;
    const subtitleParts = [];
    if (employee.employeeCode) subtitleParts.push(employee.employeeCode);
    if (employee.email) subtitleParts.push(employee.email);
    setMeta({
      title: employee.name || 'Employee details',
      subtitle: subtitleParts.join(' · '),
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
    requestAnimationFrame(() => {
      resetSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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
      requestAnimationFrame(() => {
        resetSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [employee, canWriteUsers, searchParams]);

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
      <div className="page employee-detail">
        <PageLoading text="Loading employee…" />
      </div>
    );
  }

  if (!employee) {
    return (
      <div className="page employee-detail">
        <Link to="/admin/users" className="page-back-link">
          ← Employee list
        </Link>
        <div className="alert alert--error">{error || 'Employee not found.'}</div>
      </div>
    );
  }

  const departmentLabel = employee.departmentName || employee.department;

  return (
    <div className="page employee-detail">
      <Link to="/admin/users" className="page-back-link">
        ← Employee list
      </Link>

      <div className="employee-detail__hero">
        <div className="employee-detail__hero-main">
          <div className="employee-detail__status-row">
            <StatusBadge active={employee.isActive} />
            {employee.employeeCode ? (
              <span className="employee-detail__code">{employee.employeeCode}</span>
            ) : null}
          </div>
          <p className="employee-detail__summary">
            {[employee.roleName, departmentLabel, employee.designation].filter(Boolean).join(' · ')}
          </p>
        </div>
        {canWriteUsers ? (
          <div className="employee-detail__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={openOrgEdit}
              disabled={orgEditing}
            >
              Edit employment details
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={openReset}
              disabled={resetOpen}
            >
              Reset password
            </button>
            <button
              type="button"
              className={`btn ${employee.isActive ? 'btn-danger' : 'btn-primary'}`}
              onClick={toggleStatus}
            >
              {employee.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        ) : null}
      </div>

      {error ? <div className="alert alert--error">{error}</div> : null}

      {resetOpen && canWriteUsers ? (
        <section
          ref={resetSectionRef}
          className="card employee-detail__panel employee-detail__panel--reset"
          aria-labelledby="reset-password-heading"
        >
          <div className="employee-detail__panel-header">
            <div>
              <h3 id="reset-password-heading" className="card__title employee-detail__panel-title">
                Reset password
              </h3>
              <p className="employee-detail__panel-desc">
                Set a new sign-in password for {employee.email}.
              </p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={closeReset}>
              Close
            </button>
          </div>
          <form className="employee-detail-inline-form form-grid" onSubmit={handleResetPassword}>
            <label>
              New password
              <PasswordInput
                value={resetForm.newPassword}
                onChange={(e) => setResetForm({ ...resetForm, newPassword: e.target.value })}
                autoComplete="new-password"
                maxLength={128}
                showGenerate
              />
              <FieldError message={resetFieldErrors.newPassword} />
            </label>
            <label>
              Confirm new password
              <PasswordInput
                value={resetForm.confirmPassword}
                onChange={(e) => setResetForm({ ...resetForm, confirmPassword: e.target.value })}
                autoComplete="new-password"
                maxLength={128}
              />
              <FieldError message={resetFieldErrors.confirmPassword} />
            </label>
            <div className="form-actions employee-detail-inline-form__actions">
              <button type="submit" className="btn btn-primary" disabled={resetSubmitting}>
                {resetSubmitting ? 'Saving…' : 'Reset password'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeReset}
                disabled={resetSubmitting}
              >
                Cancel
              </button>
            </div>
          </form>
          {resetMessage ? <div className="alert alert--success">{resetMessage}</div> : null}
          {resetError ? <div className="alert alert--error">{resetError}</div> : null}
        </section>
      ) : null}

      <div className="employee-detail__grid">
        <section className="card employee-detail__card">
          <h3 className="card__title">Contact</h3>
          <dl className="detail-list detail-list--grid employee-detail__fields">
            <DetailField label="Email" value={employee.email} />
            <DetailField label="Mobile" value={employee.mobile} />
          </dl>
        </section>

        <section
          ref={orgSectionRef}
          className={`card employee-detail__card${orgEditing ? ' employee-detail__card--editing' : ''}`}
        >
          <div className="employee-detail__card-header">
            <h3 className="card__title employee-detail__card-title">Employment details</h3>
            {orgEditing ? (
              <span className="employee-detail__edit-badge">Editing</span>
            ) : null}
          </div>
          {orgEditing && canWriteUsers ? (
            <>
              <OrgEditForm
                employee={employee}
                orgForm={orgForm}
                setOrgForm={setOrgForm}
                roles={roles}
                departments={departments}
                managers={managers}
                canManageSalary={canManageSalary}
                orgSubmitting={orgSubmitting}
                onSubmit={handleOrgSave}
                onCancel={closeOrgEdit}
              />
              {orgMessage ? <div className="alert alert--success">{orgMessage}</div> : null}
              {orgError ? <div className="alert alert--error">{orgError}</div> : null}
            </>
          ) : (
            <dl className="detail-list detail-list--grid employee-detail__fields">
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
          )}
        </section>

        <section className="card employee-detail__card">
          <h3 className="card__title">Employment</h3>
          <dl className="detail-list detail-list--grid employee-detail__fields">
            <DetailField
              label="Status"
              value={<StatusBadge active={employee.isActive} />}
            />
            <DetailField label="Employee code" value={employee.employeeCode} />
          </dl>
        </section>

        {canManageSalary ? (
          <section className="card employee-detail__card">
            <h3 className="card__title">Salary</h3>
            <dl className="detail-list detail-list--grid employee-detail__fields">
              <DetailField
                label="Monthly salary"
                value={
                  employee.monthlySalary != null && employee.monthlySalary !== ''
                    ? `₹${employee.monthlySalary}`
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

        <section className="card employee-detail__card">
          <h3 className="card__title">Account activity</h3>
          <dl className="detail-list detail-list--grid employee-detail__fields">
            <DetailField label="Last login" value={formatISTDateTime(employee.lastLoginAt)} />
          </dl>
        </section>
      </div>

      {confirmDialog}
    </div>
  );
}
