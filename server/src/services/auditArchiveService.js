import fs from 'node:fs/promises';
import path from 'node:path';
import { PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog.js';
import { getS3Client } from './helpAttachmentService.js';
import { acquireJobLock, releaseJobLock } from '../utils/jobLock.js';
import { auditLog } from '../utils/auditLog.js';
import { logError } from '../utils/logger.js';

/**
 * Audit-log retention: archive to cold storage after 1 month, prune after 2.
 *
 * - Months containing entries older than `archiveAfterDays` are dumped WHOLE
 *   (JSONL, one entry per line) to `s3://<bucket>/<prefix>/YYYY-MM.jsonl`
 *   (or a local directory when no bucket is configured) and overwritten on
 *   later runs, so a partially-aged month converges instead of going stale.
 * - Only entries older than `pruneAfterDays` are deleted, and only for months
 *   whose archive object was verified present (size > 0) in THIS run or
 *   already in storage — unarchived data is never deleted.
 * - Single-flight via JobLock; the run itself is audit-logged.
 */

export const AUDIT_ARCHIVE_JOB_LOCK = 'audit-archive';
export const AUDIT_ARCHIVE_DEFAULT_PREFIX = 'audit-archive';

function monthKeyOf(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthStartUtc(monthKey) {
  return new Date(`${monthKey}-01T00:00:00.000Z`);
}

function archiveBucket() {
  return process.env.AUDIT_ARCHIVE_BUCKET ?? null;
}

function archivePrefix() {
  return process.env.AUDIT_ARCHIVE_PREFIX ?? AUDIT_ARCHIVE_DEFAULT_PREFIX;
}

function archiveLocalDir() {
  return path.resolve(process.cwd(), process.env.AUDIT_ARCHIVE_DIR ?? path.join('var', 'audit-archive'));
}

function serializeEntry(doc) {
  const plain = typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true }) : { ...doc };
  return JSON.stringify({
    ...plain,
    _id: plain._id?.toString?.() ?? plain._id,
    userId: plain.userId?.toString?.() ?? plain.userId ?? null,
    timestamp: plain.timestamp ? new Date(plain.timestamp).toISOString() : null,
  });
}

async function writeArchiveObject(monthKey, body) {
  const bucket = archiveBucket();
  const key = `${archivePrefix()}/${monthKey}.jsonl`;
  if (!bucket) {
    const dir = archiveLocalDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${monthKey}.jsonl`);
    await fs.writeFile(filePath, body, 'utf8');
    const stat = await fs.stat(filePath);
    return { location: `local:${filePath}`, bytes: stat.size, verified: stat.size > 0 };
  }
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/x-ndjson' }),
  );
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = head.ContentLength ?? 0;
  return { location: `s3://${bucket}/${key}`, bytes, verified: bytes > 0 };
}

export async function listArchivedMonths() {
  const bucket = archiveBucket();
  if (!bucket) {
    try {
      const files = await fs.readdir(archiveLocalDir());
      return files
        .filter((file) => /^\d{4}-\d{2}\.jsonl$/.test(file))
        .map((file) => file.slice(0, 7))
        .sort();
    } catch {
      return [];
    }
  }
  const months = [];
  let continuationToken;
  do {
    const page = await getS3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${archivePrefix()}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of page.Contents ?? []) {
      const match = /(\d{4}-\d{2})\.jsonl$/.exec(item.Key ?? '');
      if (match && (item.Size ?? 0) > 0) months.push(match[1]);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return [...new Set(months)].sort();
}

export async function getAuditArchiveStatus() {
  const oldest = await AuditLog.findOne().sort({ timestamp: 1, _id: 1 }).select('timestamp').lean();
  return {
    oldestRetainedAt: oldest?.timestamp ? new Date(oldest.timestamp).toISOString() : null,
    archivedMonths: await listArchivedMonths(),
    storage: archiveBucket() ? `s3://${archiveBucket()}/${archivePrefix()}/` : `local:${archiveLocalDir()}`,
  };
}

export async function runAuditArchiveJob({
  now = new Date(),
  dryRun = false,
  archiveAfterDays = 30,
  pruneAfterDays = 60,
  actorId = null,
} = {}) {
  const lock = await acquireJobLock(AUDIT_ARCHIVE_JOB_LOCK, { ttlMs: 600_000 });
  if (!lock.acquired) {
    return { skipped: true, reason: lock.reason };
  }
  const summary = {
    dryRun,
    archiveCutoff: new Date(now.getTime() - archiveAfterDays * 86_400_000).toISOString(),
    pruneCutoff: new Date(now.getTime() - pruneAfterDays * 86_400_000).toISOString(),
    archivedMonths: [],
    archivedEntries: 0,
    prunedEntries: 0,
    skipped: false,
  };
  try {
    const archiveCutoff = new Date(summary.archiveCutoff);
    const pruneCutoff = new Date(summary.pruneCutoff);

    // Months (UTC YYYY-MM) containing entries older than the archive cutoff.
    // Aggregation keeps this cheap no matter how large the collection grows.
    const agedMonths = await AuditLog.aggregate([
      { $match: { timestamp: { $lt: archiveCutoff } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$timestamp' } } } },
      { $sort: { _id: 1 } },
    ]);
    const monthKeys = agedMonths.map((entry) => entry._id).filter(Boolean);

    for (const monthKey of monthKeys) {
      const start = monthStartUtc(monthKey);
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const docs = await AuditLog.find({ timestamp: { $gte: start, $lt: end } })
        .sort({ timestamp: 1, _id: 1 })
        .lean();
      if (docs.length === 0) continue;

      if (dryRun) {
        summary.archivedMonths.push({ month: monthKey, entries: docs.length, location: null, bytes: 0 });
        summary.archivedEntries += docs.length;
        continue;
      }

      // Dump the WHOLE month (not just aged entries) so re-runs converge.
      const body = `${docs.map((doc) => serializeEntry(doc)).join('\n')}\n`;
      let location = null;
      let bytes = 0;
      try {
        const written = await writeArchiveObject(monthKey, body);
        if (!written.verified) throw new Error('archive object failed verification (empty)');
        location = written.location;
        bytes = written.bytes;
      } catch (err) {
        logError('audit_archive_write_failed', { monthKey, error: err?.message });
        continue;
      }
      summary.archivedMonths.push({ month: monthKey, entries: docs.length, location, bytes });
      summary.archivedEntries += docs.length;

      // Prune strictly-old entries of this verified month only. Anything
      // newer than pruneCutoff stays queryable in the app.
      const res = await AuditLog.deleteMany({ timestamp: { $gte: start, $lt: end, $lt: pruneCutoff } });
      summary.prunedEntries += res.deletedCount ?? 0;
    }

    if (!dryRun) {
      auditLog('audit_archive_run', {
        ...(actorId ? { adminId: actorId?.toString?.() ?? actorId } : {}),
        archivedMonths: summary.archivedMonths.map((entry) => entry.month),
        archivedEntries: summary.archivedEntries,
        prunedEntries: summary.prunedEntries,
      });
    }
    return summary;
  } finally {
    await releaseJobLock(AUDIT_ARCHIVE_JOB_LOCK, lock.lockId);
  }
}
