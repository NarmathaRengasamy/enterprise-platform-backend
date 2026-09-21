import mongoose, { Schema } from 'mongoose';
import { Category } from '../types/index.js';

const CategorySchema = new Schema<Category>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    description: { type: String, default: '' },
    productsCount: { type: Number, default: 0 },
    updated: { type: String, default: 'Just now' },
    icon: { type: String, default: 'category' },
    color: { type: String, default: 'primary' },
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

export const CategoryModel = mongoose.models.Category || mongoose.model<Category>('Category', CategorySchema);
