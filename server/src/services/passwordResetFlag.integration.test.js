process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { previewFirstLoginFlags, clearAllFirstLoginFlags } from '../migrateFirstLoginFlags.js';
import { resetEmployeePassword } from '../controllers/adminController.js';
import { resetPassword } from '../controllers/passwordResetController.js';
import { changePassword } from '../controllers/authController.js';
import { createPasswordResetToken } from '../utils/passwordReset.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  sequence += 1;
  await User.deleteMany({});
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createEmployee() {
  sequence += 1;
  return User.create({
    firstName: 'Flag',
    lastName: `User${sequence}`,
    name: `Flag User${sequence}`,
    email: `flag-user-${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `F${String(sequence).padStart(8, '0')}`,
    passwordHash: await bcrypt.hash('Original@123', 12),
    role: 'employee',
    isActive: true,
    // A settled account: no forced change pending.
    mustChangePassword: false,
    forcePasswordChange: false,
  });
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function freshFlags(userId) {
  const doc = await User.findById(userId).lean();
  return { must: doc.mustChangePassword, force: doc.forcePasswordChange };
}

test('admin reset on an existing account does not force a password change', async () => {
  const admin = await createEmployee();
  const employee = await createEmployee();

  const res = mockRes();
  await resetEmployeePassword(
    {
      params: { id: employee._id.toString() },
      body: { newPassword: 'BrandNew@123', confirmPassword: 'BrandNew@123' },
      user: { _id: admin._id },
      userPermissions: [],
      ip: '127.0.0.1',
      headers: {},
    },
    res,
  );
  assert.equal(res.statusCode, 200);

  const flags = await freshFlags(employee._id);
  assert.equal(flags.must, false, 'mustChangePassword stays false');
  assert.equal(flags.force, false, 'forcePasswordChange stays false');
});

test('forgot-password completion on an existing account does not force a change', async () => {
  const employee = await createEmployee();
  const token = createPasswordResetToken(employee);

  await resetPassword({ token, newPassword: 'SelfChosen@123', confirmPassword: 'SelfChosen@123' });

  const flags = await freshFlags(employee._id);
  assert.equal(flags.must, false, 'mustChangePassword stays false');
  assert.equal(flags.force, false, 'forcePasswordChange stays false');
});

test('schema default no longer gates accounts', async () => {
  sequence += 1;
  const fresh = await User.create({
    firstName: 'Brand',
    lastName: 'New',
    name: 'Brand New',
    email: `brand-new-${sequence}@test.example`,
    mobile: `9${String(sequence).padStart(9, '0')}`,
    employeeCode: `B${String(sequence).padStart(8, '0')}`,
    passwordHash: await bcrypt.hash('Temp@123', 12),
    role: 'employee',
    isActive: true,
  });
  assert.equal(fresh.forcePasswordChange, false, 'default is ungated');
  assert.equal(
    fresh.toSafeJSON().mustChangePassword,
    false,
    'login and /me agree through the unified flag',
  );
});

test('legacy accounts missing both flag fields read ungated', async () => {
  sequence += 1;
  const email = `legacy-${sequence}@test.example`;
  // Raw insert bypasses Mongoose defaults — the pre-feature document shape.
  await User.collection.insertOne({
    firstName: 'Legacy',
    lastName: 'User',
    name: 'Legacy User',
    email,
    mobile: `8${String(sequence).padStart(9, '0')}`,
    employeeCode: `L${String(sequence).padStart(8, '0')}`,
    passwordHash: await bcrypt.hash('Old@123', 12),
    role: 'employee',
    isActive: true,
  });
  const reloaded = await User.findOne({ email });
  assert.equal(
    reloaded.toSafeJSON().mustChangePassword,
    false,
    'pre-feature accounts never gate',
  );
});

test('migration preview counts and clear-all ungates every account', async () => {
  const flagged = await createEmployee();
  await User.updateOne(
    { _id: flagged._id },
    { $set: { mustChangePassword: true, forcePasswordChange: true } },
  );
  await createEmployee();

  const preview = await previewFirstLoginFlags();
  assert.equal(preview.total, 2);
  assert.equal(preview.flagged, 1);

  const result = await clearAllFirstLoginFlags();
  assert.equal(result.remaining, 0);

  const again = await previewFirstLoginFlags();
  assert.equal(again.flagged, 0, 're-run is a no-op');
  const reloaded = await User.findById(flagged._id);
  assert.equal(reloaded.toSafeJSON().mustChangePassword, false);
});

test('admin-role holder can change their own password (self-service)', async () => {
  const admin = await createEmployee();
  await User.updateOne(
    { _id: admin._id },
    { $set: { role: 'admin', mustChangePassword: true } },
  );

  const result = await changePassword(admin._id, {
    currentPassword: 'Original@123',
    newPassword: 'AdminChanged@789',
    confirmPassword: 'AdminChanged@789',
  });

  assert.equal(result.message, 'Password changed successfully.');
  const reloaded = await User.findById(admin._id);
  assert.equal(
    await bcrypt.compare('AdminChanged@789', reloaded.passwordHash),
    true,
  );
  assert.equal(reloaded.toSafeJSON().mustChangePassword, false);
});

test('changing the password clears both flags', async () => {
  const employee = await createEmployee();
  await User.updateOne(
    { _id: employee._id },
    { $set: { mustChangePassword: true, forcePasswordChange: true } },
  );

  await changePassword(employee._id, {
    currentPassword: 'Original@123',
    newPassword: 'Changed@456',
    confirmPassword: 'Changed@456',
  });

  const flags = await freshFlags(employee._id);
  assert.equal(flags.must, false);
  assert.equal(flags.force, false);
  const reloaded = await User.findById(employee._id);
  assert.equal(reloaded.toSafeJSON().mustChangePassword, false);
});
