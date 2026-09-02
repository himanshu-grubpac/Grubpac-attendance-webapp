import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { useToast } from '../context/ToastContext.jsx';
import { authApi, getErrorMessage } from '../services/api.js';
import { validateForm } from '../utils/validation.js';
import { forgotPasswordSchema } from '@shared/validation/auth.js';
import FieldError from './FieldError.jsx';

/**
 * Public "Forgot password" dialog shown from the login screen.
 * Matches the existing `.modal` styling used across the app.
 */
export default function ForgotPasswordModal({ open, onClose }) {
  const { showSuccess } = useToast();
  const [email, setEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const titleId = useId();
  const dialogRef = useRef(null);
  const emailRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEscapeKey(open && !submitting, onClose);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    const focusTarget = emailRef.current;
    // Defer focus until the portal is mounted.
    const focusTimer = setTimeout(() => focusTarget?.focus(), 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open]);

  function resetState() {
    setEmail('');
    setFieldErrors({});
    setError('');
    setSent(false);
    setSubmitting(false);
  }

  function handleClose() {
    if (submitting) return;
    resetState();
    onClose();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setFieldErrors({});

    const validation = validateForm(forgotPasswordSchema, { email });
    if (!validation.data) {
      setFieldErrors(validation.errors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await authApi.forgotPassword(validation.data.email);
      if (result?.exists === false) {
        setError('No account found with that email address. Please check the email and try again.');
        return;
      }
      setSent(true);
      showSuccess('If the account exists, a reset link has been sent.');
      // Surface the dev link in non-production for local testing.
      if (result?.devResetLink) {
        // Helpful during local development; ignore in production (never returned).
        console.info('[dev] password reset link:', result.devResetLink);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="modal__backdrop"
      role="presentation"
      onClick={handleClose}
    >
      <div
        ref={dialogRef}
        className="modal modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h2 id={titleId} className="modal__title">
            Reset your password
          </h2>
          <p className="modal__lead">
            Enter your work email and we'll send a reset link if an employee
            account exists for it.
          </p>
        </div>

        {sent ? (
          <div className="modal__body">
            <div className="alert alert--success" role="status">
              We've sent password reset instructions. Check your inbox (and spam
              folder).
            </div>
          </div>
        ) : (
          <form className="modal__form" onSubmit={handleSubmit}>
            <div className="modal__body">
              <label className="modal__field">
                Work email
                <input
                  ref={emailRef}
                  className="input"
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@company.com"
                  maxLength={254}
                  disabled={submitting}
                />
                <FieldError message={fieldErrors.email} />
              </label>
              {error && (
                <div className="alert alert--error modal__alert" role="alert">
                  {error}
                </div>
              )}
            </div>
            <div className="modal__footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <span className="spinner spinner--sm" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  'Send reset link'
                )}
              </button>
            </div>
          </form>
        )}

        {sent && (
          <div className="modal__footer">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleClose}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
