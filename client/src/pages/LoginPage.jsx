import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { loginSchema } from '@shared/validation/auth.js';
import { getDefaultRoute } from '../config/nav.js';
import { BRANDING } from '../config/branding.js';
import { useAuth } from '../context/AuthContext.jsx';
import { getErrorMessage } from '../services/api.js';
import { validateForm } from '../utils/validation.js';
import CompanyLogo from '../components/CompanyLogo.jsx';
import FieldError from '../components/FieldError.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

const HERO_FEATURES = [
  'GPS-verified check-in and check-out',
  'Geofence-based office attendance',
  'Role-based access for admins and employees',
];

export default function LoginPage() {
  const { user, login, loginPortal } = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState('employee');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    return <Navigate to={getDefaultRoute(user, loginPortal)} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    const validation = validateForm(loginSchema, { identifier, password });
    if (!validation.data) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      const { user: loggedIn, loginPortal: signedInPortal } = await login(
        role,
        validation.data.identifier,
        validation.data.password,
      );
      navigate(getDefaultRoute(loggedIn, signedInPortal));
    } catch (err) {
      setError(getErrorMessage(err));
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
        <ThemeToggle />
      </div>

      <section className="login-hero" aria-label="Product overview">
        <div className="login-hero__content">
          <div className="login-hero__brand">
            <CompanyLogo size={56} showText={false} />
            <h1 className="login-hero__title">{BRANDING.appName}</h1>
            <p className="login-hero__tagline">
              {BRANDING.tagline} · {BRANDING.companyName}
            </p>
          </div>
          <ul className="login-hero__features">
            {HERO_FEATURES.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-panel__topbar login-panel__topbar--desktop">
          <ThemeToggle />
        </div>

        <div className="login-card card">
          <div className="login-card__header">
            <h1 className="login-card__title">Sign in</h1>
            <p className="login-tagline">Continue with your work account</p>
          </div>

          <div className="tab-row" role="tablist" aria-label="Login role">
            <button
              type="button"
              role="tab"
              aria-selected={role === 'employee'}
              className={`tab ${role === 'employee' ? 'tab--active' : ''}`}
              onClick={() => setRole('employee')}
            >
              Employee
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={role === 'admin'}
              className={`tab ${role === 'admin' ? 'tab--active' : ''}`}
              onClick={() => setRole('admin')}
            >
              Admin
            </button>
          </div>

          <form onSubmit={handleSubmit} className="form-stack login-card__form">
            <label>
              Email, mobile, or employee ID
              <input
                className="input"
                type="text"
                inputMode="email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                placeholder="you@company.com"
                maxLength={254}
                enterKeyHint="next"
              />
              <FieldError message={fieldErrors.identifier} />
            </label>
            <label>
              Password
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                maxLength={128}
              />
              <p className="field-hint">Contact admin to reset your password.</p>
              <FieldError message={fieldErrors.password} />
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
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

        <p className="login-page__footer">
          © {new Date().getFullYear()} {BRANDING.companyName}
        </p>
      </section>
    </div>
  );
}
