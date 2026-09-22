import { connectDB, disconnectDB } from '../config/db.js';
import { seedDatabase } from '../data/dbSeeder.js';

/**
 * Loads the demo data on purpose — `npm run seed`.
 *
 * This used to run on every boot, which meant a collection you had emptied
 * deliberately refilled itself on the next restart. Seeding is now something
 * you ask for.
 *
 * Still only fills collections that are empty, so it will not duplicate or
 * overwrite rows you already have.
 */
const run = async () => {
  await connectDB();
  await seedDatabase();
  await disconnectDB();
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  });
