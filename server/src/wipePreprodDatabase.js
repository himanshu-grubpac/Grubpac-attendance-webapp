/**
 * Preprod-only database clean — wipes ALL app data, no demo re-seed.
 *
 * Use this when preprod should be empty except one admin login.
 * For demo/sample data after a wipe, run seed.js separately (without --wipe).
 *
 * Safety:
 *   - Refuses unless MONGODB_URI host is the preprod Atlas cluster.
 *   - Requires CONFIRM_PREPROD_WIPE=1 (or --force for local tests only).
 *
 * Wiped: every non-system collection (users, attendance, leave, help, comp-off,
 *   month settlements, table prefs, demo FAQ, etc.).
 *
 * Re-seeded (minimal):
 *   - 4 system roles from shared/permissions.js
 *   - 1 admin user from ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_PIN in env
 *
 * NOT run on staging or production — use migrateRecentFeatures for prod schema only.
 *
 * Usage (from server/):
 *   $env:CONFIRM_PREPROD_WIPE = "1"
 *   node --env-file=.env.preprod src/wipePreprodDatabase.js
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { pinSchema } from '../../shared/validation/auth.js';
import { SYSTEM_ROLES, SYSTEM_ROLE_SLUGS } from '../../shared/permissions.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { Role } from './models/Role.js';
import { User } from './models/User.js';

/** Must match server/.env.preprod.example Atlas host — preprod cluster only. */
export const PREPROD_CLUSTER_HOST = 'attendance-preprod.wtj7gte.mongodb.net';

const ADMIN_EMAIL = env.adminEmail.toLowerCase();

function getMongoHost(uri) {
  try {
    const parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getDbLabel() {
  const uri = env.mongoUri;
  try {
    const parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    const dbName = parsed.pathname.replace(/^\//, '') || '(default)';
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${dbName}`;
  } catch {
    return '(could not parse MONGODB_URI)';
  }
}

function assertPreprodTarget() {
  const host = getMongoHost(env.mongoUri);
  if (host !== PREPROD_CLUSTER_HOST) {
    console.error(
      'Refusing: this script runs ONLY on the preprod Atlas cluster.\n'
      + `Expected host: ${PREPROD_CLUSTER_HOST}\n`
      + `Actual host:   ${host || '(unknown)'}\n`
      + 'Use: node --env-file=.env.preprod src/wipePreprodDatabase.js',
    );
    process.exit(1);
  }
}

function assertConfirmed() {
  const confirmed = process.env.CONFIRM_PREPROD_WIPE === '1'
    || process.env.CONFIRM_PREPROD_WIPE === 'true';
  const force = process.argv.includes('--force');
  if (!confirmed && !force) {
    console.error(
      'Refusing: preprod wipe is destructive.\n'
      + 'Set CONFIRM_PREPROD_WIPE=1 and re-run.\n'
      + `Target: ${getDbLabel()}`,
    );
    process.exit(1);
  }
}

async function getCollectionCounts() {
  const infos = await mongoose.connection.db.listCollections().toArray();
  const names = infos
    .map((info) => info.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();

  const counts = {};
  for (const name of names) {
    counts[name] = await mongoose.connection.db.collection(name).countDocuments();
  }
  return counts;
}

function printCounts(label, counts) {
  console.log(`\n=== ${label} ===`);
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    console.log('(no collections)');
    return;
  }
  for (const [name, count] of entries) {
    console.log(`  ${name}: ${count}`);
  }
}

async function wipeAllCollections() {
  const infos = await mongoose.connection.db.listCollections().toArray();
  const names = infos
    .map((info) => info.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();

  const wiped = [];
  for (const name of names) {
    const result = await mongoose.connection.db.collection(name).deleteMany({});
    wiped.push({ name, deleted: result.deletedCount });
  }
  return wiped;
}

async function upsertSystemRoles() {
  const roleMap = new Map();

  for (const seedRole of SYSTEM_ROLES) {
    let role = await Role.findOne({ slug: seedRole.slug });
    if (!role) {
      role = await Role.create(seedRole);
      console.log(`Seeded role: ${seedRole.name}`);
    } else {
      role.name = seedRole.name;
      role.description = seedRole.description;
      role.isSystem = true;
      role.permissions = seedRole.permissions;
      await role.save();
      console.log(`Updated role: ${seedRole.name}`);
    }
    roleMap.set(seedRole.slug, role);
  }

  return roleMap;
}

async function seedAdminFromEnv(roleMap) {
  const adminRole = roleMap.get(SYSTEM_ROLE_SLUGS.ADMIN);
  if (!adminRole) {
    throw new Error('Admin role missing after system role seed.');
  }

  pinSchema.parse(env.adminPin);

  const [adminFirstName, ...adminLastNameParts] = env.adminName.trim().split(/\s+/);
  const adminLastName = adminLastNameParts.join(' ') || adminFirstName;
  const passwordHash = await bcrypt.hash(env.adminPassword, 12);
  const pin4Hash = await bcrypt.hash(env.adminPin, 12);

  await User.create({
    role: 'admin',
    roleId: adminRole._id,
    firstName: adminFirstName,
    lastName: adminLastName,
    name: env.adminName,
    email: ADMIN_EMAIL,
    mobile: '9999999999',
    designation: 'System Administrator',
    joiningDate: new Date(),
    passwordHash,
    pin4Hash,
    isActive: true,
  });

  console.log(`Created admin: ${ADMIN_EMAIL} (password/PIN from env — not printed)`);
}

export async function wipePreprodDatabase() {
  assertPreprodTarget();
  assertConfirmed();

  await connectDatabase();

  console.log('\n=== Preprod database clean ===');
  console.log(`Target: ${getDbLabel()}`);
  console.log('Mode: full wipe + minimal admin (no demo employees, leave, or attendance)');

  const countsBefore = await getCollectionCounts();
  printCounts('Counts BEFORE wipe', countsBefore);

  const wiped = await wipeAllCollections();
  console.log(`\nWiped ${wiped.length} collection(s):`);
  for (const { name, deleted } of wiped) {
    console.log(`  ${name}: deleted ${deleted} document(s)`);
  }

  const roleMap = await upsertSystemRoles();
  await seedAdminFromEnv(roleMap);

  const countsAfter = await getCollectionCounts();
  printCounts('Counts AFTER clean', countsAfter);

  const userCount = await User.countDocuments();
  if (userCount !== 1) {
    throw new Error(`Expected exactly 1 user after clean, found ${userCount}.`);
  }

  await disconnectDatabase();

  console.log('\nPreprod clean complete.');
  console.log('Portal should show empty lists (no employees/attendance) after re-login.');
  console.log(`Admin login: ${ADMIN_EMAIL} — use ADMIN_PASSWORD / ADMIN_PIN from .env.preprod`);
  console.log('Optional: run migrateRecentFeatures.js then seed.js (without --wipe) for demo data.');
}

if (process.argv[1]?.endsWith('wipePreprodDatabase.js')) {
  wipePreprodDatabase().catch(async (error) => {
    console.error(error);
    try {
      await disconnectDatabase();
    } catch {
      // ignore
    }
    process.exit(1);
  });
}
