import { app } from '../src/index.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { User } from '../src/models/User.js';
import { env } from '../src/config/env.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Defaults so the suite runs with `node scripts/e2e-password-reset.mjs` directly.
// Force SMTP off so the suite never makes a real network call to a mail provider.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.USE_MEMORY_DB = process.env.USE_MEMORY_DB || 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.SMTP_HOST = '';

const BASE = 'http://127.0.0.1';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function jsonFetch(url, body, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

async function main() {
  await connectDatabase();
  const server = app.listen(0);
  const port = server.address().port;
  const api = `${BASE}:${port}/api`;

  // Seed test users
  const empEmail = `e2e.employee.${Date.now()}@grubpac.com`;
  const adminEmail = `e2e.admin.${Date.now()}@grubpac.com`;
  const oldPassword = 'OldPass@123';
  const newPassword = 'NewPass@456';
  const passwordHash = await bcrypt.hash(oldPassword, 12);

  const employee = await User.create({
    role: 'employee',
    firstName: 'E2E',
    lastName: 'Employee',
    name: 'E2E Employee',
    email: empEmail,
    mobile: `98${String(Date.now()).slice(-8)}`,
    passwordHash,
    isActive: true,
  });
  const admin = await User.create({
    role: 'admin',
    firstName: 'E2E',
    lastName: 'Admin',
    name: 'E2E Admin',
    email: adminEmail,
    mobile: `97${String(Date.now()).slice(-8)}`,
    passwordHash,
    isActive: true,
  });

  // 1. Forgot password — employee gets a dev link (non-prod), generic message
  const forgotEmp = await jsonFetch(`${api}/auth/forgot-password`, { email: empEmail });
  check('forgot-password (employee) returns 200', forgotEmp.status === 200, forgotEmp.status);
  check('forgot-password (employee) generic message', /account exists/i.test(forgotEmp.data?.message ?? ''));
  check('forgot-password (employee) returns devResetLink in non-prod', typeof forgotEmp.data?.devResetLink === 'string');

  // 2. Forgot password — admin does NOT get a link (employees only)
  const forgotAdmin = await jsonFetch(`${api}/auth/forgot-password`, { email: adminEmail });
  check('forgot-password (admin) returns 200', forgotAdmin.status === 200, forgotAdmin.status);
  check('forgot-password (admin) returns NO devResetLink', !('devResetLink' in (forgotAdmin.data ?? {})));

  // 3. Forgot password — unknown email returns generic, no link (enumeration safe)
  const forgotUnknown = await jsonFetch(`${api}/auth/forgot-password`, { email: 'nobody@nowhere.com' });
  check('forgot-password (unknown) returns 200', forgotUnknown.status === 200, forgotUnknown.status);
  check('forgot-password (unknown) returns NO devResetLink', !('devResetLink' in (forgotUnknown.data ?? {})));

  // 4. Forgot password — invalid email format -> 400
  const forgotBad = await jsonFetch(`${api}/auth/forgot-password`, { email: 'not-an-email' });
  check('forgot-password (bad email) returns 400', forgotBad.status === 400, forgotBad.status);

  // Extract token from devResetLink
  const token = new URL(forgotEmp.data.devResetLink).searchParams.get('token');
  check('reset token parsed from dev link', Boolean(token));

  // 5. Verify token — valid
  const verifyValid = await jsonFetch(`${api}/auth/reset-password/verify`, { token });
  check('verify (valid token) returns valid:true', verifyValid.data?.valid === true, JSON.stringify(verifyValid.data));

  // 6. Verify token — garbage
  const verifyGarbage = await jsonFetch(`${api}/auth/reset-password/verify`, { token: 'garbage.token.value' });
  check('verify (garbage) returns valid:false', verifyGarbage.data?.valid === false && verifyGarbage.status === 200);

  // 7. Reset — mismatched passwords -> 400
  const resetMismatch = await jsonFetch(`${api}/auth/reset-password`, {
    token,
    newPassword,
    confirmPassword: 'Different@789',
  });
  check('reset (mismatch) returns 400', resetMismatch.status === 400, resetMismatch.status);

  // 8. Reset — weak password -> 400
  const resetWeak = await jsonFetch(`${api}/auth/reset-password`, {
    token,
    newPassword: 'weak',
    confirmPassword: 'weak',
  });
  check('reset (weak password) returns 400', resetWeak.status === 400, resetWeak.status);

  // 9. Reset — same as current (old) password -> 400
  const resetSame = await jsonFetch(`${api}/auth/reset-password`, {
    token,
    newPassword: oldPassword,
    confirmPassword: oldPassword,
  });
  check('reset (same as old) returns 400', resetSame.status === 400, resetSame.status);

  // 10. Reset — success
  const resetOk = await jsonFetch(`${api}/auth/reset-password`, {
    token,
    newPassword,
    confirmPassword: newPassword,
  });
  check('reset (valid) returns 200', resetOk.status === 200, resetOk.status);
  check('reset (valid) returns success message', /reset/i.test(resetOk.data?.message ?? ''));

  // 11. Token is single-use — reuse fails with 410
  const resetReuse = await jsonFetch(`${api}/auth/reset-password`, {
    token,
    newPassword,
    confirmPassword: newPassword,
  });
  check('reset (reused token) returns 410', resetReuse.status === 410, resetReuse.status);

  // 12. Employee can now log in with the new password
  const loginNew = await jsonFetch(`${api}/auth/user/login`, {
    identifier: empEmail,
    password: newPassword,
  });
  check('login with new password succeeds', loginNew.status === 200 && Boolean(loginNew.data?.user), loginNew.status);

  // 13. Employee cannot log in with the old password anymore
  const loginOld = await jsonFetch(`${api}/auth/user/login`, {
    identifier: empEmail,
    password: oldPassword,
  });
  check('login with old password fails', loginOld.status === 401, loginOld.status);

  // 14. Expired token -> verify returns reason expired, reset returns 410
  const expiredToken = jwt.sign(
    { sub: employee._id.toString(), role: 'employee', tv: 0, purpose: 'password-reset' },
    env.jwtSecret,
    { expiresIn: '-10s' },
  );
  const verifyExpired = await jsonFetch(`${api}/auth/reset-password/verify`, { token: expiredToken });
  check('verify (expired) reason=expired', verifyExpired.data?.valid === false && verifyExpired.data?.reason === 'expired');
  const resetExpired = await jsonFetch(`${api}/auth/reset-password`, {
    token: expiredToken,
    newPassword,
    confirmPassword: newPassword,
  });
  check('reset (expired) returns 410', resetExpired.status === 410, resetExpired.status);

  // 15. Wrong-purpose token rejected
  const wrongPurpose = jwt.sign(
    { sub: employee._id.toString(), role: 'employee', tv: 0, purpose: 'something-else' },
    env.jwtSecret,
    { expiresIn: '10m' },
  );
  const verifyWrong = await jsonFetch(`${api}/auth/reset-password/verify`, { token: wrongPurpose });
  check('verify (wrong purpose) returns valid:false', verifyWrong.data?.valid === false);

  // 16. Inactive employee does not get a reset link
  const inactive = await User.create({
    role: 'employee',
    firstName: 'Inactive',
    lastName: 'Emp',
    name: 'Inactive Emp',
    email: `e2e.inactive.${Date.now()}@grubpac.com`,
    mobile: `96${String(Date.now()).slice(-8)}`,
    passwordHash,
    isActive: false,
  });
  const forgotInactive = await jsonFetch(`${api}/auth/forgot-password`, { email: inactive.email });
  check('forgot-password (inactive employee) returns NO devResetLink', !('devResetLink' in (forgotInactive.data ?? {})));

  // Cleanup
  await User.deleteMany({
    _id: { $in: [employee._id, admin._id, inactive._id] },
  });
  await disconnectDatabase();
  server.close();

  console.log(`\nE2E password-reset: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E harness error:', err);
  process.exit(1);
});
