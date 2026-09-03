import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { acquireJobLock, releaseJobLock } from './jobLock.js';
import { JobLock } from '../models/JobLock.js';

let memServer;

async function setup() {
  memServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memServer.waitUntilRunning();
  await mongoose.connect(memServer.getUri(), { maxPoolSize: 1 });
}

async function teardown() {
  await mongoose.disconnect();
  await memServer.stop();
}

test('acquireJobLock: succeeds on empty collection', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const result = await acquireJobLock('test-job', { ttlMs: 10_000 });

    assert.equal(result.acquired, true);
    assert.ok(result.lockId);
    assert.ok(result.lockId.startsWith('test-job-'));
  } finally {
    await teardown();
  }
});

test('acquireJobLock: fails when lock is held by active process', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const r1 = await acquireJobLock('test-job', { ttlMs: 10_000 });
    const r2 = await acquireJobLock('test-job', { ttlMs: 10_000 });

    assert.equal(r1.acquired, true);
    assert.equal(r2.acquired, false);
    assert.equal(r2.reason, 'locked_by_other');
  } finally {
    await teardown();
  }
});

test('acquireJobLock: succeeds after release', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const r1 = await acquireJobLock('test-job', { ttlMs: 10_000 });
    await releaseJobLock('test-job', r1.lockId);
    const r2 = await acquireJobLock('test-job', { ttlMs: 10_000 });

    assert.equal(r1.acquired, true);
    assert.equal(r2.acquired, true);
  } finally {
    await teardown();
  }
});

test('acquireJobLock: succeeds on expired lock', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    await JobLock.create({
      name: 'stale-job',
      lockId: 'stale-job-old-lock',
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const result = await acquireJobLock('stale-job', { ttlMs: 10_000 });

    assert.equal(result.acquired, true);
    assert.ok(result.lockId !== 'stale-job-old-lock', 'should use new lockId');
  } finally {
    await teardown();
  }
});

test('acquireJobLock: concurrent acquire — exactly one wins', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const p1 = acquireJobLock('race-job', { ttlMs: 10_000 });
    const p2 = acquireJobLock('race-job', { ttlMs: 10_000 });
    const [a, b] = await Promise.all([p1, p2]);

    assert.ok(
      (a.acquired && !b.acquired) || (!a.acquired && b.acquired),
      'exactly one should acquire',
    );
    const winner = a.acquired ? a : b;
    await releaseJobLock('race-job', winner.lockId);
  } finally {
    await teardown();
  }
});

test('acquireJobLock: different lock names are independent', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const r1 = await acquireJobLock('job-a', { ttlMs: 10_000 });
    const r2 = await acquireJobLock('job-b', { ttlMs: 10_000 });

    assert.equal(r1.acquired, true);
    assert.equal(r2.acquired, true);
    await releaseJobLock('job-a', r1.lockId);
    await releaseJobLock('job-b', r2.lockId);
  } finally {
    await teardown();
  }
});

test('releaseJobLock: deletes correct lock', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const r1 = await acquireJobLock('test-job', { ttlMs: 10_000 });
    await releaseJobLock('test-job', r1.lockId);
    const locks = await JobLock.find({ name: 'test-job' });

    assert.equal(locks.length, 0);
  } finally {
    await teardown();
  }
});

test('releaseJobLock: does not delete another holder lock', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const r1 = await acquireJobLock('test-job', { ttlMs: 10_000 });
    const r2 = await acquireJobLock('test-job', { ttlMs: 10_000 });

    assert.equal(r2.acquired, false, 'second acquire should fail');

    // Release with wrong lockId — should not affect r1's lock
    await releaseJobLock('test-job', 'wrong-lock-id');
    const locks = await JobLock.find({ name: 'test-job' });

    assert.equal(locks.length, 1, 'original lock should still exist');
    assert.equal(locks[0].lockId, r1.lockId);
    await releaseJobLock('test-job', r1.lockId);
  } finally {
    await teardown();
  }
});

test('acquireJobLock: lock TTL defaults to 240 seconds', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const result = await acquireJobLock('test-job');

    assert.equal(result.acquired, true);
    const lock = await JobLock.findOne({ name: 'test-job' });
    const ttlMs = lock.expiresAt.getTime() - lock.createdAt.getTime();
    assert.ok(ttlMs >= 239_000 && ttlMs <= 241_000, `TTL should be ~240s, got ${ttlMs}`);
    await releaseJobLock('test-job', result.lockId);
  } finally {
    await teardown();
  }
});

test('acquireJobLock: lock record has correct fields', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    const result = await acquireJobLock('test-job', { ttlMs: 5_000 });
    const lock = await JobLock.findOne({ name: 'test-job' });

    assert.equal(lock.name, 'test-job');
    assert.equal(lock.lockId, result.lockId);
    assert.ok(lock.createdAt instanceof Date);
    assert.ok(lock.expiresAt instanceof Date);
    assert.ok(lock.expiresAt.getTime() > lock.createdAt.getTime());
    await releaseJobLock('test-job', result.lockId);
  } finally {
    await teardown();
  }
});

test('releaseJobLock: no-op for non-existent lock', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    // Should not throw
    await releaseJobLock('test-job', 'nonexistent-lock-id');
    const locks = await JobLock.find({ name: 'test-job' });
    assert.equal(locks.length, 0);
  } finally {
    await teardown();
  }
});

test('acquireJobLock: overwrite stale lock from different process', async () => {
  await setup();
  try {
    await JobLock.deleteMany({});
    // Simulate stale lock from another process
    await JobLock.create({
      name: 'stale-overwrite',
      lockId: 'stale-overwrite-old',
      createdAt: new Date(Date.now() - 30_000),
      expiresAt: new Date(Date.now() - 10_000),
    });
    const result = await acquireJobLock('stale-overwrite', { ttlMs: 10_000 });

    assert.equal(result.acquired, true);
    assert.ok(result.lockId !== 'stale-overwrite-old');
    const lock = await JobLock.findOne({ name: 'stale-overwrite' });
    assert.equal(lock.lockId, result.lockId);
  } finally {
    await teardown();
  }
});
