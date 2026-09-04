/**
 * Idempotent FAQ & Demo seed for staging / local dev (uses server/.env MONGODB_URI).
 *
 * Usage: node server/scripts/seed-demo-faq-staging.mjs
 * Re-run safe: removes prior items with seedTag then re-inserts.
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

const { connectDatabase, disconnectDatabase } = await import('../src/config/db.js');
const { DemoFaqItem } = await import('../src/models/DemoFaqItem.js');

const SEED_TAG = 'faq-demo-staging-v1';
const SEED_TITLES = [
  'How do I mark attendance from mobile?',
  'Team leave approval walkthrough',
  'HR policy: leave balance adjustments',
  'Where can I view my pay estimate?',
  'Employee onboarding checklist',
  'Admin dashboard overview',
  '[Inactive] Legacy WFH policy FAQ',
];

const SEED_ITEMS = [
  {
    type: 'FAQ',
    title: 'How do I mark attendance from mobile?',
    content:
      'Open the employee portal, tap Check-in on the dashboard, and allow location access when prompted. You must be within the office geofence.',
    contentKind: 'text',
    visibleRoles: [SYSTEM_ROLE_SLUGS.EMPLOYEE],
    sortOrder: 10,
  },
  {
    type: 'Demo Video',
    title: 'Team leave approval walkthrough',
    content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    contentKind: 'url',
    visibleRoles: [SYSTEM_ROLE_SLUGS.REPORTING_MANAGER],
    sortOrder: 20,
  },
  {
    type: 'Guide',
    title: 'HR policy: leave balance adjustments',
    content:
      'Admins and HR can adjust opening balances from Leave policies → employee carry-forward. Always add a note when correcting balances.',
    contentKind: 'text',
    visibleRoles: [SYSTEM_ROLE_SLUGS.ADMIN, SYSTEM_ROLE_SLUGS.HR],
    sortOrder: 30,
  },
  {
    type: 'FAQ',
    title: 'Where can I view my pay estimate?',
    content:
      'All staff can open Payroll → My pay estimate in the employee portal to see the current month breakdown.',
    contentKind: 'text',
    visibleRoles: [
      SYSTEM_ROLE_SLUGS.ADMIN,
      SYSTEM_ROLE_SLUGS.HR,
      SYSTEM_ROLE_SLUGS.REPORTING_MANAGER,
      SYSTEM_ROLE_SLUGS.EMPLOYEE,
    ],
    sortOrder: 40,
  },
  {
    type: 'Guide',
    title: 'Employee onboarding checklist',
    content:
      '1) Complete profile 2) Set password 3) Review leave balances 4) Read attendance policy in FAQ.',
    contentKind: 'text',
    visibleRoles: [SYSTEM_ROLE_SLUGS.EMPLOYEE],
    sortOrder: 50,
  },
  {
    type: 'Demo Video',
    title: 'Admin dashboard overview',
    content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    contentKind: 'url',
    visibleRoles: [SYSTEM_ROLE_SLUGS.ADMIN, SYSTEM_ROLE_SLUGS.HR],
    sortOrder: 60,
  },
  {
    type: 'FAQ',
    title: '[Inactive] Legacy WFH policy FAQ',
    content: 'This item is inactive and should not appear in role-filtered lists.',
    contentKind: 'text',
    visibleRoles: [SYSTEM_ROLE_SLUGS.EMPLOYEE],
    sortOrder: 99,
    isActive: false,
  },
];

async function verifyRoleFiltering() {
  const roles = Object.values(SYSTEM_ROLE_SLUGS);
  console.log('\n=== Role filter verification (active items only) ===');
  for (const roleSlug of roles) {
    const items = await DemoFaqItem.find({
      isActive: true,
      visibleRoles: roleSlug,
      title: { $in: SEED_TITLES },
    })
      .sort({ sortOrder: 1 })
      .select('title type visibleRoles');

    console.log(
      `${roleSlug}: ${items.length} item(s) — ${items.map((i) => i.title).join('; ') || '(none)'}`,
    );
  }
}

async function main() {
  const uri = process.env.MONGODB_URI ?? '';
  console.log('Target DB:', uri.replace(/:([^:@/]+)@/, ':***@'));

  await connectDatabase();

  const removed = await DemoFaqItem.deleteMany({ title: { $in: SEED_TITLES } });
  console.log(`Removed ${removed.deletedCount} prior seed item(s) (${SEED_TAG}).`);

  const created = await DemoFaqItem.insertMany(
    SEED_ITEMS.map((item) => ({
      ...item,
      isActive: item.isActive ?? true,
    })),
  );

  console.log(`Inserted ${created.length} FAQ & Demo seed item(s).`);
  created.forEach((item) => {
    console.log(
      `  • [${item.type}] ${item.title} → roles: ${item.visibleRoles.join(', ')}${item.isActive ? '' : ' (inactive)'}`,
    );
  });

  await verifyRoleFiltering();
  await disconnectDatabase();
  console.log('\nSeed complete.');
}

main().catch(async (error) => {
  console.error(error);
  try {
    await disconnectDatabase();
  } catch {
    // ignore
  }
  process.exit(1);
});

