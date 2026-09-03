/**
 * Staging verification for WFH salary safeguard + help multi-ticket API flows.
 * Uses staging CloudFront only — never prod. Reads credentials from server/.env.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://d24p2zn8763d4h.cloudfront.net';
const DEVICE_ID = 'wfh-help-verify-0000-4000-8000-000000000001';

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
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  if (jar.size === 0) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, path, { body, headers = {} } = {}) {
  const h = { ...headers };
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;
  const init = { method, headers: h };
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text: text.slice(0, 500) };
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const env = loadEnv();
  const results = { health: null, help: null, wfhSalary: null, errors: [] };

  // Health
  const health = await fetch(`${BASE}/api/health`);
  results.health = { status: health.status, ok: health.ok };
  assertOk(health.ok, `Health check failed: ${health.status}`);

  assertOk(env.ADMIN_EMAIL && env.ADMIN_PASSWORD, 'ADMIN_EMAIL/PASSWORD missing in server/.env');

  const adminLogin = await req('POST', '/api/auth/admin/login', {
    body: {
      identifier: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      deviceId: DEVICE_ID,
    },
  });
  assertOk(adminLogin.status === 200, `Admin login failed: ${adminLogin.status}`);

  // Help: create two tickets as sample employee if available
  const usersRes = await req('GET', '/api/admin/users?page=1&limit=5');
  const sampleEmployee = usersRes.json?.employees?.find(
    (e) => e.isActive && e.role !== 'admin' && e.email,
  );
  assertOk(sampleEmployee?.email, 'No active employee found on staging for help test');

  jar.clear();
  const EMP_PASSWORDS = ['Employee@12345', 'Employee@2026', env.ADMIN_PASSWORD].filter(Boolean);
  let empLogin = { status: 401 };
  let empPasswordUsed = null;
  for (const password of EMP_PASSWORDS) {
    empLogin = await req('POST', '/api/auth/user/login', {
      body: {
        identifier: sampleEmployee.email,
        password,
        deviceId: DEVICE_ID,
      },
    });
    if (empLogin.status === 200) {
      empPasswordUsed = password;
      break;
    }
  }
  assertOk(empLogin.status === 200, `Employee login failed after ${EMP_PASSWORDS.length} attempts`);

  const ticket1 = await req('POST', '/api/help/tickets', {
    body: {
      title: `Staging verify ticket 1 ${Date.now()}`,
      category: 'Other',
      priority: 'low',
      description: 'Automated staging verification for multi-ticket flow.',
    },
  });
  assertOk(ticket1.status === 201, `Create ticket 1 failed: ${ticket1.status}`);

  const ticket2 = await req('POST', '/api/help/tickets', {
    body: {
      title: `Staging verify ticket 2 ${Date.now()}`,
      category: 'Other',
      priority: 'low',
      description: 'Second ticket to confirm backend allows multiple tickets.',
    },
  });
  assertOk(ticket2.status === 201, `Create ticket 2 failed: ${ticket2.status}`);

  const list = await req('GET', '/api/help/tickets?scope=mine&page=1&limit=20');
  assertOk(list.status === 200, `List tickets failed: ${list.status}`);
  const ids = new Set([ticket1.json?.ticket?.id, ticket2.json?.ticket?.id]);
  const found = (list.json?.tickets ?? []).filter((t) => ids.has(t.id)).length;
  assertOk(found === 2, `Expected both new tickets in list, found ${found}`);
  results.help = { ok: true, ticketCount: list.json?.tickets?.length ?? 0, created: [...ids] };

  // WFH salary: admin sets WFH policy paid=false temporarily, apply+approve WFH, check summary
  jar.clear();
  await req('POST', '/api/auth/admin/login', {
    body: {
      identifier: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      deviceId: DEVICE_ID,
    },
  });

  const typesRes = await req('GET', '/api/leave/types');
  const wfhType = typesRes.json?.leaveTypes?.find((t) => t.code === 'WFH');
  assertOk(wfhType?.id, 'WFH leave type not found on staging');

  const policiesRes = await req('GET', `/api/leave/policies?year=${new Date().getFullYear()}`);
  const wfhPolicy = policiesRes.json?.policies?.find(
    (p) => p.leaveTypeId === wfhType.id || p.leaveType?.code === 'WFH',
  );

  let restoredPaid = null;
  if (wfhPolicy?.id) {
    restoredPaid = wfhPolicy.paid;
    if (wfhPolicy.paid !== false) {
      const patch = await req('PATCH', `/api/leave/policies/${wfhPolicy.id}`, {
        body: { paid: false },
      });
      assertOk(patch.status === 200, `Could not set WFH policy paid=false: ${patch.status}`);
    }
  }

  const employeeId = sampleEmployee.id;
  await req('PATCH', `/api/salary/users/${employeeId}`, {
    body: { monthlySalary: 50000, salaryEffectiveFrom: `${new Date().getFullYear()}-01-01` },
  });

  // Pick a future weekday in current month for WFH test
  const now = new Date();
  let testDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7));
  while (testDay.getUTCDay() === 0 || testDay.getUTCDay() === 6) {
    testDay = new Date(testDay.getTime() + 86400000);
  }
  const testDate = testDay.toISOString().slice(0, 10);
  const monthKey = testDate.slice(0, 7);

  jar.clear();
  await req('POST', '/api/auth/user/login', {
    body: {
      identifier: sampleEmployee.email,
      password: empPasswordUsed,
      deviceId: DEVICE_ID,
    },
  });

  const applyWfh = await req('POST', '/api/leave/requests', {
    body: {
      leaveTypeId: wfhType.id,
      startDate: testDate,
      endDate: testDate,
      reason: 'Staging WFH salary safeguard verification',
    },
  });
  assertOk(applyWfh.status === 201, `WFH apply failed: ${applyWfh.status} ${applyWfh.text}`);

  const requestId = applyWfh.json?.request?.id;
  assertOk(requestId, 'WFH request id missing');

  jar.clear();
  await req('POST', '/api/auth/admin/login', {
    body: {
      identifier: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      deviceId: DEVICE_ID,
    },
  });

  const approve = await req('PATCH', `/api/leave/requests/${requestId}`, {
    body: { status: 'approved', comment: 'Staging WFH salary verify' },
  });
  assertOk(approve.status === 200, `WFH approve failed: ${approve.status}`);

  const summary = await req(
    'GET',
    `/api/salary/summary?userId=${employeeId}&month=${monthKey}`,
  );
  assertOk(summary.status === 200, `Salary summary failed: ${summary.status}`);
  const paidLeaveDays = summary.json?.summary?.paidLeaveDays ?? 0;
  const lopDays = summary.json?.summary?.lopDays ?? 0;
  assertOk(paidLeaveDays >= 1, `Expected paidLeaveDays >= 1 for approved WFH, got ${paidLeaveDays}`);
  results.wfhSalary = {
    ok: true,
    month: monthKey,
    testDate,
    paidLeaveDays,
    lopDays,
    policyWasPaidFalse: wfhPolicy?.paid !== false,
  };

  if (wfhPolicy?.id && restoredPaid !== false) {
    await req('PATCH', `/api/leave/policies/${wfhPolicy.id}`, {
      body: { paid: restoredPaid ?? true },
    });
  }

  console.log(JSON.stringify({ ok: true, staging: BASE, results }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
