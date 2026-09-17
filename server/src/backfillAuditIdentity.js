/**
 * One-off backfill: historic audit rows stored userId but no email/role
 * (logged before actor-identity capture existed). Patches ONLY the missing
 * identity fields from the Users collection. Status, reason, outcomes and
 * any explicitly stored values are NEVER rewritten.
 *
 * Dry-run by default. Live write requires --live.
 *
 *   cd server
 *   node src/backfillAuditIdentity.js                 # dry-run report (no writes)
 *   node src/backfillAuditIdentity.js --live          # perform the writes
 *   node src/backfillAuditIdentity.js --live --uri=mongodb://127.0.0.1:27017/attendance_web
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { AuditLog } from './models/AuditLog.js';
import { User } from './models/User.js';

function isMissing(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function maskHost(uri = '') {
  const text = String(uri);
  const credentialed = text.match(/@([^/?]+)/);
  if (credentialed?.[1]) return credentialed[1];
  const bare = text.match(/mongodb(?:\+srv)?:\/\/([^/?]+)/);
  return bare?.[1] ?? '(not set — verify before running)';
}

export async function backfillAuditIdentity({ dryRun = true, batchSize = 500 } = {}) {
  const filter = {
    userId: { $exists: true, $ne: null },
    $or: [{ email: null }, { email: '' }, { role: null }, { role: '' }],
  };
  const candidates = await AuditLog.find(filter).select('_id userId email role').lean();

  const userIds = [...new Set(candidates.map((log) => String(log.userId)))];
  const users = await User.find({ _id: { $in: userIds } })
    .select('email role')
    .lean();
  const usersById = new Map(users.map((user) => [String(user._id), user]));

  let emailPatched = 0;
  let rolePatched = 0;
  let skippedNoUser = 0;
  let skippedNoData = 0;
  const ops = [];

  for (const log of candidates) {
    const user = usersById.get(String(log.userId));
    if (!user || (!user.email && !user.role)) {
      skippedNoUser += 1;
      continue;
    }
    const set = {};
    if (isMissing(log.email) && user.email) {
      set.email = user.email;
      emailPatched += 1;
    }
    if (isMissing(log.role) && user.role) {
      set.role = user.role;
      rolePatched += 1;
    }
    if (Object.keys(set).length === 0) {
      skippedNoData += 1;
      continue;
    }
    ops.push({ updateOne: { filter: { _id: log._id }, update: { $set: set } } });
  }

  let modifiedCount = 0;
  if (!dryRun && ops.length > 0) {
    for (let index = 0; index < ops.length; index += batchSize) {
      const result = await AuditLog.bulkWrite(ops.slice(index, index + batchSize), {
        ordered: false,
      });
      modifiedCount += result.modifiedCount ?? 0;
    }
  }

  return {
    scanned: candidates.length,
    distinctUsers: userIds.length,
    emailPatched,
    rolePatched,
    operations: ops.length,
    modifiedCount,
    skippedNoUser,
    skippedNoData,
    dryRun,
  };
}

const invokedAsMain = (process.argv[1] ?? '').endsWith('backfillAuditIdentity.js');

if (invokedAsMain) {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const uriArg = args.find((arg) => arg.startsWith('--uri='));
  const uri = uriArg ? uriArg.slice('--uri='.length) : process.env.MONGODB_URI ?? '';
  if (!uri) {
    console.error(
      'MONGODB_URI is not set. Run from the server/ directory (loads server/.env) or pass --uri=<mongodb-uri>.',
    );
    process.exit(1);
  }
  console.log(`Target host: ${maskHost(uri)}${live ? '' : ' (dry-run — no writes)'}`);
  await mongoose.connect(uri);
  try {
    const result = await backfillAuditIdentity({ dryRun: !live });
    console.log(JSON.stringify(result, null, 2));
    if (!live && result.operations > 0) {
      console.log('Re-run with --live to perform the writes.');
    }
  } finally {
    await mongoose.disconnect();
  }
}
