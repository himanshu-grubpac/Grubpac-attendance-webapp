/**
 * One-off grant: adds `emp.team_today.r` to the system Employee role so the
 * Team Attendance Today strip on the employee dashboard stops 403ing.
 *
 * Additive only — never removes or overwrites existing permissions (custom
 * roles and admin edits are left untouched). Safe to re-run (idempotent).
 *
 *   cd server
 *   node src/grantEmployeeTeamToday.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Role } from './models/Role.js';
import { SYSTEM_ROLE_SLUGS } from '../../shared/permissions.js';

const SLUG = 'emp.team_today.r';

function maskHost(uri = '') {
  const text = String(uri);
  const credentialed = text.match(/@([^/?]+)/);
  if (credentialed?.[1]) return credentialed[1];
  const bare = text.match(/mongodb(?:\+srv)?:\/\/([^/?]+)/);
  return bare?.[1] ?? '(not set — verify before running)';
}

export async function grantEmployeeTeamToday() {
  const role = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.EMPLOYEE });
  if (!role) {
    return { granted: false, reason: 'employee role not found' };
  }
  const permissions = Array.isArray(role.permissions) ? [...role.permissions] : [];
  if (permissions.includes(SLUG)) {
    return { granted: false, reason: 'already granted', count: permissions.length };
  }
  permissions.push(SLUG);
  role.permissions = [...new Set(permissions)].sort();
  await role.save();
  return { granted: true, slug: role.slug, count: role.permissions.length };
}

const invokedAsMain = (process.argv[1] ?? '').endsWith('grantEmployeeTeamToday.js');

if (invokedAsMain) {
  const uri = process.env.MONGODB_URI ?? '';
  if (!uri) {
    console.error(
      'MONGODB_URI is not set. Run from the server/ directory (loads server/.env).',
    );
    process.exit(1);
  }
  console.log(`Target host: ${maskHost(uri)}`);
  await mongoose.connect(uri);
  try {
    console.log(JSON.stringify(await grantEmployeeTeamToday(), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}
