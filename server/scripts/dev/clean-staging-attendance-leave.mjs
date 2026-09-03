/**
 * Staging-only cleanup: leave requests + attendance check-in/out data.
 * Does NOT delete users, employees, leave types/policies, leave balances, departments, etc.
 *
 * Leave balances are NOT reset. If approved leave reduced balances, reset manually or re-seed balances.
 *
 * Usage:
 *   node server/scripts/clean-staging-attendance-leave.mjs --confirm-staging
 *   $env:STAGING_CLEAN_CONFIRM='1'; node server/scripts/clean-staging-attendance-leave.mjs
 *   node --env-file=server/.env.staging server/scripts/clean-staging-attendance-leave.mjs --confirm-staging
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const TARGET_COLLECTIONS = [
  'leaverequests',
  'attendancerecords',
  'weekattendanceconfirmations',
];

const STAGING_HOST_MARKERS = ['attendance-staging', 'attendance-staging.ivyl6lu.mongodb.net'];

function hasConfirmFlag() {
  if (process.env.STAGING_CLEAN_CONFIRM === '1') return true;
  return process.argv.includes('--confirm-staging');
}

function loadUriFromSamconfig() {
  const tomlPath = resolve(ROOT, 'samconfig.staging.toml');
  let toml;
  try {
    toml = readFileSync(tomlPath, 'utf8');
  } catch {
    throw new Error(
      'No MONGODB_URI in environment and samconfig.staging.toml not found. Copy samconfig.staging.example.toml or use --env-file=server/.env.staging',
    );
  }
  const m = toml.match(/mongodb\+srv:\/\/[^\\"]+attendance-staging[^\\"]+/);
  if (!m) {
    throw new Error('Staging MongoDbUri not found in samconfig.staging.toml');
  }
  return m[0];
}

function resolveMongoUri() {
  const fromEnv = process.env.MONGODB_URI?.trim();
  if (fromEnv) return fromEnv;
  return loadUriFromSamconfig();
}

function assertStagingUri(uri) {
  const lower = uri.toLowerCase();
  const looksStaging = STAGING_HOST_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
  if (!looksStaging) {
    throw new Error(
      'Refusing to run: connection string does not look like staging (expected attendance-staging host). Set MONGODB_URI to staging Atlas only.',
    );
  }
  if (/prod(uction)?/i.test(lower) && !lower.includes('attendance-staging')) {
    throw new Error('Refusing to run: connection string appears to reference production.');
  }
}

function redactUri(uri) {
  return uri.replace(/:([^:@/]+)@/, ':***@');
}

async function connectStaging(uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    return { mode: 'srv', uri: redactUri(uri) };
  } catch (srvErr) {
    const userPassMatch = uri.match(/mongodb\+srv:\/\/([^@]+)@/);
    if (!userPassMatch) throw srvErr;
    const userPass = userPassMatch[1];
    const directUri =
      `mongodb://${userPass}@ac-fnycnlh-shard-00-00.ivyl6lu.mongodb.net:27017,` +
      `ac-fnycnlh-shard-00-01.ivyl6lu.mongodb.net:27017,` +
      `ac-fnycnlh-shard-00-02.ivyl6lu.mongodb.net:27017/attendance_web` +
      '?ssl=true&authSource=admin&replicaSet=atlas-fnycnlh-shard-0&appName=attendance-staging';
    assertStagingUri(directUri);
    await mongoose.connect(directUri, { serverSelectionTimeoutMS: 15000 });
    return { mode: 'direct', uri: redactUri(directUri), srvError: srvErr.message };
  }
}

async function countTargets(db) {
  const counts = {};
  for (const name of TARGET_COLLECTIONS) {
    counts[name] = await db.collection(name).countDocuments();
  }
  return counts;
}

function printCounts(label, counts) {
  console.log(`\n=== ${label} ===`);
  for (const name of TARGET_COLLECTIONS) {
    console.log(`  ${name}: ${counts[name] ?? 0}`);
  }
}

async function main() {
  if (!hasConfirmFlag()) {
    console.error(
      'Aborted: pass --confirm-staging or set STAGING_CLEAN_CONFIRM=1 to run against staging.',
    );
    process.exit(1);
  }

  const uri = resolveMongoUri();
  assertStagingUri(uri);

  console.log('Staging cleanup: leave requests + attendance records only.');
  console.log('Preserved: users, roles, departments, leave types/policies, leave balances, holidays, office settings, help tickets, audit logs, etc.');
  console.log('Note: leavebalances are NOT reset. Reconcile manually if approved leave consumed quota.');

  const conn = await connectStaging(uri);
  console.log('Connected via:', conn.mode, conn.uri);
  if (conn.srvError) console.log('SRV fallback reason:', conn.srvError);

  const db = mongoose.connection.db;
  const before = await countTargets(db);
  printCounts('Counts BEFORE delete', before);

  const deleted = {};
  for (const name of TARGET_COLLECTIONS) {
    const result = await db.collection(name).deleteMany({});
    deleted[name] = result.deletedCount ?? 0;
  }

  printCounts('Counts AFTER delete', await countTargets(db));
  console.log('\n=== Deleted documents ===');
  for (const name of TARGET_COLLECTIONS) {
    console.log(`  ${name}: ${deleted[name]}`);
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
