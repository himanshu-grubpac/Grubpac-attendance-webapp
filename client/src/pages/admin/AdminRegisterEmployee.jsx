import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { employeeInputSchema } from '@shared/validation/employee.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { validateForm } from '../../utils/validation.js';
import FieldError from '../../components/FieldError.jsx';
import PasswordInput from '../../components/PasswordInput.jsx';
import SearchInput from '../../components/SearchInput.jsx';
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
  roleId: '',
  departmentId: '',
  reportingManagerId: '',
};

const fieldLabels = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  mobile: 'Mobile (10-digit Indian)',
  password: 'Password',
  employeeCode: 'Employee code (optional)',
  designation: 'Designation (optional)',
  joiningDate: 'Joining date',
  endingDate: 'Ending date (optional)',
  department: 'Department (optional)',
};

export default function AdminRegisterEmployee() {
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [roles, setRoles] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [managers, setManagers] = useState([]);
  const [managerSearch, setManagerSearch] = useState('');
  const debouncedManagerSearch = useDebouncedValue(managerSearch, 350);

  useEffect(() => {
    Promise.all([adminApi.listRoles(), adminApi.listDepartments()])
      .then(([rolesData, departmentsData]) => {
        setRoles(rolesData.roles ?? []);
        setDepartments(departmentsData.departments ?? []);
      })
      .catch(() => {
        // Reference data is optional for the form.
      });
  }, []);

  useEffect(() => {
    adminApi
      .listManagers({ search: debouncedManagerSearch || undefined, limit: 100 })
      .then((managersData) => setManagers(managersData.managers ?? []))
      .catch(() => {
        // Manager lookup is optional for the form.
      });
  }, [debouncedManagerSearch]);

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
    try {
      const payload = {
        ...validation.data,
        roleId: form.roleId || undefined,
        departmentId: form.departmentId || undefined,
        reportingManagerId: form.reportingManagerId || undefined,
      };
      await adminApi.registerEmployee(payload);
      showSuccess('Employee registered successfully.');
      navigate('/admin/users');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--form">
      <div className="card card--form">
        <p className="card__lead">
          Password must be 8+ chars with uppercase, lowercase, and a number.
        </p>
        <form className="form-grid" onSubmit={handleRegister}>
          {Object.keys(emptyForm)
            .filter((key) => !['roleId', 'departmentId', 'reportingManagerId'].includes(key))
            .map((key) => (
              <label key={key}>
                {fieldLabels[key]}
                {key === 'password' ? (
                  <PasswordInput
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    maxLength={128}
                    showGenerate
                  />
                ) : (
                  <input
                    className="input"
                    type={
                      key === 'email'
                        ? 'email'
                        : key === 'joiningDate' || key === 'endingDate'
                          ? 'date'
                          : 'text'
                    }
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    maxLength={key === 'mobile' ? 15 : 100}
                  />
                )}
                <FieldError message={fieldErrors[key]} />
              </label>
            ))}
          <label>
            <span className="label">Role</span>
            <SelectField
              value={form.roleId}
              onChange={(value) => setForm({ ...form, roleId: value })}
              options={[
                { value: '', label: 'Employee (default)' },
                ...roles
                  .filter((role) => role.slug !== 'admin')
                  .map((role) => ({ value: role.id, label: role.name })),
              ]}
              aria-label="Role"
            />
            <FieldError message={fieldErrors.roleId} />
          </label>
          <label>
            <span className="label">Department</span>
            <SelectField
              value={form.departmentId}
              onChange={(value) => setForm({ ...form, departmentId: value, department: '' })}
              options={[
                { value: '', label: 'None' },
                ...departments
                  .filter((dept) => dept.isActive)
                  .map((dept) => ({ value: dept.id, label: dept.name })),
              ]}
              aria-label="Department"
            />
            <FieldError message={fieldErrors.departmentId} />
          </label>
          <label className="form-grid__full">
            <span className="label">Reporting manager</span>
            <div className="field-stack">
              <SearchInput
                value={managerSearch}
                onChange={(event) => setManagerSearch(event.target.value)}
                placeholder="Search managers…"
                ariaLabel="Search reporting managers"
              />
              <SelectField
                value={form.reportingManagerId}
                onChange={(value) => setForm({ ...form, reportingManagerId: value })}
                options={[
                  { value: '', label: 'None' },
                  ...managers.map((manager) => ({
                    value: manager.id,
                    label: `${manager.name} (${manager.roleName})`,
                  })),
                ]}
                aria-label="Reporting manager"
              />
            </div>
            <FieldError message={fieldErrors.reportingManagerId} />
          </label>
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Register employee'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={() => navigate('/admin/users')}
            >
              Cancel
            </button>
          </div>
        </form>
        {error && <div className="alert alert--error alert--inset">{error}</div>}
      </div>
    </div>
  );
}
