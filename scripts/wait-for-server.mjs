const HEALTH_URL = process.env.API_HEALTH_URL ?? 'http://localhost:5000/api/health';
// The in-memory MongoDB replica set can take longer than 30 seconds to start,
// particularly on its first run while its binary is prepared.
const MAX_WAIT_MS = Number(process.env.SERVER_WAIT_MS ?? 90_000);
const POLL_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServerHealthy() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  const started = Date.now();
  process.stdout.write('Waiting for API server');

  while (Date.now() - started < MAX_WAIT_MS) {
    if (await isServerHealthy()) {
      process.stdout.write(' ready.\n');
      return;
    }
    process.stdout.write('.');
    await sleep(POLL_MS);
  }

  process.stdout.write('\n');
  throw new Error(`API server did not become ready within ${MAX_WAIT_MS}ms (${HEALTH_URL})`);
}

await waitForServer();
