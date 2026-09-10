import api from '../services/api.js';

const DEV_STARTUP_WINDOW_MS = 10_000;
const INITIAL_DELAY_MS = 250;
const MAX_DELAY_MS = 1500;

function isTransientNetworkError(error) {
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
  if (!import.meta.env.DEV) {
    try {
      await api.get('/health', { timeout: 5000 });
    } catch {
      // Best-effort warm-up; subsequent API calls handle their own errors.
    }
    return;
  }

  const deadline = Date.now() + maxWaitMs;
  let backoff = INITIAL_DELAY_MS;

  while (Date.now() < deadline) {
    try {
      await api.get('/health', { timeout: 2000 });
      return;
    } catch (error) {
      if (!isTransientNetworkError(error)) return;
      await delay(backoff);
      backoff = Math.min(Math.round(backoff * 1.4), MAX_DELAY_MS);
    }
  }
}

/**
 * Restore the current session when auth cookies may exist. Skips /auth/me when
 * no session cookies are present (e.g. login page before sign-in).
 */
export async function fetchSessionWithRetry(maxWaitMs = DEV_STARTUP_WINDOW_MS) {
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
