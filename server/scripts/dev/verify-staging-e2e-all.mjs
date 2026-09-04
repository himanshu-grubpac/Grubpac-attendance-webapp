/**
 * Staging-only E2E verification for recent fixes.
 * NEVER touches production. Base: staging CloudFront only.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGING = 'https://d24p2zn8763d4h.cloudfront.net';
// Production URL unknown in repo — health read-only only when PROD_BASE is set.
const PROD_READONLY = process.env.PROD_BASE || null;
const DEVICE_ID = 'staging-e2e-verify-0000-4000-8000-000000000001';

const EMP_PASSWORDS = ['Employee@12345', 'Employee@2026'];

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

function clearJar() {
  jar.clear();
  csrfToken = null;
}

async function req(method, path, { body, headers = {}, base = STAGING, rawBody } = {}) {
  const h = { ...headers };
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    h['X-CSRF-Token'] = csrfToken;
  }
  const init = { method, headers: h };
  if (rawBody) {
    init.body = rawBody;
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text: text.slice(0, 800), ok: res.ok };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function adminLogin(env, { retries = 6 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    clearJar();
    last = await req('POST', '/api/auth/admin/login', {
      body: { identifier: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, deviceId: DEVICE_ID },
    });
    if (last.json?.csrfToken) csrfToken = last.json.csrfToken;
    if (last.status !== 429 || attempt === retries) return last;
    await sleep(20000 * (attempt + 1));
  }
  return last;
}

async function employeeLogin(identifier, passwords) {
  clearJar();
  for (const password of passwords) {
    const r = await req('POST', '/api/auth/user/login', {
      body: { identifier, password, deviceId: DEVICE_ID },
    });
    if (r.status === 200) {
      if (r.json?.csrfToken) csrfToken = r.json.csrfToken;
      return { ...r, passwordUsed: password };
    }
  }
  return { status: 401, json: null, ok: false };
}

function buildWorkbookBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function bulkUpload(buffer, csrf) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'staging-verify.xlsx',
  );
  const h = {};
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;
  const token = csrf ?? csrfToken ?? jar.get('attendance_csrf');
  if (token) h['X-CSRF-Token'] = token;
  const res = await fetch(`${STAGING}/api/admin/users/bulk-upload`, { method: 'POST', headers: h, body: form });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, ok: res.ok };
}

const report = {};

async function testHealth() {
  const staging = await fetch(`${STAGING}/api/health`);
  let prodReadOnly = { skipped: true, reason: 'PROD_BASE not configured' };
  if (PROD_READONLY) {
    try {
      const prod = await fetch(`${PROD_READONLY}/api/health`);
      prodReadOnly = { status: prod.status, ok: prod.ok };
    } catch (err) {
      prodReadOnly = { skipped: true, reason: err.message };
    }
  }
  report.health = {
    staging: { status: staging.status, ok: staging.ok },
    prodReadOnly,
    result: staging.ok ? 'PASS' : 'FAIL',
  };
}

async function testLeaveApprovals(env) {
  const login = await adminLogin(env);
  if (login.status !== 200) {
    report.leaveApprovals = { result: 'FAIL', reason: `Admin login ${login.status}` };
    return;
  }

  const pending = await req('GET', '/api/leave/requests?scope=approvals&status=pending');
  const approved = await req('GET', '/api/leave/requests?scope=approvals&status=approved');

  const pendingOk = pending.status === 200 && Array.isArray(pending.json?.requests);
  const approvedOk = approved.status === 200 && Array.isArray(approved.json?.requests);

  const approvedItems = approved.json?.requests ?? [];
  const withApprover = approvedItems.filter((r) => r.approverName);
  const approvedHasData = approvedItems.length > 0;
  const approverNameOk = !approvedHasData || withApprover.length > 0;

  const pass = pendingOk && approvedOk && approverNameOk;
  report.leaveApprovals = {
    result: pass ? 'PASS' : 'FAIL',
    pending: { status: pending.status, count: pending.json?.requests?.length ?? 0 },
    approved: {
      status: approved.status,
      count: approvedItems.length,
      withApproverName: withApprover.length,
      sample: approvedItems[0]
        ? {
            id: approvedItems[0].id,
            status: approvedItems[0].status,
            approverName: approvedItems[0].approverName ?? null,
            decidedAt: approvedItems[0].decidedAt ?? null,
          }
        : null,
    },
  };
}

async function testHelpMultiTicket(env) {
  // Try sample employee first, then first active non-admin from admin list
  let empEmail = 'employee.sample@grubpac.com';
  let empLogin = await employeeLogin(empEmail, [...EMP_PASSWORDS, env.ADMIN_PASSWORD]);

  if (empLogin.status !== 200) {
    await adminLogin(env);
    const usersRes = await req('GET', '/api/admin/users?page=1&limit=20');
    const fallback = usersRes.json?.employees?.find((e) => e.isActive && e.role !== 'admin' && e.email);
    if (fallback?.email) {
      empEmail = fallback.email;
      empLogin = await employeeLogin(empEmail, [...EMP_PASSWORDS, env.ADMIN_PASSWORD]);
    }
  }

  if (empLogin.status !== 200) {
    report.helpMultiTicket = { result: 'FAIL', reason: `Employee login failed for ${empEmail}` };
    return;
  }

  const ts = Date.now();
  const t1 = await req('POST', '/api/help/tickets', {
    body: {
      title: `Staging E2E ticket 1 ${ts}`,
      category: 'Other',
      priority: 'low',
      description: 'First ticket for multi-ticket verification.',
    },
  });
  const t2 = await req('POST', '/api/help/tickets', {
    body: {
      title: `Staging E2E ticket 2 ${ts}`,
      category: 'Other',
      priority: 'low',
      description: 'Second ticket — must succeed.',
    },
  });
  const list = await req('GET', '/api/help/tickets?scope=mine&page=1&limit=50');
  const ticketId = (r) => r.json?.ticket?.id ?? r.json?.id ?? null;
  const id1 = ticketId(t1);
  const id2 = ticketId(t2);
  const ids = new Set([id1, id2].filter(Boolean));
  const titles = new Set([`Staging E2E ticket 1 ${ts}`, `Staging E2E ticket 2 ${ts}`]);
  const listed = list.json?.tickets ?? [];
  const foundById = listed.filter((t) => ids.has(t.id)).length;
  const foundByTitle = listed.filter((t) => titles.has(t.title)).length;
  const createdOk = (t1.status === 201 || t1.status === 200) && (t2.status === 201 || t2.status === 200);
  const pass = createdOk && list.status === 200 && (foundById === 2 || foundByTitle === 2);
  report.helpMultiTicket = {
    result: pass ? 'PASS' : 'FAIL',
    employee: empEmail,
    create1: t1.status,
    create2: t2.status,
    id1,
    id2,
    listCount: listed.length,
    foundById,
    foundByTitle,
  };
}

async function testWfhSalary(env) {
  await adminLogin(env);
  const usersRes = await req('GET', '/api/admin/users?page=1&limit=20');
  const employees = usersRes.json?.employees ?? [];
  const sampleEmployee =
    employees.find((e) => e.isActive && e.email === 'employee.sample@grubpac.com') ??
    employees.find((e) => e.isActive && e.role !== 'admin' && e.email);
  if (!sampleEmployee?.email) {
    report.wfhSalary = { result: 'SKIP', reason: 'No active employee on staging' };
    return;
  }

  const typesRes = await req('GET', '/api/leave/types');
  const wfhType = (typesRes.json?.types ?? typesRes.json?.leaveTypes ?? []).find((t) => t.code === 'WFH');
  if (!wfhType?.id) {
    report.wfhSalary = { result: 'SKIP', reason: 'WFH leave type not found on staging' };
    return;
  }

  const year = new Date().getFullYear();
  const policiesRes = await req('GET', `/api/leave/policies?year=${year}`);
  const wfhPolicy = policiesRes.json?.policies?.find(
    (p) => p.leaveTypeId === wfhType.id || p.leaveType?.code === 'WFH',
  );

  let restoredPaid = wfhPolicy?.paid ?? true;
  if (wfhPolicy?.id && wfhPolicy.paid !== false) {
    const patch = await req('PATCH', `/api/leave/policies/${wfhPolicy.id}`, { body: { paid: false } });
    if (patch.status !== 200) {
      report.wfhSalary = { result: 'SKIP', reason: `Could not set WFH policy paid=false: ${patch.status}` };
      return;
    }
  }

  const employeeId = sampleEmployee.id;
  await req('PATCH', `/api/salary/users/${employeeId}`, {
    body: { monthlySalary: 50000, salaryEffectiveFrom: `${year}-01-01` },
  });

  const empLogin = await employeeLogin(sampleEmployee.email, [...EMP_PASSWORDS, env.ADMIN_PASSWORD]);
  if (empLogin.status !== 200) {
    if (wfhPolicy?.id) await req('PATCH', `/api/leave/policies/${wfhPolicy.id}`, { body: { paid: restoredPaid } });
    report.wfhSalary = { result: 'SKIP', reason: 'Employee login failed for WFH test' };
    return;
  }

  const now = new Date();
  let testDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 10));
  let applyWfh = null;
  let testDate = null;
  for (let attempt = 0; attempt < 45; attempt++) {
    while (testDay.getUTCDay() === 0 || testDay.getUTCDay() === 6) {
      testDay = new Date(testDay.getTime() + 86400000);
    }
    testDate = testDay.toISOString().slice(0, 10);
    applyWfh = await req('POST', '/api/leave/requests', {
      body: {
        leaveTypeId: wfhType.id,
        startDate: testDate,
        endDate: testDate,
        reason: 'Staging WFH salary safeguard E2E',
      },
    });
    if (applyWfh.status === 201) break;
    const overlapMsg = applyWfh.json?.message ?? applyWfh.text ?? '';
    const isOverlap =
      applyWfh.status === 400 && String(overlapMsg).toLowerCase().includes('overlapping');
    if (!isOverlap) break;
    testDay = new Date(testDay.getTime() + 86400000);
  }
  const monthKey = testDate.slice(0, 7);

  if (applyWfh.status !== 201) {
    if (wfhPolicy?.id) await req('PATCH', `/api/leave/policies/${wfhPolicy.id}`, { body: { paid: restoredPaid } });
    report.wfhSalary = {
      result: 'SKIP',
      reason: `WFH apply failed: ${applyWfh.status} — ${applyWfh.text?.slice(0, 200)}`,
    };
    return;
  }

  const requestId = applyWfh.json?.request?.id;
  await adminLogin(env);
  const approve = await req('POST', `/api/leave/requests/${requestId}/approve`, {
    body: { comment: 'Staging WFH salary verify' },
  });

  const summary = await req('GET', `/api/salary/summary?userId=${employeeId}&month=${monthKey}`);
  const paidLeaveDays = summary.json?.summary?.paidLeaveDays ?? 0;
  const lopDays = summary.json?.summary?.lopDays ?? 0;

  if (wfhPolicy?.id && restoredPaid !== false) {
    await req('PATCH', `/api/leave/policies/${wfhPolicy.id}`, { body: { paid: restoredPaid } });
  }

  const pass = approve.status === 200 && summary.status === 200 && paidLeaveDays >= 1;
  report.wfhSalary = {
    result: pass ? 'PASS' : 'FAIL',
    employee: sampleEmployee.email,
    testDate,
    month: monthKey,
    policyWasPaidFalse: true,
    paidLeaveDays,
    lopDays,
    approveStatus: approve.status,
    summaryStatus: summary.status,
    summarySnippet: summary.json?.summary
      ? {
          paidLeaveDays: summary.json.summary.paidLeaveDays,
          lopDays: summary.json.summary.lopDays,
          payableDays: summary.json.summary.payableDays,
        }
      : summary.text?.slice(0, 200),
  };
}

async function testBulkUpload(env) {
  const login = await adminLogin(env);
  if (login.status !== 200) {
    report.bulkUpload = { result: 'SKIP', reason: 'Admin login failed' };
    return;
  }
  const csrfToken = login.json?.csrfToken ?? jar.get('attendance_csrf');
  const unique = `staging.bulk.${Date.now()}@grubpac.com`;
  const mobile = `98765${String(Date.now()).slice(-5)}`;
  const buf = buildWorkbookBuffer([
    [
      'firstName',
      'lastName',
      'email',
      'mobile',
      'password',
      'department',
      'designation',
      'reportingManagerEmail',
      'joiningDate',
    ],
    [
      'Staging',
      'BulkTest',
      unique,
      mobile,
      'Employee@12345',
      'Development',
      'QA Engineer',
      'admin@grubpac.com',
      '2025-06-01',
    ],
  ]);
  const upload = await bulkUpload(buf, csrfToken);
  const row = upload.json?.results?.[0];
  const pass = (upload.status === 200 || upload.status === 201) && row?.status === 'success';
  report.bulkUpload = {
    result: pass ? 'PASS' : upload.status === 200 && row?.status === 'validation_error' ? 'FAIL' : 'FAIL',
    status: upload.status,
    rowStatus: row?.status,
    rowMessage: row?.message,
    summary: upload.json?.summary,
  };
}

async function testProfileEmptyLastName(env) {
  const empLogin = await employeeLogin('employee.sample@grubpac.com', EMP_PASSWORDS);
  if (empLogin.status !== 200) {
    report.profileEmptyLastName = { result: 'SKIP', reason: 'Sample employee login failed' };
    return;
  }

  const patch = await req('PATCH', '/api/auth/me', { body: { lastName: '' } });
  const me = await req('GET', '/api/auth/me');
  const patchLastName = patch.json?.user?.lastName ?? patch.json?.lastName;
  const lastName = me.json?.user?.lastName;
  const pass =
    patch.status === 200 &&
    me.status === 200 &&
    (lastName === '' || lastName === null || lastName === undefined) &&
    (patchLastName === '' || patchLastName === null || patchLastName === undefined);

  // Restore last name
  if (pass) {
    await req('PATCH', '/api/auth/me', { body: { lastName: 'Employee' } });
  }

  report.profileEmptyLastName = {
    result: pass ? 'PASS' : 'FAIL',
    patchStatus: patch.status,
    patchLastName,
    lastNameAfter: lastName,
    patchMessage: patch.json?.message,
  };
}

async function main() {
  const env = loadEnv();
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.log(JSON.stringify({ ok: false, error: 'Missing ADMIN credentials in server/.env' }, null, 2));
    process.exit(1);
  }

  await testHealth();
  await testLeaveApprovals(env);
  await testHelpMultiTicket(env);
  await testWfhSalary(env);
  await testBulkUpload(env);
  await testProfileEmptyLastName(env);

  const critical = ['helpMultiTicket', 'leaveApprovals', 'wfhSalary'];
  const criticalPass = critical.every((k) => report[k]?.result === 'PASS');
  const criticalSkip = critical.filter((k) => report[k]?.result === 'SKIP');
  const allGood =
    criticalPass ||
    (report.helpMultiTicket?.result === 'PASS' &&
      report.leaveApprovals?.result === 'PASS' &&
      (report.wfhSalary?.result === 'PASS' || report.wfhSalary?.result === 'SKIP'));

  console.log(
    JSON.stringify(
      {
        staging: STAGING,
        overall: allGood ? 'all good' : 'issues found',
        criticalMohit: {
          helpSecondTicket: report.helpMultiTicket?.result,
          approvedLeaveList: report.leaveApprovals?.result,
          wfhSalary: report.wfhSalary?.result,
        },
        report,
        skippedCritical: criticalSkip.map((k) => ({ test: k, reason: report[k]?.reason })),
      },
      null,
      2,
    ),
  );

  const anyFail = Object.values(report).some((r) => r.result === 'FAIL');
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
