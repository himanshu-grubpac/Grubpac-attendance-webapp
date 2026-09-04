/**
 * One-time retirement of 6-digit PINs — the system PIN is strictly 4-digit.
 *
 * Unsets the legacy `pin6Hash` field on all users. Bcrypt hashes cannot be
 * converted, so affected users sign in with their password afterwards and set
 * a fresh 4-digit PIN via Change Password → Set PIN.
 *
 * Idempotent: re-running after completion matches zero documents.
 *
 * Usage:
 *   node src/migrateUnsetPin6.js            # dry run — counts only, changes nothing
 *   node src/migrateUnsetPin6.js --apply    # performs the unset
 */
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { User } from './models/User.js';

const apply = process.argv.includes('--apply');

async function main() {
  await connectDatabase();

  // $exists is required: $ne:null alone also matches documents without the field.
  const filter = { pin6Hash: { $exists: true, $ne: null } };
  const matched = await User.countDocuments(filter);
  console.log(`[migrate-unset-pin6] users with a stored pin6Hash: ${matched}`);

  if (!apply) {
    console.log('[migrate-unset-pin6] dry run — pass --apply to unset pin6Hash.');
    return { matched, modified: 0, applied: false };
  }

  const result = await User.updateMany(filter, { $unset: { pin6Hash: 1 } });
  console.log(`[migrate-unset-pin6] unset pin6Hash on ${result.modifiedCount} user(s).`);
  return { matched, modified: result.modifiedCount ?? 0, applied: true };
}

main()
  .then(() => disconnectDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[migrate-unset-pin6] failed:', err?.message ?? err);
    try {
      await disconnectDatabase();
    } catch {
      // Ignore disconnect errors during failure teardown.
    }
    process.exit(1);
  });
