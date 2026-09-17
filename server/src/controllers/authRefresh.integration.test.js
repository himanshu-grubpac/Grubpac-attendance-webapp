import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
// Register referenced schemas for USER_POPULATE_FIELDS (roleId, departmentId).
import '../models/Role.js';
import '../models/Department.js';
import { refreshSession } from './authController.js';
import { env } from '../config/env.js';

const PASSWORD = 'Strong@123';

let memoryServer;
let passwordHash;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
  passwordHash = await bcrypt.hash(PASSWORD, 12);
});

beforeEach(async () => {
  await User.deleteMany({});
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createEmployee() {
  sequence += 1;
  return User.create({
    firstName: 'Refresh',
    lastName: `User${sequence}`,
    name: `Refresh User${sequence}`,
    email: `refresh.user.${sequence}@test.example`,
    mobile: `8${String(sequence).padStart(9, '0')}`,
    employeeCode: `RFSH${String(sequence).padStart(7, '0')}`,
    passwordHash,
    role: 'employee',
    isActive: true,
  });
}

test('refreshSession re-issues a token and preserves the CSRF value', async () => {
  const user = await createEmployee();

  const result = await refreshSession(user._id, 'csrf-from-cookie');

  assert.ok(result.token);
  // Same CSRF value so other open tabs keep passing double-submit checks.
  assert.equal(result.csrfToken, 'csrf-from-cookie');
  const payload = jwt.verify(result.token, env.jwtSecret);
  assert.equal(payload.sub, user._id.toString());
  // Sliding window: expiry ≈ now + cookie lifetime.
  assert.ok(
    Math.abs(result.expiresAt - (Date.now() + env.jwtCookieMaxAgeMs)) < 5000,
    `expiresAt ${result.expiresAt} should be ~now+maxAge`,
  );
});

test('refreshSession mints a CSRF token when the client sent none', async () => {
  const user = await createEmployee();

  const result = await refreshSession(user._id, null);

  assert.ok(result.token);
  assert.equal(typeof result.csrfToken, 'string');
  assert.ok(result.csrfToken.length >= 32);
});

test('refreshSession rejects inactive users with 401', async () => {
  const user = await createEmployee();
  await User.findByIdAndUpdate(user._id, { isActive: false });

  await assert.rejects(
    refreshSession(user._id, 'csrf-from-cookie'),
    (error) => error?.statusCode === 401,
  );
});

test('refreshSession rejects unknown users with 401', async () => {
  await assert.rejects(
    refreshSession(new mongoose.Types.ObjectId(), 'csrf-from-cookie'),
    (error) => error?.statusCode === 401,
  );
});
