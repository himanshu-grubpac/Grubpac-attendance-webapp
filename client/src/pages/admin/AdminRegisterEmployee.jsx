import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { employeeInputSchema } from '@shared/validation/employee.js';
import { PERMISSIONS } from '@shared/permissions.js';
import { generatePassword } from '@shared/utils/generatePassword.js';
import { adminApi, getErrorMessage, salaryApi } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { validateForm } from '../../utils/validation.js';
import { parseInrInput } from '../../utils/formatNumber.js';
import DateField from '../../components/DateField.jsx';
import FieldError from '../../components/FieldError.jsx';
import InrInput from '../../components/InrInput.jsx';
import SelectField from '../../components/SelectField.jsx';

const emptyForm = {
  firstName: '',
  lastName: '',
  email: '',
  mobile: '',
  password: '',
  employeeCode: '',
  designation: '',
  joiningDate: '',
  endingDate: '',
  department: '',
  departmentId: '',
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
  const { hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();
  const canManageSalary = hasPermission(PERMISSIONS.SALARY_WRITE);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    adminApi
      .listDepartments()
      .then((departmentsData) => setDepartments(departmentsData.departments ?? []))
      .catch(() => {
        // Reference data is optional for the form.
      });
  }, []);

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleRegister(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const validation = validateForm(employeeInputSchema, form);
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
        departmentId: form.departmentId || undefined,
      };
      const { employee } = await adminApi.registerEmployee(payload);

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
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const departmentOptions = departments
    .filter((dept) => dept.isActive)
    .map((dept) => ({ value: dept.id, label: dept.name }));

  const hasDepartmentList = departmentOptions.length > 0;

  return (
    <div className="page page--register-employee">
      {error ? <div className="alert alert--error">{error}</div> : null}

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
              />
              <FieldError message={fieldErrors.firstName} />
            </label>

            <label className="register-field">
              <RegisterLabel required>Last name</RegisterLabel>
              <input
                className="input"
                type="text"
                value={form.lastName}
                onChange={(event) => updateField('lastName', event.target.value)}
                placeholder="Enter last name"
                maxLength={50}
                autoComplete="family-name"
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
              />
              <FieldError message={fieldErrors.email} />
            </label>

            <label className="register-field">
              <RegisterLabel required>Mobile</RegisterLabel>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                value={form.mobile}
                onChange={(event) => updateField('mobile', event.target.value)}
                placeholder="+91 99999 99999"
                maxLength={15}
                autoComplete="tel"
              />
              <FieldError message={fieldErrors.mobile} />
            </label>

            <div className="register-field">
              <RegisterLabel required>Joining date</RegisterLabel>
              <DateField
                value={form.joiningDate}
                onChange={(value) => updateField('joiningDate', value)}
                aria-label="Joining date"
              />
              <FieldError message={fieldErrors.joiningDate} />
            </div>

            <div className="register-field">
              <RegisterLabel optional>Ending date</RegisterLabel>
              <DateField
                value={form.endingDate}
                onChange={(value) => updateField('endingDate', value)}
                aria-label="Ending date"
              />
              <FieldError message={fieldErrors.endingDate} />
            </div>

            <label className="register-field">
              <RegisterLabel optional>Employee code</RegisterLabel>
              <input
                className="input"
                type="text"
                value={form.employeeCode}
                onChange={(event) => updateField('employeeCode', event.target.value)}
                placeholder="e.g. GBT-2026-114"
                maxLength={50}
              />
              <FieldError message={fieldErrors.employeeCode} />
            </label>

            <label className="register-field">
              <RegisterLabel optional>Designation</RegisterLabel>
              <input
                className="input"
                type="text"
                value={form.designation}
                onChange={(event) => updateField('designation', event.target.value)}
                placeholder="Enter designation"
                maxLength={100}
              />
              <FieldError message={fieldErrors.designation} />
            </label>

            {hasDepartmentList ? (
              <div className="register-field">
                <RegisterLabel optional>Department</RegisterLabel>
                <SelectField
                  value={form.departmentId}
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      departmentId: value,
                      department: value ? '' : current.department,
                    }))
                  }
                  options={departmentOptions}
                  placeholder="Select department"
                  aria-label="Department"
                />
                <FieldError message={fieldErrors.departmentId} />
              </div>
            ) : (
              <label className="register-field">
                <RegisterLabel optional>Department</RegisterLabel>
                <input
                  className="input"
                  type="text"
                  value={form.department}
                  onChange={(event) => updateField('department', event.target.value)}
                  placeholder="Enter department"
                  maxLength={100}
                />
                <FieldError message={fieldErrors.department} />
              </label>
            )}

            {hasDepartmentList && !form.departmentId ? (
              <label className="register-field register-field--department-text">
                <RegisterLabel optional>Department (text)</RegisterLabel>
                <input
                  className="input"
                  type="text"
                  value={form.department}
                  onChange={(event) => updateField('department', event.target.value)}
                  placeholder="If not listed above"
                  maxLength={100}
                />
                <FieldError message={fieldErrors.department} />
              </label>
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
                    disabled={submitting}
                  />
                  <FieldError message={fieldErrors.monthlySalary} />
                </label>

                <div className="register-field">
                  <RegisterLabel optional>Salary effective from</RegisterLabel>
                  <DateField
                    value={form.salaryEffectiveFrom}
                    onChange={(value) => updateField('salaryEffectiveFrom', value)}
                    aria-label="Salary effective from"
                    disabled={submitting}
                  />
                  <FieldError message={fieldErrors.salaryEffectiveFrom} />
                </div>
              </>
            ) : null}

            <div className="register-field register-field--password">
              <RegisterLabel required>Password</RegisterLabel>
              <RegisterPasswordField
                value={form.password}
                onChange={(value) => updateField('password', value)}
                error={fieldErrors.password}
                disabled={submitting}
              />
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
          <button type="submit" className="btn btn-primary register-submit" disabled={submitting}>
            <CheckIcon />
            <span>{submitting ? 'Saving…' : 'Register Employee'}</span>
          </button>
        </footer>
      </form>
    </div>
  );
}
