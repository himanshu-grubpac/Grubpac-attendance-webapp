import { getDefaultRoute } from '../config/nav.js';

/** Paths that accept email "Take Action" deep links (?decision=request&requestId=). */
const EMAIL_ACTION_PATHS = ['/admin/leave/approvals', '/admin/leave/comp-off'];

function splitPath(path) {
  const qIndex = path.indexOf('?');
  if (qIndex === -1) {
    return { pathname: path, search: '' };
  }
  return { pathname: path.slice(0, qIndex), search: path.slice(qIndex) };
}

/**
 * Only email action links should survive login — not stale module URLs saved
 * when a session expires or the user logs out from a filtered list page.
 */
export function isIntentionalAuthDeepLink(path) {
  if (typeof path !== 'string') return false;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (path.startsWith('/login') || path.startsWith('/reset-password')) return false;

  const { pathname, search } = splitPath(path);
  const params = new URLSearchParams(search);
  if (params.get('decision') !== 'request' || !params.get('requestId')) {
    return false;
  }

  return EMAIL_ACTION_PATHS.some(
    (allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`),
  );
}

export function resolvePostLoginPath(from, user, loginPortal) {
  if (isIntentionalAuthDeepLink(from)) {
    return from;
  }
  return getDefaultRoute(user, loginPortal);
}
