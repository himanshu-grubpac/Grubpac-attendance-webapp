/**
 * Destructive DB wipe — keeps holiday calendar + office geo/settings only.
 *
 * KEPT (documents never deleted or modified):
 *   - holidays          — Calendar Management holiday documents
 *   - officesettings    — Office geo (lat/long/radius), hours, recurring rules
 *
 * WIPED (all documents deleted from every other collection):
 *   - users, roles, departments, attendancerecords, auditlogs, leaverequests,
 *     leavetypes, leavepolicies, leavebalances, leavecarryforwardentries,
 *     weekattendanceconfirmations, salarytransfers, salarysettings, notifications,
 *     helptickets, helpcomments, holidaycategories, idempotencyrecords, etc.
 *
 * RE-SEEDED (minimal — admin login + RBAC only):
 *   - All 4 system roles (Admin, HR, Reporting Manager, Employee) from shared/permissions.js
 *   - Exactly one admin user (ADMIN_EMAIL / admin@grubpac.com) with a new random password
 *
 * NOT seeded: custom roles (create via Roles UI), departments, leave types/policies,
 *   sample employees, attendance, audit, etc.
 *
 * Idempotent-ish: re-running still leaves holidays/geo intact, re-seeds all 4 system roles,
 * and ensures a single admin user.
 * Each run generates a new admin password and replaces any existing users.
 *
 * Usage (local or production):
 *   npm run wipe:keep-holidays-geo
 *   CONFIRM_WIPE=1 npm run wipe:keep-holidays-geo   # required on non-localhost URIs
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { SYSTEM_ROLES, SYSTEM_ROLE_SLUGS } from '../../shared/permissions.js';
import { Role } from './models/Role.js';
import { User } from './models/User.js';

const PRESERVED_COLLECTIONS = new Set(['holidays', 'officesettings']);
const ADMIN_EMAIL = env.adminEmail.toLowerCase();

function generateStrongPassword(length = 20) {
  const lowers = 'abcdefghijklmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const special = '!@#$%^&*-_=+';
  const all = lowers + uppers + digits + special;

  const chars = [
    lowers[crypto.randomInt(lowers.length)],
    uppers[crypto.randomInt(uppers.length)],
    digits[crypto.randomInt(digits.length)],
    special[crypto.randomInt(special.length)],
  ];
  for (let i = chars.length; i < length; i += 1) {
    chars.push(all[crypto.randomInt(all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
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

function isLocalMongoUri(uri) {
  return /mongodb(\+srv)?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(uri)
    || uri.startsWith('mongodb://127.0.0.1')
    || uri.startsWith('mongodb://localhost');
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
    const tag = PRESERVED_COLLECTIONS.has(name) ? ' [KEPT]' : '';
    console.log(`  ${name}: ${count}${tag}`);
  }
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

async function wipeNonPreservedCollections() {
  const infos = await mongoose.connection.db.listCollections().toArray();
  const names = infos
    .map((info) => info.name)
    .filter((name) => !name.startsWith('system.') && !PRESERVED_COLLECTIONS.has(name))
    .sort();

  const wiped = [];
  for (const name of names) {
    const result = await mongoose.connection.db.collection(name).deleteMany({});
    wiped.push({ name, deleted: result.deletedCount });
  }

  return wiped;
}

async function seedSingleAdmin(roleMap) {
  const adminRole = roleMap.get(SYSTEM_ROLE_SLUGS.ADMIN);
  if (!adminRole) {
    throw new Error('Admin role missing after system role seed.');
  }

  const plainPassword = generateStrongPassword(20);
  const passwordHash = await bcrypt.hash(plainPassword, 12);
  const [adminFirstName, ...adminLastNameParts] = env.adminName.trim().split(/\s+/);
  const adminLastName = adminLastNameParts.join(' ') || adminFirstName;

  await User.deleteMany({});
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
    isActive: true,
  });

  console.log(`Created single admin: ${ADMIN_EMAIL}`);
  return plainPassword;
}

async function wipeKeepHolidaysGeo() {
  const force = process.argv.includes('--force');
  const confirmed = process.env.CONFIRM_WIPE === '1' || process.env.CONFIRM_WIPE === 'true';
  const memoryDb = process.env.USE_MEMORY_DB === 'true';

  if (!memoryDb && !isLocalMongoUri(env.mongoUri) && !force && !confirmed) {
    console.error(
      'Refusing to wipe a non-local MongoDB URI without confirmation.\n'
      + 'Set CONFIRM_WIPE=1 or pass --force to proceed.\n'
      + `Target: ${getDbLabel()}`,
    );
    process.exit(1);
  }

  await connectDatabase();

  console.log(`\nTarget database: ${getDbLabel()}`);
  console.log(`Preserved collections: ${[...PRESERVED_COLLECTIONS].join(', ')}`);

  const countsBefore = await getCollectionCounts();
  printCounts('Counts BEFORE wipe', countsBefore);

  const wiped = await wipeNonPreservedCollections();
  console.log(`\nWiped ${wiped.length} collection(s):`);
  for (const { name, deleted } of wiped) {
    console.log(`  ${name}: deleted ${deleted} document(s)`);
  }

  const roleMap = await upsertSystemRoles();
  const plainPassword = await seedSingleAdmin(roleMap);

  const countsAfter = await getCollectionCounts();
  printCounts('Counts AFTER wipe + minimal seed', countsAfter);

  const userCount = await User.countDocuments();
  if (userCount !== 1) {
    throw new Error(`Expected exactly 1 user after wipe, found ${userCount}.`);
  }

  await disconnectDatabase();

  console.log('\n' + '='.repeat(72));
  console.log('  WIPE COMPLETE — SAVE THIS PASSWORD NOW (shown once, not stored in repo)');
  console.log('='.repeat(72));
  console.log(`  Admin email:    ${ADMIN_EMAIL}`);
  console.log(`  Admin password: ${plainPassword}`);
  console.log('='.repeat(72));
  console.log('\nKept: holidays, officesettings');
  console.log('Wiped: all other collections (see log above)');
  console.log('Seeded: all 4 system roles + one admin user');
}

wipeKeepHolidaysGeo().catch(async (error) => {
  console.error(error);
  try {
    await disconnectDatabase();
  } catch {
    // ignore disconnect errors during failure cleanup
  }
  process.exit(1);
});
