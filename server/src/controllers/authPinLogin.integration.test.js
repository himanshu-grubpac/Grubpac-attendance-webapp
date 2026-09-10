import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
// Register referenced schemas for USER_POPULATE_FIELDS (roleId, departmentId).
import '../models/Role.js';
import '../models/Department.js';
import { loginUser } from './authController.js';

const PASSWORD = 'Strong@123';
const PIN = '2468';
const WRONG_PIN = '1357';

let memoryServer;
let passwordHash;
let pinHash;
let sequence = 0;

function assertInvalidCredentials(error) {
  assert.equal(error?.statusCode, 401);
  assert.match(error?.message ?? '', /Invalid credentials/);
  return true;
}

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
  passwordHash = await bcrypt.hash(PASSWORD, 12);
  pinHash = await bcrypt.hash(PIN, 12);
});

beforeEach(async () => {
  await User.deleteMany({});
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createEmployee({ withPin = true } = {}) {
  sequence += 1;
  return User.create({
    firstName: 'Pin',
    lastName: `User${sequence}`,
    name: `Pin User${sequence}`,
    email: `pin.user.${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `PIN${String(sequence).padStart(7, '0')}`,
    passwordHash,
    ...(withPin ? { pin4Hash: pinHash } : {}),
    role: 'employee',
    isActive: true,
  });
}

test('PIN login succeeds with the correct 4-digit PIN', async () => {
  const user = await createEmployee();

  const result = await loginUser(
    { identifier: user.email, password: PIN },
    'employee',
  );

  assert.ok(result.token);
  assert.ok(result.csrfToken);
  assert.equal(result.user.loginPortal, 'employee');
  assert.equal(result.user.email, user.email);

  const reloaded = await User.findById(user._id);
  assert.ok(reloaded.lastLoginAt instanceof Date);
});

test('PIN login works via employee code identifier', async () => {
  const user = await createEmployee();

  const result = await loginUser(
    { identifier: user.employeeCode, password: PIN },
    'employee',
  );

  assert.ok(result.token);
  assert.equal(result.user.loginPortal, 'employee');
});

test('PIN login rejects a wrong 4-digit PIN', async () => {
  const user = await createEmployee();

  await assert.rejects(
    loginUser({ identifier: user.email, password: WRONG_PIN }, 'employee'),
    assertInvalidCredentials,
  );
});

test('a 4-digit secret falls through to the password when no PIN is set', async () => {
  const user = await createEmployee({ withPin: false });

  await assert.rejects(
    loginUser({ identifier: user.email, password: PIN }, 'employee'),
    assertInvalidCredentials,
  );
});

test('password login still works when a PIN is set', async () => {
  const user = await createEmployee();

  const result = await loginUser(
    { identifier: user.email, password: PASSWORD },
    'employee',
  );

  assert.ok(result.token);
  assert.equal(result.user.loginPortal, 'employee');
});

test('PIN login rejects an inactive account', async () => {
  const user = await createEmployee();
  await User.findByIdAndUpdate(user._id, { isActive: false });

  await assert.rejects(
    loginUser({ identifier: user.email, password: PIN }, 'employee'),
    assertInvalidCredentials,
  );
});
