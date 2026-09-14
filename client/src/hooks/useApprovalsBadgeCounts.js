import { useCallback, useEffect, useState } from 'react';
import { leaveApi } from '../services/api.js';
import { useOptionalAuth } from '../context/AuthContext.jsx';

/**
 * Pending approval-queue counts for nav badges + dashboard KPIs.
 * Fetches only for LEAVE_APPROVE holders; fails silent (badges hide).
 * Refreshes on mount and whenever the tab regains focus.
 * Null-safe outside AuthProvider (isolated page tests): badges stay empty.
 */
export function useApprovalsBadgeCounts() {
  const { user } = useOptionalAuth() ?? {};
  const [counts, setCounts] = useState(null);

  const canView = Boolean(user?.permissions?.includes('leave.approve'));

  const refresh = useCallback(async () => {
    if (!canView) {
      setCounts(null);
      return;
    }
    try {
      const data = await leaveApi.getApprovalsPendingCounts();
      setCounts(data.counts ?? null);
    } catch {
      setCounts(null);
    }
  }, [canView]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canView) return undefined;
    function handleVisibility() {
      if (document.visibilityState === 'visible') refresh().catch(() => {});
    }
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);
    const timer = window.setInterval(() => {
      refresh().catch(() => {});
    }, 60000);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
      window.clearInterval(timer);
    };
  }, [canView, refresh]);

  return { counts, total: counts?.total ?? 0, refresh };
}
