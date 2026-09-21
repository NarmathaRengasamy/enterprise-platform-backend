import mongoose, { Schema } from 'mongoose';
import { Product } from '../types/index.js';

const ProductVariantSchema = new Schema(
  {
    option: { type: String, required: true },
    value: { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: String, default: '10 units' },
    status: { type: String, enum: ['In Stock', 'Low Stock', 'Out of Stock'], default: 'In Stock' },
  },
  { _id: false }
);

const ProductSchema = new Schema<Product>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    shortName: { type: String, default: '' },
    sku: { type: String, required: true, unique: true, index: true },
    category: { type: String, required: true, index: true },
    categoryCode: { type: String, default: 'general' },
    price: { type: Number, required: true },
    originalPrice: { type: Number },
    stock: { type: Number, default: 0 },
    stockStatus: { type: String, enum: ['In Stock', 'Low Stock', 'Out of Stock'], default: 'In Stock' },
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
