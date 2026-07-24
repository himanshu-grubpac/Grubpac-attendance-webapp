import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

const ToastContext = createContext(null);

let toastCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback((message, options = {}) => {
    const id = ++toastCounter;
    const variant = options.variant ?? 'info';
    const durationMs = options.durationMs ?? 4000;

    setToasts((items) => [...items, { id, message, variant }]);

    if (durationMs > 0) {
      window.setTimeout(() => dismissToast(id), durationMs);
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
