import { useCallback, useEffect, useRef, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { getErrorMessage } from '../services/api.js';

/**
 * Promise-based confirm helper for destructive / irreversible actions.
 *
 * Legacy: `const ok = await requestConfirm({ title, message }); if (ok) { ... }`
 * Async:  `await requestConfirm({ title, onConfirm: async () => { await api(); } })`
 *
 * When `onConfirm` is provided the dialog stays open until the action settles:
 * success closes the dialog; errors keep it open with an inline message.
 */
export function useConfirmDialog() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const resolverRef = useRef(null);
  const actionRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const close = useCallback((result) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    actionRef.current = null;
    if (!mountedRef.current) return;
    setState(null);
    setBusy(false);
    setConfirmError('');
  }, []);

  const handleCancel = useCallback(() => {
    if (busy) return;
    close(false);
  }, [busy, close]);

  const handleConfirm = useCallback(async () => {
    const action = actionRef.current;
    if (!action) {
      close(true);
      return;
    }

    setBusy(true);
    setConfirmError('');
    try {
      await action();
      close(true);
    } catch (err) {
      if (!mountedRef.current) return;
      setConfirmError(getErrorMessage(err));
      setBusy(false);
    }
  }, [close]);

  const requestConfirm = useCallback((options = {}) => {
    resolverRef.current?.(false);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      actionRef.current = options.onConfirm ?? null;
      setBusy(false);
      setConfirmError('');
      setState({
        title: options.title ?? 'Confirm',
        message: options.message ?? 'Are you sure you want to continue?',
        confirmLabel: options.confirmLabel ?? 'Confirm',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        busyLabel: options.busyLabel ?? 'Please wait…',
        variant: options.variant ?? 'default',
      });
    });
  }, []);

  const dialog = (
    <ConfirmDialog
      open={Boolean(state)}
      title={state?.title}
      message={state?.message}
      confirmLabel={state?.confirmLabel}
      cancelLabel={state?.cancelLabel}
      busyLabel={state?.busyLabel}
      variant={state?.variant}
      busy={busy}
      error={confirmError}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { requestConfirm, dialog };
}
