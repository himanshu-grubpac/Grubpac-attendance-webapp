/** Staging API read-only probe when direct MongoDB is unreachable from local network. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://d24p2zn8763d4h.cloudfront.net';
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = {};
  for (const line of readFileSync(resolve(__dirname, '../.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

const jar = new Map();
let csrf = null;

function store(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      jar.set(k, v);
      if (k === 'attendance_csrf') csrf = v;
    }
  }
}

async function req(method, path, body) {
  const h = {};
  if (jar.size) h.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (csrf && method !== 'GET') h['X-CSRF-Token'] = csrf;
  const init = { method, headers: h };
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  store(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text: text.slice(0, 400) };
}

async function main() {
  const env = loadEnv();
  const year = new Date().getFullYear();

  const health = await fetch(`${BASE}/api/health`);
  const adminAttempts = [
    { identifier: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  ].filter((a) => a.identifier && a.password);

  let login = { status: 0 };
  for (const cred of adminAttempts) {
    jar.clear();
    csrf = null;
    login = await req('POST', '/api/auth/admin/login', {
      identifier: cred.identifier,
      password: cred.password,
      deviceId: 'staging-api-probe-0000-4000-8000-000000000002',
    });
    if (login.status === 200) break;
    if (login.status !== 429) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const types = await req('GET', '/api/leave/types');
  const policies = await req('GET', `/api/leave/policies?year=${year}`);
  const approved = await req('GET', '/api/leave/requests?status=approved&page=1&limit=100');
  const users = await req('GET', '/api/admin/users?page=1&limit=100');

  const wfhType = types.json?.leaveTypes?.find((t) => t.code === 'WFH');
  const wfhPolicy = policies.json?.policies?.find(
    (p) => p.leaveType?.code === 'WFH' || p.leaveTypeCode === 'WFH',
  );
  const approvedWfh = (approved.json?.requests ?? []).filter(
    (r) => r.leaveTypeCode === 'WFH' || r.leaveType?.code === 'WFH',
  );
  const mohit = users.json?.employees?.find((e) => /mohit/i.test(e.name || e.email || ''));

  let mohitSalary = null;
  if (mohit?.id) {
    const month = `${year}-08`;
    const summary = await req('GET', `/api/salary/summary?userId=${mohit.id}&month=${month}`);
    mohitSalary = summary.status === 200 ? summary.json?.summary : { error: summary.status, text: summary.text };
  }

  console.log(
    JSON.stringify(
      {
        source: 'staging-api (CloudFront)',
        health: health.status,
        adminLogin: login.status,
        wfhType: wfhType ?? null,
        wfhPolicy: wfhPolicy
          ? {
              id: wfhPolicy.id,
              paid: wfhPolicy.paid,
              isActive: wfhPolicy.isActive,
              year: wfhPolicy.year,
              annualQuota: wfhPolicy.annualQuota,
            }
          : null,
        approvedWfhCount: approvedWfh.length,
        approvedWfh: approvedWfh.map((r) => ({
          userName: r.userName,
          userEmail: r.userEmail,
          startDate: r.startDate,
          endDate: r.endDate,
          days: r.days,
          status: r.status,
        })),
        mohit: mohit
          ? { id: mohit.id, name: mohit.name, email: mohit.email, monthlySalary: mohit.monthlySalary }
          : null,
        mohitAugSalarySummary: mohitSalary,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
