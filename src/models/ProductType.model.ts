import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';
import { FIELD_TYPES, FULFILMENTS, TRACKINGS } from '../types/productType.types.js';
import { UNIT_FAMILIES } from '../utils/units.util.js';

/**
 * The tenant's product type (design §6.2 `product_types`).
 *
 * Exactly one is active per tenant (R1). It is created from the template of the
 * business category chosen in Site Settings, then extended with the admin's own
 * attributes. Field definitions live inside it as an array because they are
 * always read and versioned together — `type_version` moves when any of them does.
 */

const TranslatedSchema = new Schema(
  { en: { type: String, required: true, trim: true }, ta: { type: String, trim: true }, hi: { type: String, trim: true } },
  { _id: false }
);

const OptionSchema = new Schema(
  {
    value: { type: String, required: true },
    label: { type: TranslatedSchema, required: true },
    deprecated: { type: Boolean, default: false },
  },
  { _id: false }
);

const FieldSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: TranslatedSchema, required: true },
    type: { type: String, enum: FIELD_TYPES, required: true },
    unit: { type: String },
    /* Number fields only: makes it usable as a measured-size variant option (R45). */
    unit_family: { type: String, enum: UNIT_FAMILIES },
    min: { type: Number },
    max: { type: Number },
    options: { type: [OptionSchema], default: [] },
    variant_forming: { type: Boolean, default: false },
    filterable: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    group: { type: String },
    sort_order: { type: Number, default: 0 },
    source: { type: String, enum: ['template', 'custom'], required: true },
    deprecated: { type: Boolean, default: false },
    added_in_version: { type: Number, default: 1 },
  },
  { _id: false }
);

const ProductTypeSchema = new Schema({
  code: { type: String, required: true, trim: true },
  name: { type: TranslatedSchema, required: true },
  template_code: { type: String, required: true },
  template_version: { type: Number, required: true },
  /* +1 on every field change; products record the version they were validated against. */
  type_version: { type: Number, default: 1 },
  fulfilment: { type: String, enum: FULFILMENTS, default: 'goods' },
  tracking: { type: String, enum: TRACKINGS, default: 'none' },
  fields: { type: [FieldSchema], default: [] },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
});

ProductTypeSchema.plugin(basePlugin);

/* Unique among live types only: a replaced type is soft-deleted and its code
   may be reused by the next one. */
ProductTypeSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { is_deleted: false } });

export const ProductTypeModel =
  mongoose.models.ProductType || mongoose.model('ProductType', ProductTypeSchema, 'product_types');
