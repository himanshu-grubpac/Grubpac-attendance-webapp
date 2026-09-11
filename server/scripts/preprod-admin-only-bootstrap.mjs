/**
 * Pre-prod UAT: wipe entire DB, insert 4 system roles + exactly one admin user.
 * No office settings, leave types, departments, or demo users — tester creates those via portal.
 *
 * System roles are required so the client receives permissions (roleId.permissions).
 * Legacy admin with roleId null leaves the UI with an empty sidebar.
 *
 * Mongo: uses connectDatabase() from src/config/db.js (same as staging CLI scripts).
 * Requires MONGODB_URI in .env.preprod as mongodb+srv (see .env.preprod.example).
 *
 * Usage (from server/):
 *   node --env-file=.env.preprod scripts/preprod-admin-only-bootstrap.mjs
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { pinSchema } from '../../shared/validation/auth.js';
import { SYSTEM_ROLES, SYSTEM_ROLE_SLUGS } from '../../shared/permissions.js';

const PREPROD_MARKERS = ['attendance-preprod.wtj7gte', 'wtj7gte.mongodb.net'];
const FORBIDDEN_HOSTS = ['grubpac-attendance.uvcyogy', 'attendance-staging.ivyl6lu'];

const mongoUri = process.env.MONGODB_URI ?? '';
if (!PREPROD_MARKERS.some((m) => mongoUri.includes(m))) {
  console.error('Refusing: MONGODB_URI must be pre-prod cluster (wtj7gte / attendance-preprod).');
  process.exit(1);
}
for (const bad of FORBIDDEN_HOSTS) {
  if (mongoUri.includes(bad)) {
    console.error(`Refusing: MONGODB_URI must not contain ${bad}`);
    process.exit(1);
  }
}
if (!mongoUri.startsWith('mongodb+srv://')) {
  console.error('Refusing: use mongodb+srv URI in .env.preprod (same as staging). See .env.preprod.example.');
  process.exit(1);
}

const adminEmail = (process.env.ADMIN_EMAIL ?? 'preprod@grubpac.com').toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;
const adminPin = process.env.ADMIN_PIN ?? '1234';
const adminName = process.env.ADMIN_NAME ?? 'Grubpac Admin';

if (!adminPassword || adminPassword.includes('REPLACE_ME')) {
  console.error('Set ADMIN_PASSWORD in server/.env.preprod before running.');
  process.exit(1);
}

pinSchema.parse(adminPin);

await connectDatabase();
console.log('Connected: pre-prod (wtj7gte)');

const db = mongoose.connection.db;
const collections = (await db.listCollections().toArray())
  .map((c) => c.name)
  .filter((n) => !n.startsWith('system.'));
for (const name of collections) {
  await db.collection(name).deleteMany({});
}
console.log(`Wiped ${collections.length} existing collection(s).`);

const now = new Date();
const roleIds = new Map();

for (const seedRole of SYSTEM_ROLES) {
  const { insertedId } = await db.collection('roles').insertOne({
    name: seedRole.name,
    slug: seedRole.slug,
    description: seedRole.description ?? '',
    isSystem: true,
    permissions: seedRole.permissions,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });
  roleIds.set(seedRole.slug, insertedId);
  console.log(`Inserted system role: ${seedRole.name}`);
}

const adminRoleId = roleIds.get(SYSTEM_ROLE_SLUGS.ADMIN);
if (!adminRoleId) {
  console.error('Failed to create Admin system role.');
  process.exit(1);
}

const [firstName, ...rest] = adminName.trim().split(/\s+/);
const lastName = rest.join(' ') || firstName;

await db.collection('users').insertOne({
  role: 'admin',
  roleId: adminRoleId,
  firstName,
  lastName,
  name: adminName,
  email: adminEmail,
  mobile: '9999999999',
  designation: 'System Administrator',
  joiningDate: now,
  passwordHash: await bcrypt.hash(adminPassword, 12),
  pin4Hash: await bcrypt.hash(adminPin, 12),
  isActive: true,
  managedDepartmentIds: [],
  tokenVersion: 0,
  createdAt: now,
  updatedAt: now,
});

const userCount = await db.collection('users').countDocuments();
const roleCount = await db.collection('roles').countDocuments();
let totalDocs = 0;
const nonSystem = (await db.listCollections().toArray()).filter((c) => !c.name.startsWith('system.'));
for (const { name } of nonSystem) {
  totalDocs += await db.collection(name).countDocuments();
}

console.log(`Collections: ${nonSystem.map((c) => c.name).join(', ') || '(none)'}`);
console.log(`Total documents in DB: ${totalDocs} (expected 5: 4 roles + 1 user)`);
console.log(`Roles: ${roleCount} (expected 4)`);
console.log(`Users: ${userCount} (expected 1)`);

if (totalDocs !== 5 || userCount !== 1 || roleCount !== 4) {
  console.error('Bootstrap verification failed — expected 4 system roles and 1 admin user.');
  process.exit(1);
}

console.log('Pre-prod DB ready: system roles + one admin user (no demo org data).');
await disconnectDatabase();
