import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { updateProfileSchema } from '@shared/validation/auth.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { authApi, getErrorMessage } from '../services/api.js';
import { formatISTDate } from '../utils/datetime.js';
import { validateForm } from '../utils/validation.js';
import FieldError from '../components/FieldError.jsx';

function displayValue(value) {
  if (value == null || value === '') return '—';
  return String(value);
}

function getInitials(user) {
  const name = user?.name?.trim();
  if (!name) return '?';
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export default function ProfilePage() {
  const { showSuccess } = useToast();
  const { user, isAdmin, refreshUser } = useAuth();
  const changePasswordPath = isAdmin ? '/admin/change-password' : '/employee/change-password';

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    mobile: '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    setForm({
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      mobile: user.mobile ?? '',
    });
  }, [user]);

  const readOnlyFields = useMemo(
    () => [
      { label: 'Email', value: user?.email, className: 'kv-list__value--email' },
      { label: 'Employee code', value: user?.employeeCode },
      { label: 'Designation', value: user?.designation },
      { label: 'Department', value: user?.departmentName || user?.department },
      { label: 'Role', value: user?.roleName || user?.role },
      { label: 'Joining date', value: user?.joiningDate ? formatISTDate(user.joiningDate) : null },
      {
        label: 'Date of birth',
        value: user?.dateOfBirth ? formatISTDate(user.dateOfBirth) : null,
      },
      { label: 'Ending date', value: user?.endingDate ? formatISTDate(user.endingDate) : null },
    ],
    [user],
  );

  const identityMeta = useMemo(() => {
    const parts = [user?.roleName || user?.role, user?.departmentName || user?.department].filter(
      Boolean,
    );
    return parts.join(' · ');
  }, [user]);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const validation = validateForm(updateProfileSchema, form);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    try {
      const result = await authApi.updateProfile(validation.data);
      await refreshUser(result.user);
      showSuccess('Profile updated successfully.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--form">
      {error ? (
        <div className="page-alerts">
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <div className="card card--form card--dense">
        <div className="profile-identity">
          <span className="profile-identity__avatar" aria-hidden="true">
            {getInitials(user)}
          </span>
          <div className="profile-identity__text">
            <h2 className="profile-identity__name">{user?.name ?? 'My profile'}</h2>
            {identityMeta ? <p className="profile-identity__meta">{identityMeta}</p> : null}
          </div>
        </div>

        <p className="card__section-title">Account details</p>
        <dl className="kv-list profile-readonly">
          {readOnlyFields.map((field) => (
            <div key={field.label} className="kv-list__row">
              <dt className="kv-list__label">{field.label}</dt>
              <dd className={`kv-list__value${field.className ? ` ${field.className}` : ''}`}>
                {displayValue(field.value)}
              </dd>
            </div>
          ))}
        </dl>

        <p className="card__section-title">Editable profile</p>
        <form className="form-grid form-grid--stacked" onSubmit={handleSubmit}>
          <label>
            <span className="label">First name</span>
            <input
              className="input"
              type="text"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              maxLength={50}
              autoComplete="given-name"
            />
            <FieldError message={fieldErrors.firstName} />
          </label>
          <label>
            <span className="label">Last name</span>
            <input
              className="input"
              type="text"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              maxLength={50}
              autoComplete="family-name"
            />
            <FieldError message={fieldErrors.lastName} />
          </label>
          <label className="form-grid__full">
            <span className="label">Mobile</span>
            <input
              className="input"
              type="tel"
              value={form.mobile}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })}
              maxLength={15}
              autoComplete="tel"
            />
            <p className="field-hint">10-digit Indian mobile number.</p>
            <FieldError message={fieldErrors.mobile} />
          </label>
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
            <Link to={changePasswordPath} className="btn btn-ghost">
              Change password
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
