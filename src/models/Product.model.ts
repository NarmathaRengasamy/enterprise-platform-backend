import mongoose, { Schema } from 'mongoose';
import { Product } from '../types/index.js';

/* `_id: false` — an axis is a value, not a row of its own. */
const VariantAttributeSchema = new Schema(
  { name: { type: String, required: true }, value: { type: String, required: true } },
  { _id: false }
);

const ProductVariantSchema = new Schema(
  {
    /* Identity. Without it a variant cannot be linked to or ordered. */
    variantId: { type: String },
    sku: { type: String },
    /* The real definition of the combination; option/value are derived from it. */
    attributes: { type: [VariantAttributeSchema], default: undefined },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    option: { type: String, required: true },
    value: { type: String, required: true },
    /* Optional: a variant can exist before it is priced. */
    price: { type: Number },
    /* No default. '10 units' was invented for every variant nobody gave a
       figure for, so a row could read "Unspecified" and "10 units" at once,
       and the product roll-up disagreed with the variants underneath it. */
    stock: { type: String },
    status: {
      type: String,
      enum: ['In Stock', 'Low Stock', 'Out of Stock', 'Unspecified'],
      default: 'Unspecified',
    },
  },
  { _id: false }
);

const ProductSchema = new Schema<Product>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    shortName: { type: String, default: '' },
    sku: { type: String, required: true, unique: true, index: true },
    /* Foreign key to Category.id — the single source of truth for a product's
       classification. Every write resolves it against the categories collection. */
    categoryId: { type: String, required: true, index: true },
    /* Denormalised category name, maintained by the server so list and detail
       views render without a join. Never accepted from a client. */
    category: { type: String, required: true, index: true },
    /* Deprecated: kept as a mirror of categoryId for older clients. */
    categoryCode: { type: String, default: 'general' },
    /* Optional: an offering can be created before it is priced. */
    price: { type: Number },
    originalPrice: { type: Number },
    /* No default: unset stock means UNKNOWN, and 0 reads as sold out. */
    stock: { type: Number },
    /* Defaults to Unspecified, not In Stock: with no figure entered the
       honest label is that nobody has said. */
    stockStatus: {
      type: String,
      enum: ['In Stock', 'Low Stock', 'Out of Stock', 'Unspecified'],
      default: 'Unspecified',
    },
    committed: { type: Number, default: 0 },
    reorderPoint: { type: Number, default: 0 },
    margin: { type: String, default: '30%' },
    discount: { type: String, default: '' },
    image: { type: String, default: '' },
    description: { type: String, default: '' },
    gallery: [{ id: Number, label: String, src: String }],
    videos: [{ id: Number, duration: String, title: String, thumbnail: String }],
    variants: [ProductVariantSchema],
    createdAt: { type: String, default: () => new Date().toISOString() },
    updatedAt: { type: String, default: () => new Date().toISOString() },
  },
  {
    timestamps: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const ProductModel = mongoose.models.Product || mongoose.model<Product>('Product', ProductSchema);
