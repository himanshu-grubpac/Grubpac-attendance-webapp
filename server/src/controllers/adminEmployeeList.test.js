import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { listEmployees } from './adminController.js';

let memServer;

before(async () => {
  memServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memServer.waitUntilRunning();
  await mongoose.connect(memServer.getUri(), { maxPoolSize: 1 });
});

after(async () => {
  await mongoose.disconnect();
  await memServer.stop();
});

const reqFor = (page, limit) => ({
  query: { page: String(page), limit: String(limit) },
  user: { _id: new mongoose.Types.ObjectId() },
  userPermissions: ['attendance.read_all'],
});

const captureRes = () => {
  let body;
  return {
    res: { json: (payload) => { body = payload; } },
    getBody: () => body,
  };
};

async function makeEmployee(suffix, name = 'Same Name') {
  const ts = `${Date.now()}${suffix}${Math.floor(Math.random() * 1e6)}`;
  return User.create({
    email: `dup.${ts}@grubpac.com`,
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: name.split(' ')[0],
    name,
    mobile: `9${String(ts).slice(-9)}`,
    employeeCode: `DUP${String(ts).slice(-8)}`,
  });
}

test('same-name employees never appear on two pages (stable _id tiebreaker)', async () => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await makeEmployee(`s${i}`);
  }
  await makeEmployee('other', 'Zed Different');

  const seen = [];
  let total = 0;
  for (const page of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    const { res, getBody } = captureRes();
    // eslint-disable-next-line no-await-in-loop
    await listEmployees(reqFor(page, 2), res);
    const body = getBody();
    total = body.pagination.total;
    seen.push(...body.employees.map((e) => e.id));
  }

  assert.equal(seen.length, new Set(seen).size, 'no employee id repeats across pages');
  assert.equal(seen.length, Math.min(total, 6), 'pages cover every employee exactly once');
});

test('repeated page reads return identical order (deterministic sort)', async () => {
  const first = captureRes();
  await listEmployees(reqFor(1, 10), first.res);
  const second = captureRes();
  await listEmployees(reqFor(1, 10), second.res);

  assert.deepEqual(
    second.getBody().employees.map((e) => e.id),
    first.getBody().employees.map((e) => e.id),
  );
});
