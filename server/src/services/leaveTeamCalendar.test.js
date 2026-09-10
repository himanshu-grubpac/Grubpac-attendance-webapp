import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { getISTDateInputValue } from '../utils/istDate.js';
import { getTeamCalendar } from './leaveService.js';

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

const actor = { _id: new mongoose.Types.ObjectId() };
const permissions = ['leave.read_all'];

test('getTeamCalendar defaults to the IST month when month is omitted', async () => {
  await User.create({
    email: `cal.${Date.now()}@grubpac.com`,
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: 'Cal',
    name: 'Cal Test',
    mobile: `8${String(Date.now()).slice(-9)}`,
    employeeCode: `CAL${String(Date.now()).slice(-8)}`,
  });

  const result = await getTeamCalendar(actor, permissions, {});
  // IST month (YYYY-MM), never the UTC month near IST midnight on the 1st.
  assert.equal(result.month, getISTDateInputValue().slice(0, 7));
  assert.ok(result.users.length >= 1);
});

test('getTeamCalendar honors an explicit month param', async () => {
  const result = await getTeamCalendar(actor, permissions, { month: '2026-01' });
  assert.equal(result.month, '2026-01');
});
