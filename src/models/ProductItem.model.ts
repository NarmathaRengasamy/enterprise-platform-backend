import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';
import { AttributeValueSchema, MediaSchema, PurchaseLimitsSchema } from './ProductV2.model.js';

/**
 * Items — the sellable variants of a product (design §3.3, §6.2).
 *
 * The id is permanent (R16, R21): an edit updates an item in place and never
 * re-creates it, so prices, orders and AI answers that point at it stay valid.
 */

export const PRICE_UNITS = ['each', 'hour', 'day', 'month'] as const;
export const DIGITAL_DELIVERIES = ['download', 'licence', 'link'] as const;

const PriceSchema = new Schema(
  {
    /* Paise — never a decimal (R22). */
    amount_minor: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    tax_inclusive: { type: Boolean, default: true },
    price_unit: { type: String, enum: PRICE_UNITS, default: 'each' },
  },
  { _id: false }
);

/* A measured size (R45), e.g. { 1, "l", 1000 }: base_amount is in the family's
   base unit (g · ml · cm · piece). Price per unit is worked out from it, never stored (R46). */
const MeasureSchema = new Schema(
  {
    amount: { type: Number, required: true },
    unit: { type: String, required: true },
    base_amount: { type: Number, required: true },
  },
  { _id: false }
);

/* A pack (R47): this item is `quantity` × the base item, e.g. "Box of 4" socks.
   It has its own SKU, price and tax, but no stock: its availability comes from the base (R48). */
const PackOfSchema = new Schema(
  {
    base_item_id: { type: String, required: true },
    quantity: { type: Number, required: true },
  },
  { _id: false }
);

const ProductItemSchema = new Schema({
  product_id: { type: String, required: true },
  sku: { type: String, required: true, trim: true },
  /* This item's combination of the product's variant options. */
  attributes: { type: [AttributeValueSchema], default: [] },
  /* Sorted `key=value` pairs joined with "|": one item per combination (R20). */
  attribute_signature: { type: String, default: '' },

  /* Set for a pack (R47); null for a normal item. */
  pack_of: { type: PackOfSchema, default: null },

  /* Set when the product has a measured-size variant option; null otherwise. */
  measure: { type: MeasureSchema, default: null },

  /* null = the product's Track inventory (R13a). */
  track_inventory: { type: Boolean, default: null },

  /* null = "not priced" (R27), never ₹0. */
  price: { type: PriceSchema, default: null },
  compare_at_minor: { type: Number, default: null },
  gst_rate: { type: Number, default: null },
  hsn_code: { type: String, default: null },
  digital_delivery: { type: String, enum: [...DIGITAL_DELIVERIES, null], default: null },
  media: { type: [MediaSchema], default: [] },
  /* R50: this item's own limits; each null value = the product's value. */
  purchase_limits: { type: PurchaseLimitsSchema, default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  sort_order: { type: Number, default: 0 },
});

ProductItemSchema.plugin(basePlugin);

ProductItemSchema.index({ sku: 1 }, { unique: true, partialFilterExpression: { is_deleted: false } });
ProductItemSchema.index(
  { product_id: 1, attribute_signature: 1 },
  { unique: true, partialFilterExpression: { is_deleted: false } }
);
ProductItemSchema.index({ 'attributes.key': 1, 'attributes.value': 1, status: 1 });
ProductItemSchema.index({ product_id: 1, status: 1 });
/* "Does this item have live packs?" (delete guard, R49). */
ProductItemSchema.index({ 'pack_of.base_item_id': 1 });
/* Size sort and size range filter (R46). */
ProductItemSchema.index({ product_id: 1, 'measure.base_amount': 1 });

export const ProductItemModel =
  mongoose.models.ProductItem || mongoose.model('ProductItem', ProductItemSchema, 'product_items');
