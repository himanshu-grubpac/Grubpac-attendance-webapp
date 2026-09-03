/**
 * One-time cleanup: delete orphan check_out records (no same-day allowed check_in).
 *
 * Usage:
 *   node scripts/cleanup-orphan-checkouts.mjs              # dry-run (default)
 *   node scripts/cleanup-orphan-checkouts.mjs --delete      # actually delete
 *   node scripts/cleanup-orphan-checkouts.mjs --delete --yes  # skip confirmation
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { AttendanceRecord } from '../src/models/AttendanceRecord.js';
import { User } from '../src/models/User.js';
import { getISTDateInputValue } from '../src/utils/istDate.js';

const DELETE_MODE = process.argv.includes('--delete');
const SKIP_CONFIRM = process.argv.includes('--yes');

function uidStr(r) {
  return (r.userId?._id ?? r.userId)?.toString();
}

async function main() {
  console.log('Connecting to database...');
  await connectDatabase();
  console.log('Connected.\n');

  try {
    // 1. Load ALL check_out records.
    const checkOuts = await AttendanceRecord.find({ type: 'check_out' })
      .populate('userId', 'name email')
      .sort({ timestamp: 1 })
      .lean();

    console.log(`Total check_out records in DB: ${checkOuts.length}`);

    if (checkOuts.length === 0) {
      console.log('Nothing to clean up.');
      return;
    }

    // 2. Collect unique user IDs to batch-load check-ins.
    const userIds = [...new Set(checkOuts.map((r) => uidStr(r)).filter(Boolean))];
    const checkIns = await AttendanceRecord.find({
      type: 'check_in',
      status: 'allowed',
      userId: { $in: userIds },
    })
      .select('userId timestamp')
      .lean();

    // 3. Build a set of (userId, IST day) that have an allowed check_in.
    const checkInDays = new Set();
    for (const ci of checkIns) {
      const uid = uidStr(ci);
      const day = getISTDateInputValue(ci.timestamp);
      if (uid && day) checkInDays.add(`${uid}|${day}`);
    }

    // 4. Identify orphans.
    const orphans = checkOuts.filter((co) => {
      const uid = uidStr(co);
      const day = getISTDateInputValue(co.timestamp);
      if (!uid || !day) return false;
      return !checkInDays.has(`${uid}|${day}`);
    });

    console.log(`Orphan check_out records found: ${orphans.length}\n`);

    if (orphans.length === 0) {
      console.log('No orphans to clean up. All check_out records have a same-day check_in.');
      return;
    }

    // 5. Group by user for display.
    const byUser = new Map();
    for (const o of orphans) {
      const uid = uidStr(o);
      const email = o.userId?.email ?? uid;
      if (!byUser.has(uid)) byUser.set(uid, { email, records: [] });
      byUser.get(uid).records.push(o);
    }

    console.log('─'.repeat(70));
    console.log('ORPHAN CHECK-OUT RECORDS BY USER');
    console.log('─'.repeat(70));

    for (const [uid, { email, records }] of byUser) {
      console.log(`\n  ${email} (${uid}) — ${records.length} orphan(s):`);
      for (const r of records) {
        const ts = r.timestamp?.toISOString?.() ?? r.timestamp;
        const day = getISTDateInputValue(r.timestamp);
        const mode = r.attendanceMode ?? '?';
        const auto = r.autoCheckout ? ' [autoCheckout]' : '';
        console.log(`    ${day}  ${ts}  mode=${mode}${auto}  id=${r._id}`);
      }
    }

    console.log('\n' + '─'.repeat(70));

    if (!DELETE_MODE) {
      console.log('\nDRY RUN — no records deleted.');
      console.log('Re-run with --delete to remove orphan records.');
      console.log('Add --yes to skip the confirmation prompt.');
      return;
    }

    // 6. Delete.
    if (!SKIP_CONFIRM) {
      const answer = await new Promise((resolve) => {
        process.stdout.write(`\nDelete ${orphans.length} orphan check_out record(s)? [y/N] `);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', (d) => {
          process.stdin.pause();
          resolve(d.trim().toLowerCase());
        });
      });
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Aborted.');
        return;
      }
    }

    const ids = orphans.map((r) => r._id);
    const result = await AttendanceRecord.deleteMany({ _id: { $in: ids } });
    console.log(`\nDeleted ${result.deletedCount} orphan check_out record(s).`);
    console.log('Done.');
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
