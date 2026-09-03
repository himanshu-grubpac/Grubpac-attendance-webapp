import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authApi, getErrorMessage, getFieldErrors } from '../services/api.js';
import { resetPasswordSchema } from '@shared/validation/auth.js';
import { validateForm } from '../utils/validation.js';
import { useToast } from '../context/ToastContext.jsx';
import CompanyLogo from '../components/CompanyLogo.jsx';
import FieldError from '../components/FieldError.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { BRANDING } from '../config/branding.js';

const REASON_MESSAGES = {
  missing: 'This password reset link is missing a token. Please request a new one.',
  expired: 'This password reset link has expired. Please request a new one.',
  used: 'This password reset link has already been used. Please request a new one.',
  invalid: 'This password reset link is invalid. Please request a new one.',
  unavailable: 'This account is no longer available for password reset.',
};

const emptyForm = { newPassword: '', confirmPassword: '' };

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { showSuccess } = useToast();

  const [status, setStatus] = useState('verifying'); // verifying | invalid | valid | done
  const [reason, setReason] = useState('invalid');
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;

    if (!token) {
      setStatus('invalid');
      setReason('missing');
      return;
    }

    authApi
      .verifyResetToken(token)
      .then((res) => {
        if (!active) return;
        if (res.valid) {
          setStatus('valid');
        } else {
          setStatus('invalid');
          setReason(res.reason || 'invalid');
        }
      })
      .catch(() => {
        if (!active) return;
        setStatus('invalid');
        setReason('invalid');
      });

    return () => {
      active = false;
    };
  }, [token]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setFieldErrors({});

    const validation = validateForm(resetPasswordSchema, { token, ...form });
    if (!validation.data) {
      setFieldErrors(validation.errors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await authApi.resetPassword(validation.data);
      setStatus('done');
      setForm(emptyForm);
      showSuccess(result.message || 'Password reset successful.');
    } catch (err) {
      if (err?.response?.status === 410) {
        setStatus('invalid');
        setReason(err?.response?.data?.message?.includes('expired') ? 'expired' : 'used');
      } else {
        const fieldErrs = getFieldErrors(err);
        if (Object.keys(fieldErrs).length) {
          setFieldErrors(fieldErrs);
        }
        setError(getErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-page__top">
        <div className="login-page__brand-row">
          <CompanyLogo size={40} showText={false} />
          <div className="login-page__brand-text">
            <p className="login-page__app-name">{BRANDING.appName}</p>
            <p className="login-page__company">{BRANDING.companyName}</p>
          </div>
        </div>
      </div>

      <section className="login-panel">
        <div className="login-card card">
          <div className="login-card__header">
            <h1 className="login-card__title">Set a new password</h1>
            <p className="login-tagline">Choose a new password for your employee account.</p>
          </div>

          {status === 'verifying' && (
            <div className="login-card__form" aria-busy="true">
              <p className="muted">Verifying your reset link…</p>
            </div>
          )}

          {status === 'invalid' && (
            <div className="login-card__form">
              <div className="alert alert--error" role="alert">
                {REASON_MESSAGES[reason] ?? REASON_MESSAGES.invalid}
              </div>
              <button
                type="button"
                className="btn btn-primary login-card__submit"
                onClick={() => navigate('/login')}
              >
                Back to sign in
              </button>
            </div>
          )}

          {status === 'valid' && (
            <form className="form-stack login-card__form" onSubmit={handleSubmit}>
              <label>
                New password
                <PasswordInput
                  value={form.newPassword}
                  onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
                  autoComplete="new-password"
                  placeholder="Enter a new password"
                  maxLength={128}
                  disabled={submitting}
                />
                <FieldError message={fieldErrors.newPassword} />
              </label>
              <label>
                Confirm new password
                <PasswordInput
                  value={form.confirmPassword}
                  onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                  autoComplete="new-password"
                  placeholder="Re-enter the new password"
                  maxLength={128}
                  disabled={submitting}
                />
                <FieldError message={fieldErrors.confirmPassword} />
              </label>
              {error && (
                <div className="alert alert--error" role="alert">
                  {error}
                </div>
              )}
              <button
                type="submit"
                className="btn btn-primary btn-lg login-card__submit"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <span className="spinner spinner--sm" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  'Reset password'
                )}
              </button>
            </form>
          )}

          {status === 'done' && (
            <div className="login-card__form">
              <div className="alert alert--success" role="status">
                Your password has been reset. You can now sign in with your new password.
              </div>
              <button
                type="button"
                className="btn btn-primary login-card__submit"
                onClick={() => navigate('/login')}
              >
                Continue to sign in
              </button>
            </div>
          )}
        </div>

        <p className="login-page__footer">
          © {new Date().getFullYear()} {BRANDING.companyName}
        </p>
      </section>
    </div>
  );
}
