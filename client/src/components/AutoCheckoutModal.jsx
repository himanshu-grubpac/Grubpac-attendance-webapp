import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import TimeField from './TimeField.jsx';
const TYPE_OPTIONS = [
  { value: 'office', label: 'Office' },
  { value: 'wfh', label: 'WFH' },
];

const DAY_OPTIONS = [
  { value: 'same', label: 'Same day' },
  { value: 'next', label: 'Next day' },
];

/**
 * Auto-checkout settings dialog, matching the existing `.modal` popup UI used
 * across the app (centered overlay, no page scroll, escape to close).
 */
export default function AutoCheckoutModal({ open, initial, onClose, onSave }) {
  const [enabled, setEnabled] = useState(false);
  const [type, setType] = useState('office');
  const [office, setOffice] = useState({ day: 'same', time: '23:59' });
  const [wfh, setWfh] = useState({ day: 'next', time: '06:00' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const titleId = useId();
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  const previouslyFocused = useRef(null);
  const officeTimeRef = useRef(null);
  const wfhTimeRef = useRef(null);

  useEscapeKey(open && !saving, () => handleClose());

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;
    const focusTimer = setTimeout(() => firstFieldRef.current?.focus(), 0);
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

  useEffect(() => {
    if (!open) return;
    const cur = initial || {};
    setEnabled(Boolean(cur.enabled));
    setOffice({
      day: (cur.office && cur.office.day) || 'same',
      time: (cur.office && cur.office.time) || '23:59',
    });
    setWfh({
      day: (cur.wfh && cur.wfh.day) || 'next',
      time: (cur.wfh && cur.wfh.time) || '06:00',
    });
    setType(cur.type || 'office');
    setError('');
    setSaving(false);
  }, [open, initial]);

  if (!open) return null;

  const current = type === 'wfh' ? wfh : office;
  const setCurrentDay = (day) =>
    (type === 'wfh' ? setWfh : setOffice)((prev) => ({ ...prev, day }));
  const setCurrentTime = (time) =>
    (type === 'wfh' ? setWfh : setOffice)((prev) => ({ ...prev, time }));

  function handleClose() {
    if (saving) return;
    onClose();
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    // The TimeField only commits on blur/period click; if the user types a
    // time and clicks Save without blurring first, commit the pending input
    // and use the committed value (React state would still be stale here).
    const activeTimeRef = type === 'wfh' ? wfhTimeRef : officeTimeRef;
    const committedTime = activeTimeRef.current?.commit?.();
    if (!committedTime) {
      setError('Enter a valid auto-checkout time.');
      return;
    }

    const officeTime = type === 'office' ? committedTime : office.time;
    const wfhTime = type === 'wfh' ? committedTime : wfh.time;
    setSaving(true);
    setError('');
    try {
      const data = {
        enabled,
        office: { ...office, time: officeTime },
        wfh: { ...wfh, time: wfhTime },
      };
      await onSave(data);
    } catch (err) {
      setError(err.message || 'Failed to save settings.');
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal__backdrop" role="presentation" onClick={handleClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <h2 id={titleId} className="modal__title">
            Auto-checkout
          </h2>
          <p className="modal__lead">
            Set when employees still checked in are auto-checked out (IST). Choose the type, then the
            day and time.
          </p>
        </div>
        <form className="modal__form" onSubmit={handleSubmit}>
          <div className="modal__body">
            <label className="field-checkbox">
              <input
                ref={firstFieldRef}
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>Enable auto-checkout</span>
            </label>

            <label className="modal__field">
              Type
              <select
                className="input"
                value={type}
                onChange={(e) => setType(e.target.value)}
                aria-label="Leave type"
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="modal__field">
              <span className="field-label">Auto-checkout time</span>
              <div className="auto-checkout-time__rows">
                <label className="modal__subfield">
                  Day
                  <select
                    className="input"
                    value={current.day}
                    onChange={(e) => setCurrentDay(e.target.value)}
                    aria-label="Auto-checkout day"
                  >
                    {DAY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="modal__subfield">
                  Time
                  <TimeField
                    value={current.time}
                    onChange={setCurrentTime}
                    onInvalid={() => setError('Enter a valid auto-checkout time.')}
                    aria-label="Auto-checkout time"
                    innerRef={type === 'wfh' ? wfhTimeRef : officeTimeRef}
                  />
                </label>
              </div>
            </div>

            {error ? <div className="alert alert--error modal__alert">{error}</div> : null}
          </div>
          <div className="modal__footer">
            <button type="button" className="btn btn-ghost" onClick={handleClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Saving…' : 'Save timings'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
