import bcrypt from 'bcryptjs';
import { isDbConnected } from '../config/db.js';
import { UserModel } from '../models/User.model.js';
import { store } from './store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Migrations');

/* Documented in .env.example; only ever applied to rows with no usable hash. */
const DEFAULT_DEV_PASSWORD = 'password123';
/* A real bcrypt hash is exactly 60 characters: $2a$ + cost + $ + 53. */
const VALID_BCRYPT = /^\$2[aby]\$\d{2}\$.{53}$/;

/**
 * Gives existing products the `categoryId` foreign key by matching their old
 * free-text category name to a real category.
 *
 * Idempotent — only rows still missing the key are touched, so it is safe on
 * every boot and becomes a no-op once the data is clean.
 */
export const backfillCategoryIds = async (): Promise<void> => {
  try {
    const { linked, orphans } = await store.backfillProductCategoryIds();

    if (linked) log.log(`Backfilled categoryId on ${linked} product(s)`);
    else log.debug('Every product already carries a categoryId');

    if (orphans.length) {
      /* Left untouched rather than guessed at — assigning the wrong category
         silently is worse than leaving the row visible and unlinked. */
      log.warn(
        `${orphans.length} product(s) have a category name matching no category — left unlinked`,
        { products: orphans }
      );
    }
  } catch (error) {
    /* A failed migration must not stop the service from serving requests. */
    log.error(`categoryId backfill failed: ${(error as Error).message}`, (error as Error).stack);
  }
};

/**
 * Repairs accounts that hold no usable password hash.
 *
 * The seeded rows carry either nothing or the literal placeholder
 * `$2a$10$YourHashedPasswordPlaceholderOrPlainMatch`, which is not a valid
 * bcrypt hash. They only ever "worked" because login compared against a
 * hardcoded master password; with that removed, nobody could sign in at all.
 *
 * Development convenience — set SEED_ON_BOOT=false in any shared environment.
 */
export const repairUnusablePasswords = async (): Promise<void> => {
  if ((process.env.SEED_ON_BOOT ?? 'true').toLowerCase() === 'false') {
    log.debug('SEED_ON_BOOT is false — skipping the password repair');
    return;
  }

  try {
    if (!isDbConnected()) {
      log.debug('No database connection — skipping the password repair');
      return;
    }

    /* '+password' alone keeps every other field; naming extra fields alongside
       it would turn this into an inclusion projection and drop `id`. */
    const users = await UserModel.find().select('+password').lean();
    const broken = users.filter((u: any) => !u.password || !VALID_BCRYPT.test(u.password));
    if (!broken.length) return;

    const hash = await bcrypt.hash(DEFAULT_DEV_PASSWORD, 10);
    await UserModel.updateMany(
      { id: { $in: broken.map((u: any) => u.id) } },
      { password: hash }
    );

    log.warn(
      `Repaired ${broken.length} account(s) that held no usable password hash — ` +
        `each can now sign in with "${DEFAULT_DEV_PASSWORD}"`,
      { emails: broken.map((u: any) => u.email) }
    );
    log.warn('Change those passwords, or set SEED_ON_BOOT=false, before sharing this environment');
  } catch (error) {
    log.error(`Password repair failed: ${(error as Error).message}`, (error as Error).stack);
  }
};

export const runMigrations = async (): Promise<void> => {
  await repairUnusablePasswords();
  await backfillCategoryIds();
};
