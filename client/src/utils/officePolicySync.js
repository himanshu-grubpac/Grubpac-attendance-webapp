/**
 * Office-policy broadcast channel.
 *
 * Both office-settings writers (the full settings form AND the auto-checkout
 * modal) must notify listeners through this single helper. AdminAttendance
 * subscribes via the same-tab CustomEvent and the cross-tab `storage` event,
 * so saving through only one path (B-006) previously left other tabs stale.
 */
export const OFFICE_POLICY_EVENT = 'attendance:office-policy-updated';
export const OFFICE_POLICY_STORAGE_KEY = 'attendance.office-policy-updated';

export function broadcastOfficePolicyUpdated(settings) {
  if (!settings) return;
  window.dispatchEvent(new CustomEvent(OFFICE_POLICY_EVENT, { detail: settings }));
  try {
    localStorage.setItem(OFFICE_POLICY_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
