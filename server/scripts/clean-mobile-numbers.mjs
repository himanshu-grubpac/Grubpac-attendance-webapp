/**
 * One-time cleanup for mobile numbers stored with dots/spaces/other junk
 * (e.g. "96909.8452").
 *
 * For each user it computes the cleaned value with the same rule the
 * directory export uses:
 *   1. strip every non-digit → if valid 10-digit Indian number, use it;
 *   2. else +91-tolerant normalization → if valid, use it;
 *   3. else unfixable → reported for manual correction via the edit UI.
 * A cleaned value that collides with another employee's number is skipped
 * and reported (uniqueness is never broken by this script).
 *
 * Usage:
 *   node scripts/clean-mobile-numbers.mjs            # dry run (report only)
 *   node scripts/clean-mobile-numbers.mjs --apply    # write cleaned values
 */
import mongoose from 'mongoose';
import { normalizeMobile, indianMobileSchema } from '../../shared/validation/common.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:60033/?replicaSet=testset';
const APPLY = process.argv.includes('--apply');

const User = mongoose.model(
  'User',
  new mongoose.Schema(
    {
      email: String,
      mobile: String,
      employeeCode: String,
      firstName: String,
      lastName: String,
    },
    { timestamps: true },
  ),
  'users',
);

function cleanMobile(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (indianMobileSchema.safeParse(digits).success) return digits;
  const normalized = normalizeMobile(raw);
  if (indianMobileSchema.safeParse(normalized).success) return normalized;
  return null;
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (report only)'}\n`);

  const users = await User.find({}).select('email mobile employeeCode firstName lastName').lean();
  const byMobile = new Map();
  for (const user of users) {
    const key = String(user.mobile ?? '');
    if (!byMobile.has(key)) byMobile.set(key, []);
    byMobile.get(key).push(user);
  }

  let alreadyClean = 0;
  let fixed = 0;
  let skipped = 0;
  const problems = [];

  for (const user of users) {
    const current = String(user.mobile ?? '');
    // Already a clean valid number — but verify uniqueness collisions too.
    if (/^[6-9]\d{9}$/.test(current)) {
      alreadyClean += 1;
      continue;
    }
    const cleaned = cleanMobile(current);
    const label = `${user.email || user._id} (${user.employeeCode || 'no code'})`;
    if (!cleaned) {
      skipped += 1;
      problems.push(`UNFIXABLE  ${label} :: stored ${JSON.stringify(current)} — correct manually via the employee edit form.`);
      continue;
    }
    const clash = await User.exists({ mobile: cleaned, _id: { $ne: user._id } });
    if (clash) {
      skipped += 1;
      problems.push(`COLLISION  ${label} :: cleaned value ${cleaned} already belongs to another employee — resolve manually.`);
      continue;
    }
    if (APPLY) {
      await User.updateOne({ _id: user._id }, { $set: { mobile: cleaned } });
      fixed += 1;
      console.log(`FIXED      ${label} :: ${JSON.stringify(current)} → ${cleaned}`);
    } else {
      fixed += 1;
      console.log(`WOULD FIX  ${label} :: ${JSON.stringify(current)} → ${cleaned}`);
    }
  }

  console.log(`\n---- summary ----`);
  console.log(`total users      : ${users.length}`);
  console.log(`already clean    : ${alreadyClean}`);
  console.log(`${APPLY ? 'fixed' : 'would fix'}       : ${fixed}`);
  console.log(`skipped/reported : ${skipped}`);
  if (problems.length > 0) {
    console.log(`\n---- needs manual attention ----`);
    for (const line of problems) console.log(line);
  }
  if (!APPLY && fixed > 0) {
    console.log(`\nRe-run with --apply to write these changes.`);
  }
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
