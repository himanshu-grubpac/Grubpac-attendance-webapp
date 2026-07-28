/**
 * Idempotent seed for India company holidays (2026 and 2027 only).
 * Does NOT wipe office geo or other data.
 *
 * Usage: npm run seed:holidays
 */
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { seedIndiaHolidays, getSeedYears } from './services/holidaySeedService.js';

async function run() {
  await connectDatabase();
  const years = getSeedYears();
  console.log(`Seeding India company holidays for: ${years.join(', ')}`);
  const summary = await seedIndiaHolidays({ years });
  console.log(JSON.stringify(summary, null, 2));
  await disconnectDatabase();
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
