import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { TablePreference } from '../models/TablePreference.js';
import { getPreference, upsertPreference } from './tablePreferenceService.js';

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

const userId = () => new mongoose.Types.ObjectId();

test('getPreference with no saved doc returns full defaults with saved:false', async () => {
  const pref = await getPreference(userId(), 'leaveList', []);
  assert.equal(pref.saved, false);
  assert.equal(pref.columns.length, 8);
  assert.deepEqual(
    pref.columns.map((c) => c.key),
    ['employee', 'type', 'period', 'days', 'status', 'startDate', 'endDate', 'reason'],
  );
});

test('upsertPreference returns saved:true and getPreference reflects it', async () => {
  const id = userId();
  const cols = [
    { key: 'type', order: 0, width: null, pinned: null },
    { key: 'status', order: 1, width: null, pinned: null },
  ];
  const saved = await upsertPreference(id, 'leaveList', { columns: cols }, []);
  assert.equal(saved.saved, true);

  const fetched = await getPreference(id, 'leaveList', []);
  assert.equal(fetched.saved, true);
  assert.deepEqual(
    fetched.columns.map((c) => c.key),
    ['type', 'status'],
  );
  await TablePreference.deleteMany({ userId: id });
});
