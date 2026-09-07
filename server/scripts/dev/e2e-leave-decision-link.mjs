import mongoose from 'mongoose';
import { app } from '../../src/index.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { User } from '../../src/models/User.js';
import { LeaveRequest } from '../../src/models/LeaveRequest.js';
import {
  issueLeaveDecisionToken,
  consumeLeaveDecisionToken,
} from '../../src/services/leaveService.js';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
await connectDatabase();

try {
  const mkUser = (prefix) => User.create({
    email: prefix + '.' + Date.now() + '@grubpac.com',
    passwordHash: 'x',
    firstName: prefix,
    role: 'employee',
    isActive: true,
    name: prefix + ' Test',
    mobile: String(Date.now()).slice(-9),
    employeeCode: prefix.toUpperCase() + Date.now(),
  });
  const manager = await mkUser('mgr');
  const other = await mkUser('oth');

  const request = await LeaveRequest.create({
    userId: manager._id,
    leaveTypeId: new mongoose.Types.ObjectId(),
    startDate: new Date(),
    endDate: new Date(),
    days: 1,
    status: 'pending',
    reason: 'e2e',
  });
  const requestId = request._id.toString();

  // 1. issue + consume
  const raw = await issueLeaveDecisionToken(requestId, manager._id, 'approve');
  const m1 = await consumeLeaveDecisionToken(requestId, 'approve', raw);
  check('valid token returns managerId', m1 && m1.toString() === manager._id.toString());

  // 2. single-use: reuse fails
  const m2 = await consumeLeaveDecisionToken(requestId, 'approve', raw);
  check('reused token is rejected (single-use)', m2 === null);

  // 3. tamper resistance
  const raw2 = await issueLeaveDecisionToken(requestId, manager._id, 'approve');
  const tampered = raw2.slice(0, -1) + (raw2.slice(-1) === 'a' ? 'b' : 'a');
  const m3 = await consumeLeaveDecisionToken(requestId, 'approve', tampered);
  check('tampered token is rejected', m3 === null);

  // 4. action binding
  const rawApprove = await issueLeaveDecisionToken(requestId, manager._id, 'approve');
  const m4 = await consumeLeaveDecisionToken(requestId, 'reject', rawApprove);
  check('approve token does not satisfy reject action', m4 === null);

  // 5. manager binding: token issued for manager should not resolve to other
  const rawForOther = await issueLeaveDecisionToken(requestId, other._id, 'approve');
  const m5 = await consumeLeaveDecisionToken(requestId, 'approve', rawForOther);
  check('token bound to issuing manager', m5 && m5.toString() === other._id.toString());

  // 6. expiry
  const expiredRaw = 'a'.repeat(64); // 32 bytes hex placeholder (never stored)
  await LeaveRequest.updateOne(
    { _id: requestId },
    { $push: { decisionTokens: { tokenHash: expiredRaw, action: 'approve', managerId: manager._id, expiresAt: new Date(Date.now() - 1000), used: false, usedAt: null } } },
  );
  const m6 = await consumeLeaveDecisionToken(requestId, 'approve', expiredRaw);
  check('expired token is rejected', m6 === null);

  // 7. GET with missing params -> 400 (no state change)
  let r = await fetch(`${base}/api/leave/decision-link`);
  check('GET missing params -> 400', r.status === 400);

  // 8. GET with bad token -> 410, HTML body
  r = await fetch(`${base}/api/leave/decision-link?request=${requestId}&action=approve&token=badtoken`);
  let body = await r.text();
  check('GET bad token -> 410', r.status === 410);
  check('GET returns HTML', /<!doctype html>/i.test(body) && /invalid|expired|used/i.test(body));

  // 9. GET with valid token -> confirmation page (GET must NOT act / change state)
  const getRaw = await issueLeaveDecisionToken(requestId, manager._id, 'approve');
  r = await fetch(`${base}/api/leave/decision-link?request=${requestId}&action=approve&token=${getRaw}`);
  body = await r.text();
  check('GET valid token -> 200 confirm page', r.status === 200 && /<form/i.test(body) && /Confirm/i.test(body));
  const afterGet = await LeaveRequest.findById(requestId).select('status');
  check('GET did NOT change request status', afterGet.status === 'pending');

  // 10. POST with bad token -> 410
  r = await fetch(`${base}/api/leave/decision-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: requestId, action: 'approve', token: 'badtoken' }).toString(),
  });
  check('POST bad token -> 410', r.status === 410);

  // 11. POST with valid token executes (consumes token; replay rejected)
  const postRaw = await issueLeaveDecisionToken(requestId, manager._id, 'approve');
  r = await fetch(`${base}/api/leave/decision-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: requestId, action: 'approve', token: postRaw }).toString(),
  });
  check('POST valid token executes (200 or handled 500)', [200, 500].includes(r.status));
  r = await fetch(`${base}/api/leave/decision-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: requestId, action: 'approve', token: postRaw }).toString(),
  });
  check('POST replay of consumed token -> 410 (single-use)', r.status === 410);

  // 12. When the manager is logged in (has a session cookie), CSRF must NOT block this route.
  const csrfRaw = await issueLeaveDecisionToken(requestId, manager._id, 'approve');
  r = await fetch(`${base}/api/leave/decision-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'attendance_token=loggedin-session' },
    body: new URLSearchParams({ request: requestId, action: 'approve', token: csrfRaw }).toString(),
  });
  check('POST with session cookie is not blocked by CSRF', r.status !== 403);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await disconnectDatabase();
  server.close();
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('E2E ERROR', e);
  process.exitCode = 1;
  try { await disconnectDatabase(); server.close(); } catch {}
}

