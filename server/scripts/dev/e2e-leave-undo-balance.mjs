/**
 * E2E: Leave undo balance correctness.
 *
 * Tests that undoing approve/reject decisions correctly restores leave balances.
 * Uses server/.env credentials; hits local API (default http://localhost:5000).
 *
 * Scenarios covered:
 *  1. Approve → Undo: used decreases, pending restored
 *  2. Reject → Undo: pending restored (no used change)
 *  3. Multiple approve/undo cycles: balance stays consistent
 *  4. Undo clears notification state
 *  5. Auto-approved (SL) → Undo: used decreases correctly
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE || 'http://localhost:5000';
const DEVICE_ID = 'leave-undo-balance-e2e-0000-4000-8000-000000000001';

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

async function req(method, path, { body, headers = {} } = {}) {
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
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 500) };
}

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function assertEq(actual, expected, label) {
  const pass = actual === expected;
  check(label, pass, pass ? '' : `expected ${expected}, got ${actual}`);
  return pass;
}

function assertGte(actual, min, label) {
  const pass = actual >= min;
  check(label, pass, pass ? '' : `expected >= ${min}, got ${actual}`);
  return pass;
}

async function main() {
  const env = loadEnv();

  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.log('ERROR: Missing ADMIN credentials in server/.env');
    process.exit(1);
  }

  console.log('Connecting to', BASE);
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) {
    console.log('ERROR: Server not reachable');
    process.exit(1);
  }

  // ── Login as admin ──
  const login = await req('POST', '/api/auth/admin/login', {
    body: { identifier: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, deviceId: DEVICE_ID },
  });
  if (login.json?.csrfToken) csrfToken = login.json.csrfToken;
  assertEq(login.status, 200, 'Admin login succeeds');
  const adminUserId = login.json?.user?.id;
  check('Admin user ID resolved', !!adminUserId);

  // ── Discover leave types (API returns { types: [...] }) ──
  const typesRes = await req('GET', '/api/leave/types');
  assertEq(typesRes.status, 200, 'List leave types');
  const leaveTypes = typesRes.json?.types ?? [];
  const clType = leaveTypes.find((t) => t.code === 'CL');
  const slType = leaveTypes.find((t) => t.code === 'SL');
  if (!clType) {
    console.log('ERROR: CL leave type not found. Available:', leaveTypes.map((t) => t.code).join(', '));
    process.exit(1);
  }
  check('CL leave type found', true);
  check('SL leave type found', !!slType);

  const clTypeId = clType.id;
  const slTypeId = slType?.id;

  // ── Use /api/leave/balances/me to get own balances ──
  async function getBalance(code) {
    const res = await req('GET', '/api/leave/balances/me');
    const balances = res.json?.balances ?? [];
    const entry = balances.find((b) => b.leaveTypeCode === code);
    return entry
      ? { entitled: entry.entitled ?? 0, used: entry.used ?? 0, pending: entry.pending ?? 0, carried: entry.carried ?? 0, encashed: entry.encashed ?? 0 }
      : { entitled: 0, used: 0, pending: 0, carried: 0, encashed: 0 };
  }

  // Keep dates within current year and avoid collisions with prior test data
  let dateCounter = 65;
  function nextDate() {
    const d = new Date();
    d.setDate(d.getDate() + dateCounter);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    dateCounter += 5;
    return d.toISOString().split('T')[0];
  }

  // ── Helper: create leave request ──
  async function createLeave(leaveTypeId) {
    const dateStr = nextDate();
    return req('POST', '/api/leave/requests', {
      body: { leaveTypeId, startDate: dateStr, endDate: dateStr, reason: 'e2e balance test' },
    });
  }

  // ── Helper: approve / reject / undo / cancel ──
  async function approveLeave(requestId) {
    return req('POST', `/api/leave/requests/${requestId}/approve`, { body: { comment: 'e2e approve' } });
  }
  async function rejectLeave(requestId) {
    return req('POST', `/api/leave/requests/${requestId}/reject`, { body: { comment: 'e2e reject' } });
  }
  async function undoLeave(requestId) {
    return req('POST', `/api/leave/requests/${requestId}/undo`, {});
  }
  async function cancelLeave(requestId) {
    return req('POST', `/api/leave/requests/${requestId}/cancel`, {});
  }
  async function cancelApprovedLeave(requestId) {
    return req('POST', `/api/leave/requests/${requestId}/cancel-approval`, { body: { comment: 'e2e cancel approved' } });
  }
  async function undoCancellation(requestId) {
    return req('POST', `/api/leave/requests/${requestId}/undo-cancel`, {});
  }
  async function fetchRequest(requestId) {
    return req('GET', `/api/leave/requests/${requestId}`);
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n═══ Scenario 1: Approve → Undo (deferred) ═══');
  // ═══════════════════════════════════════════════════════════
  {
    const before = await getBalance('CL');
    const createRes = await createLeave(clTypeId);
    const requestId = createRes.json?.request?.id;
    check('Create CL leave request', createRes.status === 201 && !!requestId, `status=${createRes.status} err=${createRes.json?.message ?? ''}`);
    if (requestId) {
      const afterCreate = await getBalance('CL');
      assertEq(afterCreate.pending, before.pending + 1, 'Pending incremented after create');
      assertEq(afterCreate.used, before.used, 'Used unchanged after create');

      const approveRes = await approveLeave(requestId);
      check('Approve leave (deferred)', approveRes.status === 200, `status=${approveRes.status}`);
      const afterApprove = await getBalance('CL');
      assertEq(afterApprove.pending, before.pending + 1, 'Pending unchanged after deferred approve');
      assertEq(afterApprove.used, before.used, 'Used unchanged after deferred approve');

      const reqAfterApprove = await req('GET', `/api/leave/requests/${requestId}`);
      const approveData = reqAfterApprove.json?.request;
      assertEq(approveData?.status, 'pending', 'Status stays pending during undo window');
      assertEq(approveData?.pendingDecision, 'approved', 'pendingDecision set to approved');
      check('notifyAfter set', !!approveData?.decisionUndoExpiresAt, `decisionUndoExpiresAt=${approveData?.decisionUndoExpiresAt}`);

      const undoRes = await undoLeave(requestId);
      check('Undo approval', undoRes.status === 200, `status=${undoRes.status}`);
      const afterUndo = await getBalance('CL');
      assertEq(afterUndo.pending, before.pending + 1, 'Pending unchanged after undo (still pending)');
      assertEq(afterUndo.used, before.used, 'Used unchanged after undo');

      const reqAfterUndo = await req('GET', `/api/leave/requests/${requestId}`);
      const undoData = reqAfterUndo.json?.request;
      assertEq(undoData?.status, 'pending', 'Status still pending after undo');
      check('pendingDecision cleared', !undoData?.pendingDecision, `pendingDecision=${undoData?.pendingDecision}`);
      check('notifyAfter cleared', !undoData?.notifyAfter, `notifyAfter=${undoData?.notifyAfter}`);

      await cancelLeave(requestId);
    }
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n═══ Scenario 2: Reject → Undo (deferred) ═══');
  // ═══════════════════════════════════════════════════════════
  {
    const before = await getBalance('CL');
    const createRes = await createLeave(clTypeId);
    const requestId = createRes.json?.request?.id;
    check('Create CL leave request', createRes.status === 201 && !!requestId, `status=${createRes.status} err=${createRes.json?.message ?? ''}`);
    if (requestId) {
      const afterCreate = await getBalance('CL');
      assertEq(afterCreate.pending, before.pending + 1, 'Pending incremented after create');

      const rejectRes = await rejectLeave(requestId);
      check('Reject leave (deferred)', rejectRes.status === 200, `status=${rejectRes.status}`);
      const afterReject = await getBalance('CL');
      assertEq(afterReject.pending, before.pending + 1, 'Pending unchanged after deferred reject');
      assertEq(afterReject.used, before.used, 'Used unchanged after deferred reject');

      const reqAfterReject = await req('GET', `/api/leave/requests/${requestId}`);
      const rejectData = reqAfterReject.json?.request;
      assertEq(rejectData?.status, 'pending', 'Status stays pending during undo window');
      assertEq(rejectData?.pendingDecision, 'rejected', 'pendingDecision set to rejected');

      const undoRes = await undoLeave(requestId);
      check('Undo rejection', undoRes.status === 200, `status=${undoRes.status}`);
      const afterUndo = await getBalance('CL');
      assertEq(afterUndo.pending, before.pending + 1, 'Pending unchanged after undo (still pending)');
      assertEq(afterUndo.used, before.used, 'Used unchanged after undo reject');

      const reqAfterUndo = await req('GET', `/api/leave/requests/${requestId}`);
      const undoData = reqAfterUndo.json?.request;
      assertEq(undoData?.status, 'pending', 'Status still pending after undo');
      check('pendingDecision cleared after undo', !undoData?.pendingDecision, `pendingDecision=${undoData?.pendingDecision}`);

      await cancelLeave(requestId);
    }
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n═══ Scenario 3: Multiple approve/undo cycles ═══');
  // ═══════════════════════════════════════════════════════════
  {
    const before = await getBalance('CL');
    const createRes = await createLeave(clTypeId);
    const requestId = createRes.json?.request?.id;
    check('Create CL leave request', createRes.status === 201 && !!requestId, `status=${createRes.status} err=${createRes.json?.message ?? ''}`);
    if (requestId) {
      // Cycle 1: approve → undo
      await approveLeave(requestId);
      const mid1 = await getBalance('CL');
      assertEq(mid1.pending, before.pending + 1, 'Pending unchanged during deferred approve (cycle 1)');
      assertEq(mid1.used, before.used, 'Used unchanged during deferred approve (cycle 1)');
      await undoLeave(requestId);
      const mid2 = await getBalance('CL');
      assertEq(mid2.pending, before.pending + 1, 'Pending correct after cycle 1');
      assertEq(mid2.used, before.used, 'Used correct after cycle 1');

      // Cycle 2: approve → undo
      await approveLeave(requestId);
      await undoLeave(requestId);
      const after = await getBalance('CL');
      assertEq(after.pending, before.pending + 1, 'Pending correct after cycle 2');
      assertEq(after.used, before.used, 'Used correct after cycle 2');

      await cancelLeave(requestId);
    }
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n═══ Scenario 4: Undo clears notification state ═══');
  // ═══════════════════════════════════════════════════════════
  {
    const createRes = await createLeave(clTypeId);
    const requestId = createRes.json?.request?.id;
    check('Create CL leave request', createRes.status === 201 && !!requestId, `status=${createRes.status} err=${createRes.json?.message ?? ''}`);
    if (requestId) {
      await approveLeave(requestId);
      const reqAfterApprove = await req('GET', `/api/leave/requests/${requestId}`);
      const approveData = reqAfterApprove.json?.request;
      check('Status stays pending (deferred)', approveData?.status === 'pending');
      check('pendingDecision set to approved', approveData?.pendingDecision === 'approved');
      check('decidedAt is set', !!approveData?.decidedAt);
      check('decisionUndoExpiresAt is set', !!approveData?.decisionUndoExpiresAt);

      await undoLeave(requestId);
      const reqAfterUndo = await req('GET', `/api/leave/requests/${requestId}`);
      const afterUndo = reqAfterUndo.json?.request;
      check('Request still pending after undo', afterUndo?.status === 'pending');
      check('pendingDecision cleared', !afterUndo?.pendingDecision);
      assertEq((afterUndo?.decisionTokens ?? []).length, 0, 'Decision tokens cleared');
      check('decidedAt cleared', !afterUndo?.decidedAt);
      check('decisionUndoExpiresAt cleared', !afterUndo?.decisionUndoExpiresAt);

      await cancelLeave(requestId);
    }
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n═══ Scenario 5: Auto-approved (SL) → immediate flow ═══');
  // ═══════════════════════════════════════════════════════════
  if (slTypeId) {
    const before = await getBalance('SL');
    const createRes = await createLeave(slTypeId);
    const requestId = createRes.json?.request?.id;
    const requestStatus = createRes.json?.request?.status;
    check('Create SL (auto-approved) request', createRes.status === 201 && !!requestId, `status=${createRes.status} err=${createRes.json?.message ?? ''}`);
    if (requestId) {
      check('SL request auto-approved', requestStatus === 'approved', `status=${requestStatus}`);
      if (requestStatus === 'approved') {
        const afterCreate = await getBalance('SL');
        assertEq(afterCreate.used, before.used + 1, 'Used incremented after auto-approve');
        assertEq(afterCreate.pending, before.pending, 'Pending unchanged after auto-approve');

        const undoRes = await undoLeave(requestId);
        check('Undo auto-approved SL fails (no pendingDecision)', undoRes.status === 400, `status=${undoRes.status}`);

        const afterFailedUndo = await getBalance('SL');
        assertEq(afterFailedUndo.used, before.used + 1, 'Used unchanged after failed undo');
        assertEq(afterFailedUndo.pending, before.pending, 'Pending unchanged after failed undo');
      }
      await cancelLeave(requestId);
    }
  } else {
    console.log('  SKIP  SL leave type not found');
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n═══ Scenario 6: Admin cancel approved leave → Undo ═══');
  // ═══════════════════════════════════════════════════════════
  {
    dateCounter = 1200; // avoid date collisions with earlier scenarios / prior runs
    const before = await getBalance('CL');
    const createRes = await createLeave(clTypeId);
    const requestId = createRes.json?.request?.id;
    check('Create CL leave request', createRes.status === 201 && !!requestId, `status=${createRes.status} err=${createRes.json?.message ?? ''}`);
    if (requestId) {
      const approveRes = await approveLeave(requestId);
      check('Approve leave (deferred)', approveRes.status === 200, `status=${approveRes.status}`);

      // Finalize approval (job runs every 30s, poll up to 40s)
      let reqRes;
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setTimeout(r, 5_000));
        reqRes = await fetchRequest(requestId);
        if (reqRes.json?.request?.status === 'approved') break;
      }
      check('Approval finalized', reqRes.json?.request?.status === 'approved', `status=${reqRes.json?.request?.status}`);
      const originalDecidedAt = reqRes.json?.request?.decidedAt;

      const baseline = await getBalance('CL');
      assertGte(baseline.used, 1, 'Used at least 1 after finalized approve');

      // Admin cancels approved leave (deferred)
      const cancelRes = await cancelApprovedLeave(requestId);
      check('Cancel approved leave (deferred)', cancelRes.status === 200, `status=${cancelRes.status}`);
      reqRes = await fetchRequest(requestId);
      assertEq(reqRes.json?.request?.status, 'approved', 'Status stays approved during deferred cancel');
      assertEq(reqRes.json?.request?.pendingDecision, 'cancelled', 'pendingDecision set to cancelled');
      assertEq(reqRes.json?.request?.decidedAt, originalDecidedAt, 'Original decidedAt preserved during deferred cancel');

      const afterCancel = await getBalance('CL');
      assertEq(afterCancel.used, baseline.used, 'Used unchanged during deferred cancel');

      // Undo cancellation
      const undoRes = await undoCancellation(requestId);
      check('Undo cancellation', undoRes.status === 200, `status=${undoRes.status}`);
      reqRes = await fetchRequest(requestId);
      assertEq(reqRes.json?.request?.status, 'approved', 'Status restored to approved after undo');
      check('pendingDecision cleared after undo', !reqRes.json?.request?.pendingDecision, `pd=${reqRes.json?.request?.pendingDecision}`);
      assertEq(reqRes.json?.request?.decidedAt, originalDecidedAt, 'Original decidedAt restored after undo');

      const afterUndo = await getBalance('CL');
      assertEq(afterUndo.used, baseline.used, 'Used unchanged after undo of cancel');

      // Let cancellation finalize to clean up
      await new Promise((r) => setTimeout(r, 1_000));
      await cancelApprovedLeave(requestId);
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setTimeout(r, 5_000));
        const cleanupRes = await fetchRequest(requestId);
        if (cleanupRes.json?.request?.status === 'cancelled') break;
      }
    }
  }

  // ── Summary ──
  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
  process.exitCode = failed === 0 ? 0 : 1;
}

try {
  await main();
} catch (e) {
  console.error('E2E ERROR', e);
  process.exitCode = 1;
}
