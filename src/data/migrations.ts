import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { isDbConnected } from '../config/db.js';
import { UserModel } from '../models/User.model.js';
import { AIAgentModel } from '../models/Agent.model.js';
import { ProductModel } from '../models/Product.model.js';
import { PlatformConnectionModel } from '../models/PlatformConnection.model.js';
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


/* Fields the agent document used to carry. Some were invented with no source
   (`totalCalls`, `avgLatency`, `model`), some duplicated Perfox's own data
   (`workflowId`, `channel`), some were presentation stored in the database
   (`statusColor`), and the rest were local widget configuration that no longer
   has anywhere to be set. */
const RETIRED_AGENT_FIELDS = [
  'workflowId',
  'channel',
  'model',
  'siteKey',
  'secretKey',
  'accentColor',
  'position',
  'statusColor',
  'totalCalls',
  'avgLatency',
  'assignedEndpoints',
  'createdAt',
  '__v',
];

/**
 * Drops the retired fields from agent documents written before the schema was
 * trimmed. Mongoose ignores unknown fields on read, so they would otherwise sit
 * in the collection indefinitely.
 *
 * Idempotent: once the fields are gone the query matches nothing.
 */
export const dropRetiredAgentFields = async (): Promise<void> => {
  try {
    if (!isDbConnected()) {
      log.debug('No database connection — skipping the agent field cleanup');
      return;
    }

    const result = await AIAgentModel.collection.updateMany(
      { $or: RETIRED_AGENT_FIELDS.map((field) => ({ [field]: { $exists: true } })) },
      { $unset: Object.fromEntries(RETIRED_AGENT_FIELDS.map((field) => [field, ''])) }
    );

    if (result.modifiedCount) {
      log.log(`Removed retired fields from ${result.modifiedCount} agent document(s)`);
    } else {
      log.debug('No agent documents carry the retired fields');
    }
  } catch (error) {
    log.error(`Agent field cleanup failed: ${(error as Error).message}`);
  }
};

/* The flat columns this replaced, in the order they map onto the subdocument. */
/* Every shape the knowledge-base folder was ever stored in on the platform
   connection. The folder is now chosen per upload, so none of them belong on
   this record any more. */
const RETIRED_PLATFORM_KB_FIELDS = [
  'kbFolder',
  'kbFolderId',
  'kbFolderName',
  'kbFolderPath',
  'kbFolderSelectedAt',
];

/**
 * Drops the stored knowledge-base folder from the platform connection.
 *
 * Files are now uploaded to a folder picked at the time, or to the root, so a
 * fixed folder on the connection is configuration that nothing reads. Mongoose
 * ignores unknown fields on read, so it would otherwise sit there indefinitely.
 *
 * Idempotent: once the fields are gone the query matches nothing.
 */
export const dropPlatformKbFolder = async (): Promise<void> => {
  try {
    if (!isDbConnected()) {
      log.debug('No database connection — skipping the platform folder cleanup');
      return;
    }

    const result = await PlatformConnectionModel.collection.updateMany(
      { $or: RETIRED_PLATFORM_KB_FIELDS.map((field) => ({ [field]: { $exists: true } })) },
      { $unset: Object.fromEntries(RETIRED_PLATFORM_KB_FIELDS.map((f) => [f, ''])) }
    );

    if (result.modifiedCount) {
      log.log(`Removed the stored knowledge-base folder from ${result.modifiedCount} connection(s)`);
    } else {
      log.debug('No platform connection stores a knowledge-base folder');
    }
  } catch (error) {
    log.error(`Platform folder cleanup failed: ${(error as Error).message}`);
  }
};

/**
 * Drops the seeded `articles` and `collections` collections.
 *
 * The knowledge base is the Perfox workspace; these held demo rows that never
 * corresponded to anything real there.
 */
export const dropMockKnowledgeArticles = async (): Promise<void> => {
  try {
    if (!isDbConnected()) {
      log.debug('No database connection — skipping the mock article cleanup');
      return;
    }

    const db = mongoose.connection.db;
    if (!db) return;

    const present = await db.listCollections().toArray();
    const names = new Set(present.map((c) => c.name));

    for (const name of ['articles', 'collections']) {
      if (!names.has(name)) continue;
      const count = await db.collection(name).countDocuments();
      await db.collection(name).drop();
      log.log(`Dropped the mock "${name}" collection (${count} document(s))`);
    }
  } catch (error) {
    log.error(`Mock article cleanup failed: ${(error as Error).message}`);
  }
};

/**
 * Gives every existing variant the identity and attributes the new shape needs.
 *
 * An old variant is `{ option: 'Colour', value: 'Ocean Blue' }` — one axis
 * already, just written as a label. It becomes a single-entry `attributes`
 * array plus a `variantId` and a `sku`, so old rows are queryable the same way
 * new ones are and nothing has to special-case them.
 *
 * Idempotent: only variants missing `attributes` are touched.
 */
export const backfillVariantIdentity = async (): Promise<void> => {
  try {
    if (!isDbConnected()) {
      log.debug('No database connection — skipping the variant backfill');
      return;
    }

    const slug = (text: string): string =>
      String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);

    const products = await ProductModel.find({
      'variants.0': { $exists: true },
      'variants.attributes': { $exists: false },
    }).lean();

    let touched = 0;
    for (const product of products as any[]) {
      const variants = (product.variants ?? []).map((v: any, index: number) => {
        if (Array.isArray(v?.attributes) && v.attributes.length) return v;

        const name = String(v?.option ?? 'Option').trim() || 'Option';
        const value = String(v?.value ?? 'Standard').trim() || 'Standard';
        const base = String(product.sku ?? product.id ?? 'PRD');

        return {
          ...v,
          attributes: [{ name, value }],
          variantId: v?.variantId || `${base}-${slug(value) || index + 1}`,
          sku: v?.sku || `${base}-${index + 1}`,
        };
      });

      await ProductModel.updateOne({ _id: product._id }, { $set: { variants } });
      touched += 1;
    }

    if (touched) {
      log.log(`Backfilled variant identity on ${touched} product(s)`);
    } else {
      log.debug('Every variant already carries attributes');
    }
  } catch (error) {
    log.error(`Variant backfill failed: ${(error as Error).message}`);
  }
};

export const runMigrations = async (): Promise<void> => {
  await repairUnusablePasswords();
  await backfillCategoryIds();
  await dropRetiredAgentFields();
  await backfillVariantIdentity();
  await dropPlatformKbFolder();
  await dropMockKnowledgeArticles();
};
