import mongoose, { Schema } from 'mongoose';
import { ModuleLabel } from '../config/modules.js';

/**
 * Workspace-wide settings.
 *
 * There is exactly **one** of these, pinned to a fixed id. A settings
 * collection that can hold two rows eventually holds two rows, and then every
 * read has to decide which one is real — so the id is not generated, it is a
 * constant, and every write is an upsert onto it.
 */
export const SITE_SETTINGS_ID = 'site';

export interface SiteSettings {
  id: string;

  /* Identity */
  siteName: string;
  legalName: string;
  tagline: string;
  /** Data URL or absolute URL. Empty means the built-in mark. */
  logoUrl: string;
  faviconUrl: string;

  /* Business */
  businessType: string;

  /**
   * Renamed navigation modules, keyed by module id.
   *
   * Sparse on purpose: only the ones actually changed are stored. Anything
   * absent falls back to the shipped default, so adding a new module later
   * does not need a migration, and "reset to default" is a delete rather than
   * a write.
   */
  labels: Record<string, ModuleLabel>;

  updatedAt?: Date;
  updatedBy?: string;
}

const SiteSettingsSchema = new Schema<SiteSettings>(
  {
    id: { type: String, required: true, unique: true, index: true, default: SITE_SETTINGS_ID },

    siteName: { type: String, default: 'OmniFlow', trim: true },
    legalName: { type: String, default: '', trim: true },
    tagline: { type: String, default: 'Perfox Assistant', trim: true },
    logoUrl: { type: String, default: '' },
    faviconUrl: { type: String, default: '' },

    businessType: { type: String, default: '' },

    labels: {
      type: Map,
      of: new Schema(
        {
          plural: { type: String, required: true, trim: true },
          singular: { type: String, required: true, trim: true },
        },
        { _id: false }
      ),
      default: () => ({}),
    },

    updatedBy: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
    toJSON: {
      transform: (_doc, ret: any) => {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const SiteSettingsModel =
  mongoose.models.SiteSettings ||
  mongoose.model<SiteSettings>('SiteSettings', SiteSettingsSchema, 'sitesettings');
