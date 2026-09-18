import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { buildEmployeeInputSchema, EMPLOYEE_CODE_FORMAT_HINT } from '@shared/validation/employee.js';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '@shared/permissions.js';
import { generatePassword } from '@shared/utils/generatePassword.js';
import { adminApi, getErrorMessage, getFieldErrors, salaryApi } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import { parseInrInput } from '../../utils/formatNumber.js';
import DateField, { getTodayIstValue } from '../../components/DateField.jsx';
import FieldError from '../../components/FieldError.jsx';
import InrInput from '../../components/InrInput.jsx';
import MultiSelectField from '../../components/MultiSelectField.jsx';
import SelectField from '../../components/SelectField.jsx';
import { COMPANY_START_DATE } from "../../config/company.js";


const emptyForm = {
  firstName: '',
  lastName: '',
  email: '',
  mobile: '',
  password: '',
  employeeCode: '',
  designation: '',
  joiningDate: '',
  dateOfBirth: '',
  endingDate: '',
  roleId: '',
  departmentId: '',
  reportingManagerId: '',
  managedDepartmentIds: [],
  monthlySalary: '',
  salaryEffectiveFrom: '',
};

function RegisterLabel({ children, required = false, optional = false }) {
  return (
    <span className="label register-label">
      {children}
      {required ? (
        <span className="register-label__required" aria-hidden="true">
          {' '}
          *
        </span>
      ) : null}
      {optional ? <span className="register-label__optional muted"> (Optional)</span> : null}
    </span>
  );
}

function EyeIcon({ open }) {
  if (open) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M3 3l18 18M10.58 10.58A2 2 0 0 0 12 15a2 2 0 0 0 1.42-.58M9.88 5.09A10.94 10.94 0 0 1 12 5c5 0 9.27 3.11 11 7.5a11.8 11.8 0 0 1-2.05 3.5M6.61 6.61A11.8 11.8 0 0 0 1 12.5C2.73 16.89 7 20 12 20a10.94 10.94 0 0 0 5.91-1.72"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12.5C3.73 8.11 8 5 13 5s9.27 3.11 11 7.5c-1.73 4.39-6 7.5-11 7.5S3.73 16.89 2 12.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="13" cy="12.5" r="3" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L21 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RegisterPasswordField({ value, onChange, error, disabled }) {
  const [visible, setVisible] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  async function handleGenerate() {
    const nextPassword = generatePassword();
    onChange(nextPassword);

    try {
      await navigator.clipboard.writeText(nextPassword);
      setStatusMessage('Password generated and copied to clipboard.');
    } catch {
      setStatusMessage('Password generated.');
    }

    window.setTimeout(() => setStatusMessage(''), 4000);
  }

  return (
    <div className="register-password">
      <div className="register-password__row">
        <input
          className="input register-password__input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={128}
          autoComplete="new-password"
          disabled={disabled}
        />
        <button
          type="button"
          className="register-password__toggle btn btn-ghost btn-sm"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          disabled={disabled}
        >
          <EyeIcon open={visible} />
        </button>
        <button
          type="button"
          className="register-password__generate btn btn-sm"
          onClick={handleGenerate}
          disabled={disabled}
        >
          Generate
        </button>
      </div>
      {statusMessage ? (
        <p className="register-password__status" role="status" aria-live="polite">
          {statusMessage}
        </p>
      ) : null}
      <FieldError message={error} />
    </div>
  );
}

export default function AdminRegisterEmployee() {
  const navigate = useNavigate();
  const { hasPermission, user } = useAuth();
  const { showSuccess, showError } = useToast();
  const canManageSalary = hasPermission(PERMISSIONS.SALARY_WRITE);
  // Scoped team creation: reporting managers without full user access create
  // Employee accounts under their own managed departments only. The server
  // re-enforces every bound; the form just narrows the choices.
  const scopedCreator =
    !hasPermission(PERMISSIONS.USERS_WRITE)
    && user?.roleSlug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER;
  const scopedManagedIds = scopedCreator ? (user?.managedDepartmentIds ?? []) : null;
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [roles, setRoles] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [managers, setManagers] = useState([]);
  const [referenceLoading, setReferenceLoading] = useState(true);
  const [referenceError, setReferenceError] = useState('');
  const [emailCredentials, setEmailCredentials] = useState(true);

  useEffect(() => {
    setReferenceLoading(true);
    setReferenceError('');

    // Scoped creators resolve only the roles they may assign (Employee) and
    // never need the manager directory — new joiners always report to them.
    const rolesPromise = scopedCreator
      ? adminApi.listRoles({ scope: 'creatable' })
      : adminApi.listRoles();
    const managersPromise = scopedCreator
      ? Promise.resolve({ managers: [] })
      : adminApi.listManagers({ limit: 500 });

    Promise.all([rolesPromise, adminApi.listDepartments(), managersPromise])
      .then(([rolesData, departmentsData, managersData]) => {
        const nextRoles = rolesData.roles ?? [];
        const nextDepartments = departmentsData.departments ?? [];
        const nextManagers = managersData.managers ?? [];

        setRoles(nextRoles);
        setDepartments(nextDepartments);
        setManagers(nextManagers);

        const defaultRole = nextRoles.find((role) => role.slug === SYSTEM_ROLE_SLUGS.EMPLOYEE);
        if (defaultRole) {
          setForm((current) => (current.roleId ? current : { ...current, roleId: defaultRole.id }));
        }
      })
      .catch((err) => {
        setReferenceError(getErrorMessage(err));
      })
      .finally(() => {
        setReferenceLoading(false);
      });
    // Re-resolves when the session lands: a slow auth restore would otherwise
    // fetch the full catalog as a scoped creator (403) or vice versa.
  }, [scopedCreator]);

  // Scoped creators always file under themselves; the session user can land
  // after the reference fetch, so preset separately once it is known.
  useEffect(() => {
    if (scopedCreator && user?.id) {
      setForm((current) => (current.reportingManagerId ? current : { ...current, reportingManagerId: user.id }));
    }
  }, [scopedCreator, user?.id]);

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleRegister(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const roleSlug = roles.find((role) => role.id === form.roleId)?.slug ?? null;
    // When emailing credentials the server generates the temporary password,
    // so validate with a placeholder and omit it from the payload.
    const formForValidation = emailCredentials
      ? { ...form, password: 'Temp@1234' }
      : form;
    const validation = validateForm(
      buildEmployeeInputSchema({ roleSlug, hasDepartments: departmentOptions.length > 0 }),
      formForValidation,
    );
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }
    setFieldErrors({});

    let parsedSalary;
    if (canManageSalary && form.monthlySalary !== '') {
      parsedSalary = parseInrInput(form.monthlySalary);
      if (parsedSalary === '') {
        setFieldErrors({ monthlySalary: 'Monthly salary must be a valid number.' });
        setSubmitting(false);
        return;
      }
    }

    try {
      const payload = {
        ...validation.data,
        managedDepartmentIds: validation.data.managedDepartmentIds ?? [],
      };
      delete payload.department;
      if (emailCredentials) {
        delete payload.password;
        payload.sendCredentialsEmail = true;
      }

      const result = await adminApi.registerEmployee(payload);
      const { employee } = result;
      if (result.credentialsEmail && !result.credentialsEmail.sent) {
        showError(
          'Employee created, but the credentials email could not be delivered. ' +
            `Temporary password (share manually): ${result.credentialsEmail.tempPassword ?? '—'}`,
        );
      }

      // Salary is saved in a second API call because register creates the user first.
      if (canManageSalary && parsedSalary !== undefined) {
        const salaryPayload = {
          monthlySalary: parsedSalary,
          salaryEffectiveFrom: form.salaryEffectiveFrom || validation.data.joiningDate,
        };

        try {
          await salaryApi.updateUserSalary(employee.id, salaryPayload);
          showSuccess('Employee registered successfully.');
        } catch (salaryErr) {
          showError(
            `Employee was created, but salary could not be saved: ${getErrorMessage(salaryErr)}`,
          );
        }
      } else {
        showSuccess('Employee registered successfully.');
      }

      navigate('/admin/users');
    } catch (err) {
      const data = err?.response?.data;
      const serverFieldErrors = getFieldErrors(err);
      if (data?.field) {
        setFieldErrors({ [data.field]: data.message });
        setError('');
      } else if (Object.keys(serverFieldErrors).length > 0) {
        setFieldErrors(serverFieldErrors);
        setError('');
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const roleOptions = roles
    .filter((role) => role.slug !== SYSTEM_ROLE_SLUGS.ADMIN)
    .map((role) => ({ value: role.id, label: role.name }));

  const departmentOptions = departments
    .filter((dept) => dept.isActive && (scopedManagedIds === null || scopedManagedIds.includes(dept.id)))
    .map((dept) => ({ value: dept.id, label: dept.name }));

  const managerOptions = scopedCreator && user?.id
    ? [{ value: user.id, label: `${user.name ?? 'You'} (Reporting Manager)` }]
    : managers.map((manager) => ({
      value: manager.id,
      label: `${manager.name} (${manager.roleName})`,
    }));

  const hasDepartmentList = departmentOptions.length > 0;
  const formDisabled = submitting || referenceLoading;
  const selectedRoleSlug = roles.find((role) => role.id === form.roleId)?.slug ?? null;
  const reportingManagerRequired = selectedRoleSlug === SYSTEM_ROLE_SLUGS.EMPLOYEE;
  const managedDeptsRequired = selectedRoleSlug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER;

  return (
    <div className="page page--register-employee">
      {error ? <div className="alert alert--error">{error}</div> : null}
      {referenceError ? <div className="alert alert--error">{referenceError}</div> : null}

      <form className="register-form" onSubmit={handleRegister} noValidate>
        <section className="register-section card" aria-labelledby="register-identity-title">
          <header className="register-section__header">
            <h2 id="register-identity-title" className="register-section__title">
              Employee Identification &amp; Access
            </h2>
            <p className="register-section__lead muted">
              Fill in all required fields marked with an asterisk (*) to create a new employee
              account.
            </p>
          </header>

          <div className="register-section__grid">
            <label className="register-field">
              <RegisterLabel required>First name</RegisterLabel>
              <input
                className="input"
                type="text"
                value={form.firstName}
                onChange={(event) => updateField('firstName', event.target.value)}
                placeholder="Enter first name"
                maxLength={50}
                autoComplete="given-name"
                disabled={formDisabled}
              />
              <FieldError message={fieldErrors.firstName} />
            </label>

            <label className="register-field">
              <RegisterLabel optional>Last name</RegisterLabel>
              <input
                className="input"
                type="text"
                value={form.lastName}
                onChange={(event) => updateField('lastName', event.target.value)}
                placeholder="Enter last name"
                maxLength={50}
                autoComplete="family-name"
                disabled={formDisabled}
              />
              <FieldError message={fieldErrors.lastName} />
            </label>

            <label className="register-field">
              <RegisterLabel required>Email</RegisterLabel>
              <input
                className="input"
                type="email"
                value={form.email}
                onChange={(event) => updateField('email', event.target.value)}
                placeholder="username@company.com"
                maxLength={100}
                autoComplete="email"
                disabled={formDisabled}
              />
              <FieldError message={fieldErrors.email} />
            </label>

            <label className="register-field">
              <RegisterLabel required>Mobile</RegisterLabel>
              <div className="mobile-input-wrap">
                <span className="mobile-input-prefix" aria-hidden="true">
                  +91
                </span>
                <input
                  className="input mobile-input--with-prefix"
                  type="text"
                  inputMode="numeric"
                  value={form.mobile}
                  onChange={(event) => updateField('mobile', event.target.value.replace(/\D/g, '').slice(0, 10))}
                  placeholder="99999 99999"
                  maxLength={10}
                  autoComplete="tel"
                  disabled={formDisabled}
                />
              </div>
              <FieldError message={fieldErrors.mobile} />
            </label>

            <div className="register-field">
              <RegisterLabel required>Joining date</RegisterLabel>
              <DateField
                value={form.joiningDate}
                min={COMPANY_START_DATE}
                onChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    joiningDate: value,
                    ...(current.endingDate && value && current.endingDate < value
                      ? { endingDate: value }
                      : {}),
                  }))
                }
                aria-label="Joining date"
                disabled={formDisabled}
              />
              <FieldError message={fieldErrors.joiningDate} />
            </div>

            <div className="register-field">
              <RegisterLabel optional>Date of birth</RegisterLabel>
              <DateField
                value={form.dateOfBirth}
                onChange={(value) => updateField('dateOfBirth', value)}
                min="1900-01-01"
                max={getTodayIstValue()}
                aria-label="Date of birth"
                disabled={formDisabled}
              />
              <FieldError message={fieldErrors.dateOfBirth} />
            </div>

            <div className="register-field">
              <RegisterLabel optional>Ending date</RegisterLabel>
              <DateField
                value={form.endingDate}
                onChange={(value) => updateField('endingDate', value)}
                min={form.joiningDate || undefined}
                aria-label="Ending date"
                disabled={formDisabled}
              />
              <FieldError message={fieldErrors.endingDate} />
            </div>

            <label className="register-field">
              <RegisterLabel optional>Employee code</RegisterLabel>
              <input
                className="input"
                type="text"
                value={form.employeeCode}
                onChange={(event) => updateField('employeeCode', event.target.value.toUpperCase())}
                placeholder="EMP001"
                maxLength={11}
                pattern="[A-Z]{2,5}[0-9]{3,6}"
                aria-describedby="register-employee-code-hint"
                disabled={formDisabled}
              />
              <p id="register-employee-code-hint" className="muted small">
                {EMPLOYEE_CODE_FORMAT_HINT}
              </p>
              <FieldError message={fieldErrors.employeeCode} />
            </label>

            <label className="register-field">
              <RegisterLabel required>Designation</RegisterLabel>
              <input
                className="input"
                type="text"
                value={form.designation}
                onChange={(event) => updateField('designation', event.target.value)}
                placeholder="e.g. Senior Software Engineer"
                maxLength={100}
                aria-describedby="register-designation-hint"
                disabled={formDisabled}
              />
              <p id="register-designation-hint" className="muted small">
                Job title shown on profile — separate from access role.
              </p>
              <FieldError message={fieldErrors.designation} />
            </label>

            <div className="register-field">
              <RegisterLabel required>Role</RegisterLabel>
              <SelectField
                value={form.roleId}
                onChange={(value) => updateField('roleId', value)}
                options={roleOptions}
                placeholder="Select role"
                aria-label="Role"
                disabled={formDisabled || roleOptions.length === 0 || scopedCreator}
              />
              <p id="register-role-hint" className="muted small">
                {scopedCreator
                  ? 'Reporting managers can only create Employee accounts.'
                  : 'Controls permissions and portal access. Defaults to Employee.'}
              </p>
              <FieldError message={fieldErrors.roleId} />
            </div>

            {hasDepartmentList ? (
              <div className="register-field">
                <RegisterLabel required>Department</RegisterLabel>
                <SelectField
                  value={form.departmentId}
                  onChange={(value) => updateField('departmentId', value)}
                  options={departmentOptions}
                  placeholder="Select department"
                  aria-label="Department"
                  disabled={formDisabled}
                />
                <p id="register-department-hint" className="muted small">
                  Primary team or function where the employee works.
                </p>
                <FieldError message={fieldErrors.departmentId} />
              </div>
            ) : (
              <div className="register-field register-field--full">
                <RegisterLabel>Department</RegisterLabel>
                <p className="muted small" id="register-department-empty-hint">
                  {scopedCreator ? (
                    'No managed departments are assigned to your account. Ask an administrator to assign one before adding team members.'
                  ) : (
                    <>
                      No departments configured yet.{' '}
                      <Link to="/admin/departments">Create departments</Link> before assigning
                      employees to a team.
                    </>
                  )}
                </p>
              </div>
            )}

            <div className="register-field">
              <RegisterLabel required={reportingManagerRequired} optional={!reportingManagerRequired}>
                Reporting manager
              </RegisterLabel>
              <SelectField
                value={form.reportingManagerId}
                onChange={(value) => updateField('reportingManagerId', value)}
                options={managerOptions}
                placeholder="Select reporting manager"
                aria-label="Reporting manager"
                disabled={formDisabled || scopedCreator}
              />
              <p id="register-manager-hint" className="muted small">
                {scopedCreator
                  ? 'New joiners always report to you.'
                  : reportingManagerRequired
                    ? 'Required for employees — used for leave approval and team reporting.'
                    : 'Optional for this role — used for leave approval and team reporting.'}
              </p>
              <FieldError message={fieldErrors.reportingManagerId} />
            </div>

            {/* Team creators file Employee accounts only — no team scope to grant. */}
            {hasDepartmentList && !scopedCreator ? (
              <div className="register-field">
                <RegisterLabel required={managedDeptsRequired} optional={!managedDeptsRequired}>
                  Managed departments (team scope)
                </RegisterLabel>
                <p className="muted small" id="register-managed-depts-hint">
                  Teams this person oversees. Most relevant for roles with team permissions.
                </p>
                <MultiSelectField
                  value={form.managedDepartmentIds ?? []}
                  onChange={(value) => updateField('managedDepartmentIds', value)}
                  options={departmentOptions}
                  placeholder="Select departments"
                  countSuffix="departments"
                  aria-label="Managed departments (team scope)"
                  aria-describedby="register-managed-depts-hint"
                  disabled={formDisabled}
                />
                <FieldError message={fieldErrors.managedDepartmentIds} />
              </div>
            ) : null}

            {canManageSalary ? (
              <>
                <label className="register-field">
                  <RegisterLabel optional>Monthly salary (INR)</RegisterLabel>
                  <InrInput
                    className="input"
                    value={form.monthlySalary}
                    onChange={(value) => updateField('monthlySalary', value)}
                    placeholder="Optional"
                    disabled={formDisabled}
                  />
                  <FieldError message={fieldErrors.monthlySalary} />
                </label>

                <div className="register-field">
                  <RegisterLabel optional>Salary effective from</RegisterLabel>
                  <DateField
                    value={form.salaryEffectiveFrom}
                    onChange={(value) => updateField('salaryEffectiveFrom', value)}
                    aria-label="Salary effective from"
                    disabled={formDisabled}
                  />
                  <FieldError message={fieldErrors.salaryEffectiveFrom} />
                </div>
              </>
            ) : null}

            <div className="register-field register-field--password">
              <RegisterLabel required={!emailCredentials}>Password</RegisterLabel>
              <RegisterPasswordField
                value={form.password}
                onChange={(value) => updateField('password', value)}
                error={fieldErrors.password}
                disabled={formDisabled || emailCredentials}
              />
              <label className="field-checkbox" style={{ marginTop: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={emailCredentials}
                  onChange={(event) => setEmailCredentials(event.target.checked)}
                  disabled={formDisabled}
                />
                <span>Auto-generate temporary password &amp; email login credentials</span>
              </label>
            </div>
          </div>

          <footer className="register-section__hints" aria-label="Password and login notes">
            <p className="register-section__hints-text muted">
              Employees can sign in with employee code, email, or mobile number and password.
              {' '}
              Minimum 8 characters, at least 1 uppercase letter, 1 lowercase letter, and 1 numeric
              digit.
            </p>
          </footer>
        </section>

        <footer className="register-form__footer">
          <button
            type="button"
            className="btn btn-ghost register-form__cancel"
            disabled={submitting}
            onClick={() => navigate('/admin/users')}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary register-submit"
            disabled={formDisabled || !hasDepartmentList}
          >
            <CheckIcon />
            <span>{submitting ? 'Saving…' : 'Register Employee'}</span>
          </button>
        </footer>
      </form>
    </div>
  );
}
