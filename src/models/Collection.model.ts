import mongoose, { Schema } from 'mongoose';
import { Collection } from '../types/index.js';

const CollectionSchema = new Schema<Collection>(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, index: true },
    description: { type: String, default: '' },
    articleCount: { type: Number, default: 0 },
    icon: { type: String, default: 'folder' },
    color: { type: String, default: 'blue' },
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

export const CollectionModel =
  mongoose.models.Collection || mongoose.model<Collection>('Collection', CollectionSchema);
