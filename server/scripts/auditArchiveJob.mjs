import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { runAuditArchiveJob } from '../src/services/auditArchiveService.js';

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  await connectDatabase();
  const result = await runAuditArchiveJob({ dryRun });
  console.log(JSON.stringify(result, null, 2));
  await disconnectDatabase();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
