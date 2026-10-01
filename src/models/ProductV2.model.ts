import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';
import { FULFILMENTS, TRACKINGS } from '../types/productType.types.js';

/**
 * Products in the new product module (design §3.3, §6.2 `products`).
 *
 * A product holds what its variants share; every sellable variant is an item
 * (`product_items`) with its own permanent id. Stored in `products_v2` beside
 * the old `products` until the Phase 5 cut-over renames it.
 */

const TranslatedSchema = new Schema(
  { en: { type: String, required: true, trim: true }, ta: { type: String, trim: true }, hi: { type: String, trim: true } },
  { _id: false }
);

/* Values are typed by the attribute library, so the value itself is mixed. */
export const AttributeValueSchema = new Schema({ key: { type: String, required: true }, value: { type: Schema.Types.Mixed } }, { _id: false });

/* Purchase limits (R50): every value optional — null = no limit (product) or
   "the product's value" (item). Checked by limits.service (R51). */
export const PurchaseLimitsSchema = new Schema(
  {
    min_per_order: { type: Number, default: null },
    max_per_order: { type: Number, default: null },
    per_customer: {
      type: new Schema(
        {
          day: { type: Number, default: null },
          week: { type: Number, default: null },
          month: { type: Number, default: null },
          year: { type: Number, default: null },
          lifetime: { type: Number, default: null },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
  },
  { _id: false }
);

export const MediaSchema = new Schema(
  {
    url: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video'], default: 'image' },
    alt: { type: String, default: '' },
    sort_order: { type: Number, default: 0 },
  },
  { _id: false }
);

const ProductV2Schema = new Schema({
  slug: { type: String, required: true, trim: true },
  name: { type: TranslatedSchema, required: true },
  description: { type: TranslatedSchema },
  brand: { type: String, default: '', trim: true },

  product_type_id: { type: String, required: true },
  type_version: { type: Number, required: true },

  /* Several categories (R15a); the primary is one of them, first chosen by default. */
  category_ids: { type: [String], default: [] },
  primary_category_id: { type: String, default: null },

  /* Values for the basic fields and any library attributes picked for this product. */
  attributes: { type: [AttributeValueSchema], default: [] },
  /* The choice attributes, and their options, this product's items are built from.
     A measured-size axis (R45) holds amounts with a unit, e.g. { amount: 500, unit: "ml" }. */
  variant_axes: {
    type: [new Schema({ key: { type: String, required: true }, values: { type: [Schema.Types.Mixed], default: [] } }, { _id: false })],
    default: [],
  },

  /* R13a–R13c: set on the product, pre-filled from the product type. */
  track_inventory: { type: Boolean, required: true },
  tracking: { type: String, enum: [...TRACKINGS, null], default: null },
  fulfilment: { type: String, enum: [...FULFILMENTS, null], default: null },

  hsn_code: { type: String, default: null },
  sac_code: { type: String, default: null },
  gst_rate: { type: Number, default: null },

  media: { type: [MediaSchema], default: [] },
  option_media: {
    type: [
      new Schema(
        { attribute_key: { type: String, required: true }, value: { type: String, required: true }, media: { type: [MediaSchema], default: [] } },
        { _id: false }
      ),
    ],
    default: [],
  },

  /* R50: null = no limits. Items may override each value. */
  purchase_limits: { type: PurchaseLimitsSchema, default: null },

  is_bundle: { type: Boolean, default: false },
  /* Lowest price among active items, kept by the system; null = nothing priced. */
  min_price_minor: { type: Number, default: null },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' },
});

ProductV2Schema.plugin(basePlugin);

/* Unique among live products only: a deleted slug can be reused. */
ProductV2Schema.index({ slug: 1 }, { unique: true, partialFilterExpression: { is_deleted: false } });
ProductV2Schema.index({ status: 1, category_ids: 1, min_price_minor: 1 });
ProductV2Schema.index({ 'attributes.key': 1, 'attributes.value': 1 });
/* Tamil and Hindi have no stemmer: "none" splits on whitespace and matches whole words in any language. */
ProductV2Schema.index(
  { 'name.en': 'text', 'name.ta': 'text', 'name.hi': 'text', brand: 'text' },
  { name: 'product_text', default_language: 'none', weights: { 'name.en': 5, 'name.ta': 5, 'name.hi': 5, brand: 2 } }
);

export const ProductV2Model = mongoose.models.ProductV2 || mongoose.model('ProductV2', ProductV2Schema, 'products_v2');
