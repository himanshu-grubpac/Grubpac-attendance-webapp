import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../hooks/useEscapeKey.js';

const DEFAULT_PHASES = [
  'Fetching data…',
  'Building spreadsheet…',
  'Starting download…',
];

const PHASE_INTERVAL_MS = 1600;

export default function DownloadProgressModal({
  open,
  title = 'Preparing download',
  subtitle = '',
  phases = DEFAULT_PHASES,
  error = '',
  onClose,
}) {
  const titleId = useId();
  const descId = useId();
  const [phaseIndex, setPhaseIndex] = useState(0);
  const previouslyFocused = useRef(null);

  const hasError = Boolean(error);
  const isBusy = open && !hasError;
  const safePhases = phases.length > 0 ? phases : DEFAULT_PHASES;
  const currentPhase = safePhases[phaseIndex % safePhases.length];

  useEscapeKey(open && hasError, onClose);

  useEffect(() => {
    if (!open) {
      setPhaseIndex(0);
      return undefined;
    }
    if (hasError) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setPhaseIndex((index) => (index + 1) % safePhases.length);
    }, PHASE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [hasError, open, safePhases]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    previouslyFocused.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="modal__backdrop" role="presentation">
      <div
        className="modal modal--compact download-progress-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle && !hasError ? descId : undefined}
        aria-busy={isBusy || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId} className="modal__title">
            {hasError ? 'Download failed' : title}
          </h2>
          {subtitle && !hasError ? (
            <p id={descId} className="modal__lead muted">
              {subtitle}
            </p>
          ) : null}
        </header>

        <div className="modal__body">
          {hasError ? (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          ) : (
            <div className="help-attachment-upload__progress-panel" aria-live="polite">
              <div className="download-progress-modal__status">
                <span className="spinner spinner--sm" aria-hidden="true" />
                <p className="help-attachment-upload__progress-summary">{currentPhase}</p>
              </div>
              <div
                className="help-attachment-upload__progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={title}
              >
                <div className="help-attachment-upload__progress-fill help-attachment-upload__progress-fill--indeterminate" />
              </div>
            </div>
          )}
        </div>

        {hasError ? (
          <footer className="modal__footer">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
