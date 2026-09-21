/** Session keys for module list filters (cleared on logout / user change). */
export const ADMIN_USERS_FILTER_STORAGE_KEY = 'grubpac.adminUsers.filters.v1';

const MODULE_FILTER_SESSION_KEYS = [ADMIN_USERS_FILTER_STORAGE_KEY];

export function clearModuleFilterStorage() {
  try {
    for (const key of MODULE_FILTER_SESSION_KEYS) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable — nothing to clear.
  }
}
