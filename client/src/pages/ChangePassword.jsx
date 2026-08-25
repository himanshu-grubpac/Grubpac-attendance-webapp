import { useState } from 'react';
import { changePasswordSchema, setPinSchema } from '@shared/validation/auth.js';
import { authApi, getErrorMessage } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { validateForm } from '../utils/validation.js';
import FieldError from '../components/FieldError.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

const emptyPasswordForm = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

const emptyPinForm = {
  currentPin: '',
  pin: '',
  confirmPin: '',
};

export default function ChangePassword() {
  const { user, refreshUser } = useAuth();
  const { showSuccess } = useToast();

  const [passwordForm, setPasswordForm] = useState(emptyPasswordForm);
  const [passwordErrors, setPasswordErrors] = useState({});
  const [passwordError, setPasswordError] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [pinForm, setPinForm] = useState(emptyPinForm);
  const [pinErrors, setPinErrors] = useState({});
  const [pinError, setPinError] = useState('');
  const [savingPin, setSavingPin] = useState(false);

  // PIN setup is employee-only (admins manage PINs via the admin panel).
  const isEmployee = user?.role === 'employee';
  const hasPin = Boolean(user?.hasPin);
  const canSetPin = isEmployee && Boolean(user?.hasPassword);

  async function handlePasswordSubmit(event) {
    event.preventDefault();
    setSavingPassword(true);
    setPasswordError('');

    const validation = validateForm(changePasswordSchema, passwordForm);
    if (!validation.data) {
      setPasswordErrors(validation.errors);
      setSavingPassword(false);
      return;
    }

    setPasswordErrors({});
    try {
      const result = await authApi.changePassword(validation.data);
      setPasswordForm(emptyPasswordForm);
      showSuccess(result.message || 'Password changed successfully.');
    } catch (err) {
      setPasswordError(getErrorMessage(err));
    } finally {
      setSavingPassword(false);
    }
  }

  async function handlePinSubmit(event) {
    event.preventDefault();
    setSavingPin(true);
    setPinError('');
    setPinErrors({});

    // Changing an existing PIN requires the current PIN.
    if (hasPin && !pinForm.currentPin.trim()) {
      setPinErrors((prev) => ({ ...prev, currentPin: 'Current PIN is required.' }));
      setSavingPin(false);
      return;
    }

    const validation = validateForm(setPinSchema, pinForm);
    if (!validation.data) {
      setPinErrors(validation.errors);
      setSavingPin(false);
      return;
    }

    try {
      const result = await authApi.setPin(validation.data);
      setPinForm(emptyPinForm);
      // Refresh the session user so the UI reflects the new PIN state.
      await refreshUser();
      showSuccess(result.message || 'PIN updated successfully.');
    } catch (err) {
      setPinError(getErrorMessage(err));
    } finally {
      setSavingPin(false);
    }
  }

  return (
    <div className="page page--form">
      <div className="card card--form">
        <p className="card__section-title">Update password</p>
        <form className="form-grid" onSubmit={handlePasswordSubmit}>
          <label>
            Current password
            <PasswordInput
              value={passwordForm.currentPassword}
              onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
              autoComplete="current-password"
              maxLength={128}
            />
            <FieldError message={passwordErrors.currentPassword} />
          </label>
          <label>
            New password
            <PasswordInput
              value={passwordForm.newPassword}
              onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
              autoComplete="new-password"
              maxLength={128}
            />
            <FieldError message={passwordErrors.newPassword} />
          </label>
          <label>
            Confirm new password
            <PasswordInput
              value={passwordForm.confirmPassword}
              onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
              autoComplete="new-password"
              maxLength={128}
            />
            <FieldError message={passwordErrors.confirmPassword} />
          </label>
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={savingPassword}>
              {savingPassword ? 'Saving…' : 'Update password'}
            </button>
          </div>
        </form>
        {passwordError && (
          <div className="page-alerts alert--inset">
            <div className="alert alert--error">{passwordError}</div>
          </div>
        )}
      </div>

      {isEmployee && (
        <div className="card card--form">
          <p className="card__section-title">
            {hasPin ? 'Change security PIN' : 'Set security PIN'}
          </p>
          <p className="card__section-hint">
            A 4-digit PIN lets you sign in with your email or employee ID instead of a password.
          </p>
          {canSetPin ? (
            <form className="form-grid" onSubmit={handlePinSubmit}>
              {hasPin && (
                <label>
                  Current PIN
                  <input
                    className="input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="current-password"
                    value={pinForm.currentPin}
                    onChange={(e) => setPinForm({ ...pinForm, currentPin: e.target.value })}
                    maxLength={4}
                    placeholder="••••"
                  />
                  <FieldError message={pinErrors.currentPin} />
                </label>
              )}
              <label>
                {hasPin ? 'New PIN' : 'PIN'}
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={pinForm.pin}
                  onChange={(e) => setPinForm({ ...pinForm, pin: e.target.value })}
                  maxLength={4}
                  placeholder="••••"
                />
                <FieldError message={pinErrors.pin} />
              </label>
              <label>
                Confirm PIN
                <input
                  className="input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={pinForm.confirmPin}
                  onChange={(e) => setPinForm({ ...pinForm, confirmPin: e.target.value })}
                  maxLength={4}
                  placeholder="••••"
                />
                <FieldError message={pinErrors.confirmPin} />
              </label>
              <div className="form-actions form-actions--sticky">
                <button type="submit" className="btn btn-primary" disabled={savingPin}>
                  {savingPin ? 'Saving…' : hasPin ? 'Change PIN' : 'Set PIN'}
                </button>
              </div>
            </form>
          ) : (
            <p className="card__section-hint">
              Set a password before adding a security PIN.
            </p>
          )}
          {pinError && (
            <div className="page-alerts alert--inset">
              <div className="alert alert--error">{pinError}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
