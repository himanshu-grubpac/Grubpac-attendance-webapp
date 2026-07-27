import { useState } from 'react';
import { changePasswordSchema } from '@shared/validation/auth.js';
import { authApi, getErrorMessage } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { validateForm } from '../utils/validation.js';
import FieldError from '../components/FieldError.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

const emptyForm = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

export default function ChangePassword() {
  const { showSuccess } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const validation = validateForm(changePasswordSchema, form);
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});
    try {
      const result = await authApi.changePassword(validation.data);
      setForm(emptyForm);
      showSuccess(result.message || 'Password changed successfully.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--form">
      <div className="card card--form">
        <p className="card__section-title">Update password</p>
        <form className="form-grid" onSubmit={handleSubmit}>
          <label>
            Current password
            <PasswordInput
              value={form.currentPassword}
              onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
              autoComplete="current-password"
              maxLength={128}
            />
            <FieldError message={fieldErrors.currentPassword} />
          </label>
          <label>
            New password
            <PasswordInput
              value={form.newPassword}
              onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
              autoComplete="new-password"
              maxLength={128}
            />
            <FieldError message={fieldErrors.newPassword} />
          </label>
          <label>
            Confirm new password
            <PasswordInput
              value={form.confirmPassword}
              onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
              autoComplete="new-password"
              maxLength={128}
            />
            <FieldError message={fieldErrors.confirmPassword} />
          </label>
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Update password'}
            </button>
          </div>
        </form>
        {error && (
          <div className="page-alerts alert--inset">
            <div className="alert alert--error">{error}</div>
          </div>
        )}
      </div>
    </div>
  );
}
