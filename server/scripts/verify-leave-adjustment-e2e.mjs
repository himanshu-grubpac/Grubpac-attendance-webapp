/**
 * Staging-safe E2E for leave adjustment grid, batch, audit report.
 * Uses server/.env credentials; hits local API (default http://localhost:5000).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE || 'http://localhost:5000';
const DEVICE_ID = 'leave-adjust-e2e-0000-4000-8000-000000000001';

function loadEnv() {
  const raw = readFileSync(resolve(__dirname, '../.env'), 'utf8').replace(/^\uFEFF/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const jar = new Map();
let csrfToken = null;

function storeCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      jar.set(key, val);
      if (key === 'attendance_csrf') csrfToken = val;
    }
  }
}

function cookieHeader() {
  if (jar.size === 0) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, path, { body, headers = {}, rawResponse } = {}) {
  const h = { ...headers };
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    h['X-CSRF-Token'] = csrfToken;
  }
  const init = { method, headers: h };
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  storeCookies(res);
  if (rawResponse) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ok: res.ok, buffer: buf, contentType: res.headers.get('content-type') };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 500) };
}

function isXlsx(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

async function main() {
  const env = loadEnv();
  const report = { base: BASE, tests: {} };

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.log(JSON.stringify({ ok: false, error: 'Missing ADMIN credentials in server/.env' }, null, 2));
    process.exit(1);
  }

  const health = await fetch(`${BASE}/api/health`);
  report.tests.health = { status: health.status, pass: health.ok };

  const login = await req('POST', '/api/auth/admin/login', {
    body: { identifier: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, deviceId: DEVICE_ID },
  });
  if (login.json?.csrfToken) csrfToken = login.json.csrfToken;
  report.tests.adminLogin = { status: login.status, pass: login.status === 200 };

  if (login.status !== 200) {
    console.log(JSON.stringify({ ok: false, report }, null, 2));
    process.exit(1);
  }

  const grid = await req('GET', '/api/leave/adjustments/grid?year=2026&page=1&limit=5');
  const gridOk =
    grid.status === 200 &&
    grid.json?.year === 2026 &&
    Array.isArray(grid.json?.rows) &&
    Array.isArray(grid.json?.leaveTypes) &&
    grid.json?.pagination?.page === 1;
  report.tests.adjustmentGrid = {
    status: grid.status,
    pass: gridOk,
    rowCount: grid.json?.rows?.length ?? 0,
    leaveTypeCount: grid.json?.leaveTypes?.length ?? 0,
    total: grid.json?.pagination?.total ?? null,
  };

  let testUser =
    grid.json?.rows?.find((r) => r.employeeCode === 'EMP114' || r.employeeCode === 'EMP115') ?? null;
  if (!testUser) {
    const search = await req('GET', '/api/leave/adjustments/grid?year=2026&page=1&limit=50&search=BulkTest');
    testUser =
      search.json?.rows?.find((r) => String(r.name || '').includes('BulkTest')) ??
      search.json?.rows?.[0] ??
      null;
    report.tests.gridSearchBulkTest = {
      status: search.status,
      found: Boolean(testUser),
      employeeCode: testUser?.employeeCode ?? null,
    };
  }

  const userIds = testUser?.id;
  const auditQuery = userIds
    ? `year=2026&fromYear=2025&toYear=2026&userIds=${userIds}`
    : 'year=2026&fromYear=2025&toYear=2026';
  const audit = await req('GET', `/api/leave/carry-bulk/audit-report?${auditQuery}`, { rawResponse: true });
  const auditOk = audit.status === 200 && isXlsx(audit.buffer);
  report.tests.auditReport = {
    status: audit.status,
    pass: auditOk,
    bytes: audit.buffer?.length ?? 0,
    contentType: audit.contentType,
    userIds: userIds ?? 'all-scoped',
  };

  let batchPass = { skipped: true, reason: 'No test user' };
  if (testUser && grid.json?.leaveTypes?.length) {
    const clType = grid.json.leaveTypes.find((t) => t.code === 'CL') ?? grid.json.leaveTypes[0];
    const typeId = clType.id;
    const current = testUser.carriedByLeaveType?.[typeId]?.carried ?? 0;
    const trial = current === 0 ? 0.5 : current;
    const batch = await req('POST', '/api/leave/adjustments/batch', {
      body: {
        adjustments: [
          {
            userId: testUser.id,
            leaveTypeId: typeId,
            year: 2026,
            carried: trial,
          },
        ],
      },
    });
    const revert =
      batch.status === 200 && trial !== current
        ? await req('POST', '/api/leave/adjustments/batch', {
            body: {
              adjustments: [
                {
                  userId: testUser.id,
                  leaveTypeId: typeId,
                  year: 2026,
                  carried: current,
                },
              ],
            },
          })
        : null;
    batchPass = {
      status: batch.status,
      pass: batch.status === 200 && (batch.json?.summary?.success ?? 0) >= 1,
      summary: batch.json?.summary ?? null,
      reverted: revert ? revert.status === 200 : trial === current,
      employeeCode: testUser.employeeCode,
      leaveType: clType.code,
    };
  }
  report.tests.batchAdjust = batchPass;

  const forbidden = await req('GET', '/api/leave/adjustments/grid?year=2026&page=1&limit=1');
  report.tests.permissionsNote = 'Admin should pass; employee test omitted unless EMP creds known';

  const allPass = Object.values(report.tests).every((t) => t.pass === true || t.skipped || t.pass === undefined);
  const criticalPass =
    report.tests.health.pass &&
    report.tests.adminLogin.pass &&
    report.tests.adjustmentGrid.pass &&
    report.tests.auditReport.pass &&
    (report.tests.batchAdjust.skipped || report.tests.batchAdjust.pass);

  console.log(JSON.stringify({ ok: criticalPass, report }, null, 2));
  process.exit(criticalPass ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
