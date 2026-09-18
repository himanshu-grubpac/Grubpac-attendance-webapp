import { usePortalSync } from './usePortalSync.js';
import { PORTAL_TOPICS } from '../utils/portalSync.js';

/**
 * Refetch salary/LOP views when attendance or other payroll-affecting writes occur.
 * @deprecated Prefer usePortalSync with topics: ['payroll'].
 */
export function useSalaryLopSync(onSync, options = {}) {
  const { userId = null, month = null } = options;
  usePortalSync(onSync, { topics: [PORTAL_TOPICS.PAYROLL], userId, month });
}
