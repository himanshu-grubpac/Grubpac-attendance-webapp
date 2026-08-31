import { JobLock } from '../models/JobLock.js';

export async function acquireJobLock(name, { ttlMs = 240_000 } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const lockId = `${name}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;

  const existing = await JobLock.findOne({ name }).lean();

  if (existing && existing.expiresAt > now) {
    return { acquired: false, reason: 'locked_by_other' };
  }

  try {
    await JobLock.insertOne({ name, lockId, createdAt: now, expiresAt });
    return { acquired: true, lockId };
  } catch {
    // Duplicate key — document already exists. Overwrite if expired.
    const stale = await JobLock.findOne({ name }).lean();
    if (!stale || stale.expiresAt > now) {
      return { acquired: false, reason: 'locked_by_other' };
    }
    await JobLock.updateOne(
      { name, lockId: stale.lockId },
      { $set: { lockId, createdAt: now, expiresAt } },
    );
    return { acquired: true, lockId };
  }
}

export async function releaseJobLock(name, lockId) {
  await JobLock.deleteOne({ name, lockId });
}
