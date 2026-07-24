import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

export default function SlidePanel({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'min(100%, 28rem)',
}) {
  const titleId = useId();
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(() => {
      panelRef.current?.focus();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="slide-panel-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={panelRef}
        className="slide-panel"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="slide-panel__header">
          <div className="slide-panel__titles">
            <h2 id={titleId} className="slide-panel__title">
              {title}
            </h2>
            {subtitle ? <p className="slide-panel__subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="slide-panel__body">{children}</div>
        {footer ? <footer className="slide-panel__footer">{footer}</footer> : null}
      </aside>
    </div>,
    document.body,
  );
}
