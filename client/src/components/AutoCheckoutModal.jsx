import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { adminApi, getErrorMessage } from '../services/api.js';
import { useToast } from '../context/ToastContext.jsx';
import TimeField from './TimeField.jsx';
import FieldError from './FieldError.jsx';
import { autoCheckoutSchema } from '@shared/validation/office.js';
import { validateForm } from '../utils/validation.js';

export default function AutoCheckoutModal({ open, initial, onClose }) {
  const { showSuccess } = useToast();
  const titleId = 'auto-checkout-modal-title';
  const [enabled, setEnabled] = useState(true);
  const [officeTime, setOfficeTime] = useState('23:59');
  const [wfhTime, setWfhTime] = useState('06:00');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setEnabled(initial?.enabled ?? true);
      setOfficeTime(initial?.officeTime ?? '23:59');
      setWfhTime(initial?.wfhTime ?? '06:00');
      setError('');
      setFieldErrors({});
    }
  }, [open, initial]);

  useEscapeKey(open && !saving, () => onClose(null));

  if (!open) return null;

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setFieldErrors({});
    const validation = validateForm(autoCheckoutSchema, { enabled, officeTime, wfhTime });
    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSaving(false);
      return;
    }
    try {
      const result = await adminApi.updateOfficeSettings({ autoCheckout: validation.data });
      showSuccess('Auto-checkout settings saved.');
      onClose(result.settings?.autoCheckout ?? validation.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="modal__backdrop"
      role="presentation"
      onClick={saving ? undefined : () => onClose(null)}
    >
      <div
        className="modal modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <h2 id={titleId} className="modal__title">
            Auto-checkout timings
          </h2>
        </div>
        <form className="modal__form" onSubmit={handleSubmit}>
          <div className="modal__body">
            <p className="modal__lead">
              Set when employees still checked in are auto-checked out (IST). You can update Office,
              WFH, or both.
            </p>
            <label className="field-checkbox modal__field">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>Enable auto-checkout</span>
            </label>
            <label className="modal__field">
              Office auto-checkout (same day)
              <TimeField value={officeTime} onChange={setOfficeTime} aria-label="Office auto-checkout time" />
              <FieldError message={fieldErrors.officeTime} />
            </label>
            <label className="modal__field">
              WFH auto-checkout (next day)
              <TimeField value={wfhTime} onChange={setWfhTime} aria-label="WFH auto-checkout time" />
              <FieldError message={fieldErrors.wfhTime} />
            </label>
            {error ? <div className="alert alert--error modal__alert">{error}</div> : null}
          </div>
          <div className="modal__footer">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onClose(null)}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save timings'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}