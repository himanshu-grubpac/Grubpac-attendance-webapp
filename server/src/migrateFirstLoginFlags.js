/**
 * One-time first-login flag reset.
 *
 * Background: `forcePasswordChange` used to default to `true`, so every
 * pre-existing account (missing the field in Mongo) was forced through the
 * change-password gate. The default is now `false` and only new-account
 * creation sets the flags — this script clears the stale state once.
 *
 * Clears BOTH flags for EVERY current user (operator decision: all existing
 * accounts ungated). Anyone genuinely still on a temp password simply sets a
 * new one at the next self-service opportunity; no account can be re-gated
 * except by re-creation.
 *
 * Usage (always from server/):
 *   node --env-file=.env.staging src/migrateFirstLoginFlags.js        # dry run
 *   node --env-file=.env.staging src/migrateFirstLoginFlags.js --apply # write
 *   node --env-file=.env.production src/migrateFirstLoginFlags.js --apply
 *
 * Safe to re-run: second run reports zero flagged users and writes nothing.
 */
import { pathToFileURL } from 'node:url';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { User } from './models/User.js';

export async function previewFirstLoginFlags() {
  const [total, flagged, missingField] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({
      $or: [{ forcePasswordChange: true }, { mustChangePassword: true }],
    }),
    User.countDocuments({ forcePasswordChange: { $exists: false } }),
  ]);
  return { total, flagged, missingField };
}

export async function clearAllFirstLoginFlags() {
  const result = await User.updateMany(
    {},
    { $set: { forcePasswordChange: false, mustChangePassword: false } },
  );
  const remaining = await User.countDocuments({
    $or: [{ forcePasswordChange: true }, { mustChangePassword: true }],
  });
  return { modifiedCount: result.modifiedCount ?? 0, remaining };
}

async function migrateFirstLoginFlags() {
  await connectDatabase();

  const preview = await previewFirstLoginFlags();
  console.log(`Users total: ${preview.total}`);
  console.log(`Flagged (force OR must true): ${preview.flagged}`);
  console.log(`Missing forcePasswordChange field: ${preview.missingField}`);

  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log(`\nDry run — no writes. Re-run with --apply to clear ${preview.flagged} flagged account(s).`);
    await disconnectDatabase();
    process.exit(0);
  }

  const result = await clearAllFirstLoginFlags();
  console.log(`\nCleared flags on ${result.modifiedCount} user(s).`);
  console.log(`Remaining flagged: ${result.remaining}`);
  if (result.remaining !== 0) {
    throw new Error(`Migration incomplete: ${result.remaining} user(s) still flagged.`);
  }

  await disconnectDatabase();
  console.log('Migration complete.');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  migrateFirstLoginFlags().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
