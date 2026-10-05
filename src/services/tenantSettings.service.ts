import { SITE_SETTINGS_ID, SiteSettingsModel } from '../models/SiteSettings.model.js';
import { TENANT_SETTINGS_KEY, TenantSettingsModel } from '../models/TenantSettings.model.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TenantSettings');

/** The site-settings fields, moved from `sitesettings` with their names unchanged. */
export const SITE_FIELDS = [
  'siteName',
  'legalName',
  'tagline',
  'logoUrl',
  'faviconUrl',
  'businessType',
  'labels',
  'updatedBy',
] as const;

const FILTER = { singleton: TENANT_SETTINGS_KEY };

export const tenantSettingsService = {
  /**
   * The settings document, or an unsaved one holding the defaults.
   *
   * Reading never writes: a fresh workspace answers with defaults rather than
   * creating a row as a side effect of someone opening a page.
   */
  async get(): Promise<any> {
    return (await TenantSettingsModel.findOne(FILTER)) ?? new TenantSettingsModel({});
  },

  /** Upsert onto the single row. `set` / `unset` are Mongo update paths. */
  async update(set: Record<string, unknown>, unset: Record<string, ''> = {}): Promise<any> {
    return TenantSettingsModel.findOneAndUpdate(
      FILTER,
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
  },
};

/**
 * One-time copy of the old `sitesettings` row into `tenant_settings`.
 *
 * Runs on every boot and does nothing once `tenant_settings` has a row, so it
 * is idempotent. The old collection is left in place — untouched — so a
 * rollback to the previous release still finds its data.
 */
export const migrateSiteSettingsToTenantSettings = async (): Promise<'migrated' | 'skipped' | 'nothing'> => {
  if (await TenantSettingsModel.exists(FILTER)) return 'skipped';

  const old = await SiteSettingsModel.findOne({ id: SITE_SETTINGS_ID }).lean<any>();
  if (!old) return 'nothing';

  const copy: Record<string, unknown> = {};
  for (const key of SITE_FIELDS) {
    if (old[key] !== undefined) copy[key] = old[key];
  }
  /* The old row's own save time is kept, so "last updated" does not jump to
     the moment of the migration — hence saving with timestamps off. */
  const when = old.updatedAt ? new Date(old.updatedAt) : new Date();
  await new TenantSettingsModel({ ...copy, created_at: when, updated_at: when }).save({ timestamps: false });
  log.log('Copied site settings into tenant_settings (sitesettings left untouched)');
  return 'migrated';
};
