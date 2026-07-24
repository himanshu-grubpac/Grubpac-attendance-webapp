import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

/**
 * Accessible confirmation modal.
 * Variants: `default` (primary confirm) | `danger` (destructive).
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busyLabel = 'Please wait…',
  variant = 'default',
  busy = false,
  error = '',
  onConfirm,
  onCancel,
}) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEscapeKey(open && !busy, onCancel);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    const focusTarget = variant === 'danger' ? cancelRef.current : confirmRef.current;
    focusTarget?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event) {
      if (event.key !== 'Tab' || busy) return;
      const focusables = [cancelRef.current, confirmRef.current].filter(Boolean);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    dialogRef.current?.addEventListener('keydown', handleKeyDown);

    return () => {
      dialogRef.current?.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open, variant, busy]);

  if (!open) return null;

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={busy ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        className={`confirm-dialog${variant === 'danger' ? ' confirm-dialog--danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || busy) return;
          if (event.target === dialogRef.current) {
            event.preventDefault();
            onConfirm?.();
          }
        }}
      >
        <h2 id={titleId} className="confirm-dialog__title">
          {title}
        </h2>
        {message ? (
          <p id={descId} className="confirm-dialog__message">
            {message}
          </p>
        ) : null}
        {error ? (
          <div className="alert alert--error confirm-dialog__error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                {busyLabel}
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
