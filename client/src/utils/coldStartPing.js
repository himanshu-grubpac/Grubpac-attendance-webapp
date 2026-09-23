import api from '../services/api.js';

const DEV_STARTUP_WINDOW_MS = 10_000;
const INITIAL_DELAY_MS = 250;
const MAX_DELAY_MS = 1500;

function isTransientNetworkError(error) {
  if (error?.response?.status === 503) return true;
  if (error?.response) return false;
  const code = error?.code ?? '';
  const message = String(error?.message ?? '').toLowerCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ERR_NETWORK' ||
    message.includes('network error') ||
    message.includes('econnrefused')
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** CSRF cookie is issued with the httpOnly auth cookie on login. */
export function hasSessionCookieHint() {
  if (typeof document === 'undefined') return false;
  return /(?:^|;\s*)attendance_csrf=([^;]+)/.test(document.cookie);
}

/**
 * Best-effort ping to /api/health — warms Lambda on cold start and waits for
 * the local dev API to accept connections. Does not touch authenticated routes.
 */
export async function coldStartPing(maxWaitMs = DEV_STARTUP_WINDOW_MS) {
  const deadline = Date.now() + maxWaitMs;
  let backoff = INITIAL_DELAY_MS;
  const timeoutMs = import.meta.env.DEV ? 2000 : 5000;

  while (Date.now() < deadline) {
    try {
      await api.get('/health', { timeout: timeoutMs });
      return;
    } catch (error) {
      if (!isTransientNetworkError(error)) return;
      await delay(backoff);
      backoff = Math.min(Math.round(backoff * 1.4), MAX_DELAY_MS);
    }
  }
}

/**
 * Restores the signed-in session on app boot. Skips /auth/me when no session
 * cookies are present. The retry loop only covers local dev-server startup races.
 */
export async function restoreSession(maxWaitMs = DEV_STARTUP_WINDOW_MS) {
  if (!hasSessionCookieHint()) {
    await coldStartPing(maxWaitMs);
    return { user: null };
  }

  if (import.meta.env.DEV) {
    await coldStartPing(maxWaitMs);
  }

  const deadline = Date.now() + maxWaitMs;
  let backoff = INITIAL_DELAY_MS;

  while (true) {
    try {
      const { data } = await api.get('/auth/me');
      return data;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 401) return { user: null };

      const canRetry =
        import.meta.env.DEV &&
        isTransientNetworkError(error) &&
        Date.now() < deadline;

      if (!canRetry) throw error;

      await delay(backoff);
      backoff = Math.min(Math.round(backoff * 1.4), MAX_DELAY_MS);
    }
  }
}
