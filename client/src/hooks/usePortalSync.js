import { useEffect } from 'react';
import {
  PORTAL_SYNC_EVENT,
  PORTAL_SYNC_STORAGE_KEY,
  shouldHandlePortalSync,
} from '../utils/portalSync.js';

/**
 * Refetch when a portal mutation broadcast matches subscribed topics (and optional user/month).
 */
export function usePortalSync(onSync, options = {}) {
  const { topics = [], userId = null, month = null, enabled = true } = options;

  useEffect(() => {
    if (!enabled || typeof onSync !== 'function') return undefined;

    function handleDetail(detail) {
      if (!shouldHandlePortalSync(detail, { topics, userId, month })) {
        return;
      }
      onSync(detail);
    }

    function handleEvent(event) {
      handleDetail(event.detail);
    }

    function handleStorage(event) {
      if (event.key !== PORTAL_SYNC_STORAGE_KEY || !event.newValue) return;
      try {
        handleDetail(JSON.parse(event.newValue));
      } catch {
        // Ignore invalid cached event data.
      }
    }

    window.addEventListener(PORTAL_SYNC_EVENT, handleEvent);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(PORTAL_SYNC_EVENT, handleEvent);
      window.removeEventListener('storage', handleStorage);
    };
  }, [enabled, month, onSync, topics, userId]);
}
