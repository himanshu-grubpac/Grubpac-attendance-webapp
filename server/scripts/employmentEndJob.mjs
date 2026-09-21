import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { runEmploymentEndJob } from '../src/jobs/employmentEndJob.js';

async function run() {
  await connectDatabase();
  const result = await runEmploymentEndJob();
  console.log(JSON.stringify(result, null, 2));
  await disconnectDatabase();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
