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

export async function waitForServerReady(maxWaitMs = DEV_STARTUP_WINDOW_MS) {
  if (!import.meta.env.DEV) return true;

  const deadline = Date.now() + maxWaitMs;
  let backoff = INITIAL_DELAY_MS;

  while (Date.now() < deadline) {
    try {
      await api.get('/health', { timeout: 2000 });
      return true;
    } catch (error) {
      if (!isTransientNetworkError(error)) return false;
      await delay(backoff);
      backoff = Math.min(Math.round(backoff * 1.4), MAX_DELAY_MS);
    }
  }

  return false;
}

export async function fetchSessionWithRetry(maxWaitMs = DEV_STARTUP_WINDOW_MS) {
  if (import.meta.env.DEV) {
    await waitForServerReady(maxWaitMs);
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
