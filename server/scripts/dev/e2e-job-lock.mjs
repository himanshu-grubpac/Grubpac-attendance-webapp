import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { acquireJobLock, releaseJobLock } from '../../src/utils/jobLock.js';
import { JobLock } from '../../src/models/JobLock.js';

if (!process.env.USE_MEMORY_DB) process.env.USE_MEMORY_DB = 'true';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

await connectDatabase();

try {
  await JobLock.deleteMany({});

  const r1 = await acquireJobLock('test-job', { ttlMs: 10_000 });
  check('acquire succeeds on empty', r1.acquired === true);

  const r2 = await acquireJobLock('test-job', { ttlMs: 10_000 });
  check('acquire fails when locked', r2.acquired === false);

  await releaseJobLock('test-job', r1.lockId);
  const r3 = await acquireJobLock('test-job', { ttlMs: 10_000 });
  check('acquire succeeds after release', r3.acquired === true);
  await releaseJobLock('test-job', r3.lockId);

  const r4 = await acquireJobLock('job-a', { ttlMs: 10_000 });
  const r5 = await acquireJobLock('job-b', { ttlMs: 10_000 });
  check('different lock names are independent', r4.acquired === true && r5.acquired === true);
  await releaseJobLock('job-a', r4.lockId);
  await releaseJobLock('job-b', r5.lockId);

  await JobLock.deleteMany({});
  const expired = await JobLock.create({
    name: 'stale-job',
    lockId: 'old-lock',
    createdAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() - 1_000),
  });
  const r6 = await acquireJobLock('stale-job', { ttlMs: 10_000 });
  check('acquire succeeds on expired lock', r6.acquired === true);
  await releaseJobLock('stale-job', r6.lockId);

  await JobLock.deleteMany({});
  const p1 = acquireJobLock('race-job', { ttlMs: 10_000 });
  const p2 = acquireJobLock('race-job', { ttlMs: 10_000 });
  const [a, b] = await Promise.all([p1, p2]);
  check('concurrent acquire — exactly one wins', (a.acquired && !b.acquired) || (!a.acquired && b.acquired));
  const winner = a.acquired ? a : b;
  await releaseJobLock('race-job', winner.lockId);

  const r7 = await acquireJobLock('release-test', { ttlMs: 10_000 });
  await releaseJobLock('release-test', r7.lockId);
  const r8 = await acquireJobLock('release-test', { ttlMs: 10_000 });
  check('re-acquire after release works', r8.acquired === true);
  await releaseJobLock('release-test', r8.lockId);
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await disconnectDatabase();
}

console.log('JOB LOCK E2E:', passed, 'passed,', failed, 'failed');
process.exit(failed === 0 ? 0 : 1);

