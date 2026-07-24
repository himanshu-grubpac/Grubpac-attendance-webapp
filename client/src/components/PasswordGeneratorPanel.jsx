import { useState } from 'react';
import { generatePassword } from '@shared/utils/generatePassword.js';

export default function PasswordGeneratorPanel() {
  const [password, setPassword] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  async function handleGenerate() {
    const nextPassword = generatePassword();
    setPassword(nextPassword);

    try {
      await navigator.clipboard.writeText(nextPassword);
      setStatusMessage('Password generated and copied to clipboard. Paste it into the password column.');
    } catch {
      setStatusMessage('Password generated. Copy it into the password column.');
    }

    window.setTimeout(() => setStatusMessage(''), 5000);
  }

  return (
    <div className="password-generator">
      <p className="card__desc">
        Each row in the template needs a password (8+ chars with uppercase, lowercase, and a number).
        Generate one here and paste it into the Excel password column.
      </p>
      <div className="password-generator__row">
        <button type="button" className="btn btn-sm" onClick={handleGenerate}>
          Generate password
        </button>
        {password && (
          <code className="password-generator__value" aria-label="Generated password">
            {password}
          </code>
        )}
      </div>
      {statusMessage && (
        <p className="password-input__status" role="status" aria-live="polite">
          {statusMessage}
        </p>
      )}
    </div>
  );
}
