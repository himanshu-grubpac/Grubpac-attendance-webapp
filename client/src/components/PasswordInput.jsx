import { useId, useState } from 'react';
import { generatePassword } from '@shared/utils/generatePassword.js';

export default function PasswordInput({
  id,
  value,
  onChange,
  className = 'input',
  autoComplete,
  placeholder,
  maxLength = 128,
  disabled = false,
  showGenerate = false,
  onGenerated,
  inputMode,
  type = 'password',
}) {
  const [visible, setVisible] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  function updateValue(nextValue) {
    onChange({ target: { value: nextValue } });
  }

  async function handleGenerate() {
    const nextPassword = generatePassword();
    updateValue(nextPassword);
    onGenerated?.(nextPassword);

    try {
      await navigator.clipboard.writeText(nextPassword);
      setStatusMessage('Password generated and copied to clipboard.');
    } catch {
      setStatusMessage(`Password generated: ${nextPassword}`);
    }

    window.setTimeout(() => setStatusMessage(''), 4000);
  }

  const showPassword = type === 'text' ? true : visible;

  return (
    <div className="password-input">
      <div className="password-input__field">
        <input
          id={inputId}
          className={`${className} password-input__control`}
          type={showPassword ? 'text' : 'password'}
          inputMode={inputMode}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
        />
        <button
          type="button"
          className="password-input__toggle btn btn-ghost btn-sm"
          onClick={() => setVisible((current) => !current)}
          aria-label={showPassword ? 'Hide what is written' : 'Show what is written'}
          aria-pressed={showPassword}
          disabled={disabled}
        >
          <span className="password-input__eye" aria-hidden="true">
            {showPassword ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
                <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
              </svg>
            )}
          </span>
        </button>
      </div>
      {showGenerate && (
        <div className="password-input__actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleGenerate}
            disabled={disabled}
          >
            Generate password
          </button>
        </div>
      )}
      {statusMessage && (
        <p className="password-input__status" role="status" aria-live="polite">
          {statusMessage}
        </p>
      )}
    </div>
  );
}
