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

  return (
    <div className="password-input">
      <div className="password-input__field">
        <input
          id={inputId}
          className={`${className} password-input__control`}
          type={visible ? 'text' : 'password'}
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
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          disabled={disabled}
        >
          {visible ? 'Hide' : 'Show'}
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
