import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';

/**
 * Categories for the new product module (design §3.2, §6.2 `categories`).
 *
 * A tree: `parent_id` points at another category, null for a root. Each
 * category may limit which attributes its products show; children inherit it.
 * Categories do not set fulfilment or tracking — those are product settings
 * (R13, Phase 2b).
 *
 * Stored in `categories_v2` while the old flat `categories` collection is still
 * used by the current product screens; renamed at the Phase 5 cut-over.
 */

const TranslatedSchema = new Schema(
  { en: { type: String, required: true, trim: true }, ta: { type: String, trim: true }, hi: { type: String, trim: true } },
  { _id: false }
);

const CatalogCategorySchema = new Schema({
  /* Stable: references use id or code, never the name (R14). */
  code: { type: String, required: true, trim: true, immutable: true },
  name: { type: TranslatedSchema, required: true },
  description: { type: TranslatedSchema },
  parent_id: { type: String, default: null },
  /* Empty = inherit from the parent (or all attributes at the root). */
  visible_field_keys: { type: [String], default: [] },
  sort_order: { type: Number, default: 0 },
  icon: { type: String, default: 'category' },
  color: { type: String, default: '' },
  status: { type: String, enum: ['active', 'hidden'], default: 'active' },
});

CatalogCategorySchema.plugin(basePlugin);

/* Unique among live categories only: a deleted code can be reused. */
CatalogCategorySchema.index({ code: 1 }, { unique: true, partialFilterExpression: { is_deleted: false } });
CatalogCategorySchema.index({ parent_id: 1, sort_order: 1 });

export const CatalogCategoryModel =
  mongoose.models.CatalogCategory || mongoose.model('CatalogCategory', CatalogCategorySchema, 'categories_v2');
