/**
 * CLI entry for scheduled leave jobs (accrual, year-end carry-forward).
 *
 * Usage:
 *   node scripts/run-jobs.mjs accrual
 *   node scripts/run-jobs.mjs carry-forward --year=2025
 */
import { connectDatabase, disconnectDatabase } from '../server/src/config/db.js';
import {
  runMonthlyAccrualJob,
  runYearEndCarryForwardJob,
} from '../server/src/jobs/leaveJobs.js';

const [command, ...rest] = process.argv.slice(2);

function parseYearArg(args) {
  const match = args.find((item) => item.startsWith('--year='));
  if (!match) return undefined;
  return Number(match.slice('--year='.length));
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: node scripts/run-jobs.mjs <accrual|carry-forward> [--year=YYYY]');
    process.exit(command ? 0 : 1);
  }

  await connectDatabase();

  try {
    if (command === 'accrual') {
      const result = await runMonthlyAccrualJob();
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }

    if (command === 'carry-forward') {
      const year = parseYearArg(rest) ?? new Date().getFullYear() - 1;
      if (!Number.isInteger(year) || year < 2000) {
        throw new Error('Invalid --year. Example: --year=2025');
      }
      const result = await runYearEndCarryForwardJob(year);
      console.log(JSON.stringify({ ok: true, job: 'carry-forward', ...result }, null, 2));
      return;
    }

    throw new Error(`Unknown job: ${command}`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
