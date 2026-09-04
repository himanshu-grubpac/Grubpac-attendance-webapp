/**
 * One-off staging audit — run with: node scripts/staging-audit.mjs
 * Reads ADMIN_EMAIL / ADMIN_PASSWORD from server/.env (not printed).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://d24p2zn8763d4h.cloudfront.net';

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

function storeCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

function cookieHeader() {
  if (jar.size === 0) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, path, { body, headers = {}, rawBody } = {}) {
  const url = `${BASE}${path}`;
  const h = { ...headers };
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;

  const init = { method, headers: h };
  if (rawBody) {
    init.body = rawBody;
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary or plain text */
  }
  return { status: res.status, json, text: text.slice(0, 500), headers: Object.fromEntries(res.headers) };
}

function buildWorkbookBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function bulkUpload(buffer, csrfToken) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'audit-test.xlsx');
  const h = {};
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;

  const res = await fetch(`${BASE}/api/admin/users/bulk-upload`, { method: 'POST', headers: h, body: form });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text: text.slice(0, 800) };
}

const env = loadEnv();
const results = [];

function record(name, detail) {
  results.push({ name, ...detail });
}

async function main() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    record('env_load', { ok: false, hasEmail: Boolean(env.ADMIN_EMAIL), hasPassword: Boolean(env.ADMIN_PASSWORD) });
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // 1. Admin login
  const login = await req('POST', '/api/auth/admin/login', {
    body: {
      identifier: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      deviceId: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    },
  });
  record('admin_login', {
    status: login.status,
    ok: login.status === 200,
    role: login.json?.user?.role,
    email: login.json?.user?.email,
    message: login.json?.message,
    errors: login.json?.errors,
    raw: login.text,
  });

  const csrfToken = login.json?.csrfToken ?? jar.get('attendance_csrf');

  if (login.status !== 200) {
    // Try .env.example default password label only
    record('admin_login_note', { message: 'Login failed with server/.env credentials' });
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const endpoints = [
    ['GET', '/api/auth/me', 'auth_me'],
    ['GET', '/api/admin/users?limit=5', 'users_list'],
    ['GET', '/api/admin/users/stats', 'users_stats'],
    ['GET', '/api/admin/departments', 'departments'],
    ['GET', '/api/admin/roles', 'roles'],
    ['GET', '/api/leave/policies', 'leave_policies'],
    ['GET', '/api/leave/types', 'leave_types'],
    ['GET', '/api/admin/attendance?weekStart=2026-07-28', 'attendance_grid'],
    ['GET', '/api/admin/office-settings', 'office_settings'],
    ['GET', '/api/admin/reports/summary', 'reports_summary'],
    ['GET', '/api/salary/summaries?month=2026-07', 'salary_summaries'],
    ['GET', '/api/salary/export?month=2026-07', 'salary_export'],
    ['GET', '/api/notifications/unread-count', 'notifications'],
  ];

  for (const [method, path, name] of endpoints) {
    const r = await req(method, path);
    record(name, {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      message: r.json?.message,
      sample: r.json ? JSON.stringify(r.json).slice(0, 200) : r.text.slice(0, 100),
    });
  }

  // Template download
  const tplRes = await fetch(`${BASE}/api/admin/users/template`, {
    headers: { Cookie: cookieHeader() ?? '', Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  });
  storeCookies(tplRes);
  const tplBuf = Buffer.from(await tplRes.arrayBuffer());
  record('bulk_template_download', {
    status: tplRes.status,
    ok: tplRes.status === 200 && tplBuf[0] === 0x50 && tplBuf[1] === 0x4b,
    bytes: tplBuf.length,
  });

  // Bulk upload: Excel date serial (45658 = 2024-12-31) — validation-only row with unique email
  const unique = `audit.serial.${Date.now()}@grubpac.com`;
  const serial = 45658;
  const serialBuf = buildWorkbookBuffer([
    ['firstName', 'lastName', 'email', 'mobile', 'password', 'designation', 'joiningDate', 'department'],
    ['Audit', 'Serial', unique, '9876509999', 'Employee@12345', 'QA Engineer', serial, 'Development'],
  ]);
  const serialUpload = await bulkUpload(serialBuf, csrfToken);
  const serialRow = serialUpload.json?.results?.[0];
  record('bulk_upload_excel_serial_date', {
    status: serialUpload.status,
    summary: serialUpload.json?.summary,
    rowStatus: serialRow?.status,
    rowMessage: serialRow?.message,
  });

  // Bulk upload: intentionally invalid (missing designation) — no DB mutation expected
  const invalidBuf = buildWorkbookBuffer([
    ['firstName', 'lastName', 'email', 'mobile', 'password', 'joiningDate'],
    ['Bad', 'Row', `audit.invalid.${Date.now()}@grubpac.com`, '9876509998', 'Employee@12345', '2025-01-15'],
  ]);
  const invalidUpload = await bulkUpload(invalidBuf, csrfToken);
  const invalidRow = invalidUpload.json?.results?.[0];
  record('bulk_upload_validation_error', {
    status: invalidUpload.status,
    rowStatus: invalidRow?.status,
    rowMessage: invalidRow?.message,
  });

  // Bulk upload: ISO text date — tests non-serial path on staging
  const isoUnique = `audit.iso.${Date.now()}@grubpac.com`;
  const isoBuf = buildWorkbookBuffer([
    ['firstName', 'lastName', 'email', 'mobile', 'password', 'designation', 'joiningDate', 'department'],
    ['Audit', 'IsoDate', isoUnique, '9876509997', 'Employee@12345', 'QA Engineer', '2025-06-01', 'Development'],
  ]);
  const isoUpload = await bulkUpload(isoBuf, csrfToken);
  const isoRow = isoUpload.json?.results?.[0];
  record('bulk_upload_iso_text_date', {
    status: isoUpload.status,
    summary: isoUpload.json?.summary,
    rowStatus: isoRow?.status,
    rowMessage: isoRow?.message,
  });

  // Bulk upload: DD-MM-YYYY text date (common Excel export format)
  const ddmmUnique = `audit.ddmm.${Date.now()}@grubpac.com`;
  const ddmmBuf = buildWorkbookBuffer([
    ['firstName', 'lastName', 'email', 'mobile', 'password', 'designation', 'joiningDate', 'department'],
    ['Audit', 'DdMm', ddmmUnique, '9876509996', 'Employee@12345', 'QA Engineer', '01-06-2025', 'Development'],
  ]);
  const ddmmUpload = await bulkUpload(ddmmBuf, csrfToken);
  const ddmmRow = ddmmUpload.json?.results?.[0];
  record('bulk_upload_ddmm_text_date', {
    status: ddmmUpload.status,
    summary: ddmmUpload.json?.summary,
    rowStatus: ddmmRow?.status,
    rowMessage: ddmmRow?.message,
  });

  jar.clear();
  const empLogin = await req('POST', '/api/auth/user/login', {
    body: {
      identifier: 'employee.sample@grubpac.com',
      password: 'Employee@12345',
      deviceId: 'audit-script-002',
    },
  });
  record('employee_login_sample', {
    status: empLogin.status,
    ok: empLogin.status === 200,
    email: empLogin.json?.user?.email,
    message: empLogin.json?.message,
  });

  if (empLogin.status === 200) {
    const empMe = await req('GET', '/api/auth/me');
    const empToday = await req('GET', '/api/attendance/today');
    const empBalances = await req('GET', '/api/leave/balances/me');
    record('employee_me', { status: empMe.status, ok: empMe.status === 200 });
    record('employee_attendance_today', { status: empToday.status, ok: empToday.status === 200 });
    record('employee_leave_balances', { status: empBalances.status, ok: empBalances.status === 200 });
  }

  // CORS preflight simulation
  const corsRes = await fetch(`${BASE}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://d24p2zn8763d4h.cloudfront.net',
      'Access-Control-Request-Method': 'GET',
    },
  });
  record('cors_preflight', {
    status: corsRes.status,
    allowOrigin: corsRes.headers.get('access-control-allow-origin'),
  });

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
