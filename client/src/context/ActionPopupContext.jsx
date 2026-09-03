import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const ActionPopupContext = createContext(null);

const DEFAULT_DURATION_MS = 15000;

let popupCounter = 0;

export function ActionPopupProvider({ children }) {
  const [popups, setPopups] = useState([]);
  const timersRef = useRef(new Map());

  const dismissPopup = useCallback((id) => {
    const timeoutId = timersRef.current.get(id);
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      timersRef.current.delete(id);
    }
    setPopups((items) => items.filter((item) => item.id !== id));
  }, []);

  const showActionPopup = useCallback(
    (options = {}) => {
      const id = ++popupCounter;
      const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
      const popup = {
        id,
        message: options.message ?? '',
        undoLabel: options.undoLabel ?? 'Undo',
        onUndo: typeof options.onUndo === 'function' ? options.onUndo : null,
        durationMs,
      };

      setPopups((items) => [...items, popup]);

      if (durationMs > 0) {
        const timeoutId = window.setTimeout(() => dismissPopup(id), durationMs);
        timersRef.current.set(id, timeoutId);
      }

      return id;
    },
    [dismissPopup],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timeoutId of timers.values()) {
        window.clearTimeout(timeoutId);
      }
      timers.clear();
    };
  }, []);

  const value = useMemo(() => ({ showActionPopup, dismissPopup }), [showActionPopup, dismissPopup]);

  return (
    <ActionPopupContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="action-popup-stack" aria-live="polite" aria-relevant="additions">
          {popups.map((popup) => (
            <ActionPopupCard key={popup.id} popup={popup} onDismiss={dismissPopup} />
          ))}
        </div>,
        document.body,
      )}
    </ActionPopupContext.Provider>
  );
}

function ActionPopupCard({ popup, onDismiss }) {
  const [remaining, setRemaining] = useState(popup.durationMs);

  useEffect(() => {
    if (popup.durationMs <= 0) return undefined;
    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      const left = Math.max(0, popup.durationMs - (Date.now() - startedAt));
      setRemaining(left);
      if (left <= 0) window.clearInterval(intervalId);
    }, 250);
    return () => window.clearInterval(intervalId);
  }, [popup.durationMs]);

  const progress = popup.durationMs > 0 ? (remaining / popup.durationMs) * 100 : 0;

  function handleUndo() {
    popup.onUndo?.();
    onDismiss(popup.id);
  }

  return (
    <div className="action-popup" role="alertdialog" aria-label="Action confirmation">
      <div className="action-popup__body">
        <p className="action-popup__message">{popup.message}</p>
        {popup.onUndo ? (
          <button type="button" className="action-popup__undo" onClick={handleUndo}>
            {popup.undoLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="action-popup__close"
          aria-label="Dismiss"
          onClick={() => onDismiss(popup.id)}
        >
          &times;
        </button>
      </div>
      {popup.durationMs > 0 ? (
        <div className="action-popup__progress" aria-hidden="true">
          <span className="action-popup__progress-bar" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function useActionPopup() {
  const ctx = useContext(ActionPopupContext);
  if (!ctx) throw new Error('useActionPopup must be used within ActionPopupProvider');
  return ctx;
}
