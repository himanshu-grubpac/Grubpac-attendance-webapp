// UI end-to-end test for the employee password-reset flow.
// Starts the API in-process (memory DB), runs Vite as a proxy, then drives the
// real React UI with a headless browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const clientDir = path.join(repoRoot, 'client');
const serverSrc = path.join(repoRoot, 'server', 'src');

function importServer(relative) {
  return import(pathToFileURL(path.join(serverSrc, relative)).href);
}

process.env.NODE_ENV = 'test';
process.env.USE_MEMORY_DB = 'true';
process.env.JWT_SECRET = 'test-secret';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
// Force SMTP off so the suite never makes a real network call to a mail provider.
process.env.SMTP_HOST = '';

const API_PORT = 5000;
const CLIENT_PORT = 5173;
const API_BASE = `http://127.0.0.1:${API_PORT}/api`;

const empEmail = `ui.employee.${Date.now()}@grubpac.com`;
const oldPassword = 'OldPass@123';
const newPassword = 'NewPass@456';

let failed = 0;
function step(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      // not ready
    }
    await sleep(500);
  }
  throw new Error(`Server not ready: ${url}`);
}

async function main() {
  // --- Start API in-process ---
  const { app } = await importServer('index.js');
  const { connectDatabase } = await importServer(path.join('config', 'db.js'));
  const { User } = await importServer(path.join('models', 'User.js'));
  const bcrypt = (await import('bcryptjs')).default;

  await connectDatabase();
  const server = app.listen(API_PORT);
  await waitForServer(`${API_BASE}/health`);

  // --- Seed an employee ---
  await User.create({
    role: 'employee',
    firstName: 'UI',
    lastName: 'Employee',
    name: 'UI Employee',
    email: empEmail,
    mobile: `95${String(Date.now()).slice(-8)}`,
    passwordHash: await bcrypt.hash(oldPassword, 12),
    isActive: true,
  });

  // --- Serve the built client + proxy /api -> API (no Vite dependency) ---
  const distDir = path.join(clientDir, 'dist');
  const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  const staticServer = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const proxyReq = http.request(
        {
          host: '127.0.0.1',
          port: API_PORT,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', () => {
        res.writeHead(502);
        res.end('Bad gateway');
      });
      req.pipe(proxyReq);
      return;
    }
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.join(distDir, urlPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((resolve) => staticServer.listen(CLIENT_PORT, resolve));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const base = `http://localhost:${CLIENT_PORT}`;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await waitForServer(`http://localhost:${CLIENT_PORT}/login`);
    await sleep(500);
    // 1. Login page loads
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    step('login page renders', await page.getByText('Sign in').first().isVisible());

    // 2. Forgot password modal opens
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    step('forgot-password modal opens', await page.getByText('Reset your password').isVisible());

    // 3. Submit invalid email -> validation error (modal stays, error shown)
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await sleep(200);
    const validationErr = await page
      .locator('.field-error, .alert--error')
      .first()
      .isVisible()
      .catch(() => false);
    step('modal shows validation error for empty email', validationErr);

    // 4. Submit valid employee email -> success message
    await page.fill('input[type="email"]', empEmail);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    let sentOk = false;
    try {
      await page.getByText(/If an account exists/i).first().waitFor({ state: 'visible', timeout: 5000 });
      sentOk = true;
    } catch {
      sentOk = false;
    }
    step('modal shows success after submit', sentOk);

    // 5. Fetch the dev reset link token from the API (non-prod)
    const forgotRes = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: empEmail }),
    });
    const forgotData = await forgotRes.json();
    const token = new URL(forgotData.devResetLink).searchParams.get('token');
    step('dev reset link returned for employee', Boolean(token));

    // 6. Invalid token -> reset page shows invalid message
    await page.goto(`${base}/reset-password?token=garbage.token`, { waitUntil: 'networkidle' });
    let invalidShown = false;
    try {
      await page
        .getByText(/invalid|expired|already been used/i)
        .first()
        .waitFor({ state: 'visible', timeout: 5000 });
      invalidShown = true;
    } catch {
      invalidShown = false;
    }
    step('reset page shows invalid-token message', invalidShown);
    let backBtn = false;
    try {
      await page.getByRole('button', { name: /Back to sign in/i }).waitFor({ state: 'visible', timeout: 5000 });
      backBtn = true;
    } catch {
      backBtn = false;
    }
    step('invalid path offers back-to-sign-in', backBtn);

    // 7. Valid token -> reset form, fill + submit
    await page.goto(`${base}/reset-password?token=${token}`, { waitUntil: 'networkidle' });
    await page.fill('input[placeholder="Enter a new password"]', newPassword);
    await page.fill('input[placeholder="Re-enter the new password"]', newPassword);
    await page.getByRole('button', { name: 'Reset password' }).click();
    // Success state shows the "Continue to sign in" button (only rendered on done).
    let resetDone = false;
    try {
      await page
        .getByRole('button', { name: /Continue to sign in/i })
        .first()
        .waitFor({ state: 'visible', timeout: 8000 });
      resetDone = true;
    } catch {
      resetDone = false;
    }
    step('reset page shows success after submit', resetDone);

    // 8. Continue to sign in
    await page.getByRole('button', { name: /Continue to sign in/i }).click();
    await page.waitForURL('**/login', { timeout: 5000 });
    step('redirects to login after reset', page.url().includes('/login'));

    // 9. Login with new password works
    await page.fill('input[placeholder="you@company.com"]', empEmail);
    await page.fill('input[placeholder="Enter your password"]', newPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Should navigate away from /login to the employee portal
    const navigated = await page
      .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    step('user can log in with the new password', navigated);

    step('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    staticServer.close();
    await User.deleteMany({ email: empEmail });
    server.close();
  }

  console.log(`\nUI E2E password-reset: ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UI E2E harness error:', err);
  process.exit(1);
});
