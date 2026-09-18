/**
 * Preprod only — set ADMIN_EMAIL user isActive=true.
 * Usage: node --env-file=.env.preprod src/activatePreprodAdmin.js
 */
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { User } from './models/User.js';
import { PREPROD_CLUSTER_HOST } from './wipePreprodDatabase.js';

function getMongoHost(uri) {
  try {
    return new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function main() {
  if (getMongoHost(env.mongoUri) !== PREPROD_CLUSTER_HOST) {
    console.error(`Refusing: preprod cluster only (expected ${PREPROD_CLUSTER_HOST}).`);
    process.exit(1);
  }

  await connectDatabase();
  const email = env.adminEmail.toLowerCase();
  const result = await User.updateOne({ email }, { $set: { isActive: true } });
  console.log(JSON.stringify({ email, matched: result.matchedCount, modified: result.modifiedCount }));
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  try { await disconnectDatabase(); } catch { /* ignore */ }
  process.exit(1);
});
