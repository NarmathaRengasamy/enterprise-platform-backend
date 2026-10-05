import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';
import { LANGUAGES } from '../types/productType.types.js';

/**
 * All of a tenant's settings, in one document (collection `tenant_settings`).
 *
 * Two groups share it:
 *   - Site settings — moved here from the old `sitesettings` collection. Their
 *     field names are kept exactly as they were (camelCase) so the Settings
 *     page, `/settings/site` and `/public/settings` do not change.
 *   - Business settings — new for the product module (design §6.2), snake_case.
 *
 * There is only ever one row. `singleton` is a constant with a unique index,
 * and every write is an upsert onto it, so a second row cannot appear.
 */
export const TENANT_SETTINGS_KEY = 'tenant';

const LabelSchema = new Schema(
  {
    plural: { type: String, required: true, trim: true },
    singular: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const TenantSettingsSchema = new Schema({
  singleton: { type: String, required: true, default: TENANT_SETTINGS_KEY, immutable: true },

  /* ---- Site settings (unchanged names) ---- */
  siteName: { type: String, default: 'OmniFlow', trim: true },
  legalName: { type: String, default: '', trim: true },
  tagline: { type: String, default: 'Perfox Assistant', trim: true },
  logoUrl: { type: String, default: '' },
  faviconUrl: { type: String, default: '' },
  businessType: { type: String, default: '' },
  /* Sparse: only renamed modules are stored; the rest fall back to defaults on read. */
  labels: { type: Map, of: LabelSchema, default: () => ({}) },
  /* Email of whoever last saved the site settings — what the Settings page shows. */
  updatedBy: { type: String, default: '' },

  /* ---- Business settings (new) ---- */
  business_category: { type: String, default: null },
  /* Flat by default; the Admin can switch the category tree on (R11). */
  category_mode: { type: String, enum: ['flat', 'tree'], default: 'flat' },
  active_product_type_id: { type: String, default: null },
  timezone: { type: String, default: 'Asia/Kolkata' },
  default_currency: { type: String, default: 'INR' },
  languages: { type: [{ type: String, enum: LANGUAGES }], default: ['en'] },
});

TenantSettingsSchema.plugin(basePlugin);
TenantSettingsSchema.index({ singleton: 1 }, { unique: true });

export const TenantSettingsModel =
  mongoose.models.TenantSettings || mongoose.model('TenantSettings', TenantSettingsSchema, 'tenant_settings');
