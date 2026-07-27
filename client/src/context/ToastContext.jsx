import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const ToastContext = createContext(null);

export const SUCCESS_TOAST_DURATION_MS = 4500;
export const ERROR_TOAST_DURATION_MS = 7000;

let toastCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timeoutsRef = useRef(new Map());

  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      for (const timeoutId of timeouts.values()) {
        window.clearTimeout(timeoutId);
      }
      timeouts.clear();
    };
  }, []);

  const dismissToast = useCallback((id) => {
    const timeoutId = timeoutsRef.current.get(id);
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      timeoutsRef.current.delete(id);
    }
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback((message, options = {}) => {
    const id = ++toastCounter;
    const variant = options.variant ?? 'success';
    const durationMs =
      options.durationMs ??
      (variant === 'error' ? ERROR_TOAST_DURATION_MS : SUCCESS_TOAST_DURATION_MS);

    setToasts((items) => [...items, { id, message, variant }]);

    if (durationMs > 0) {
      const timeoutId = window.setTimeout(() => dismissToast(id), durationMs);
      timeoutsRef.current.set(id, timeoutId);
    }

    return id;
  }, [dismissToast]);

  const value = useMemo(
    () => ({
      showToast,
      showSuccess: (message, options) => showToast(message, { ...options, variant: 'success' }),
      showError: (message, options) => showToast(message, { ...options, variant: 'error' }),
    }),
    [showToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-stack" aria-live="polite" aria-relevant="additions">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`toast toast--${toast.variant}`}
              role={toast.variant === 'error' ? 'alert' : 'status'}
            >
              <span>{toast.message}</span>
              <button
                type="button"
                className="toast__close"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
