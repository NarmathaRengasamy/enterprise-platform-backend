import mongoose, { Schema } from 'mongoose';
import { Article } from '../types/index.js';

const ArticleSchema = new Schema<Article>(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    categoryColor: { type: String, default: 'primary' },
    readTime: { type: String, default: '3 min read' },
    visibility: {
      type: String,
      enum: ['Public article', 'Pinned', 'Internal & Public', 'Internal only'],
      default: 'Public article',
    },
    updated: { type: String, default: 'Just now' },
    icon: { type: String, default: 'description' },
    iconBg: { type: String, default: 'bg-primary-container/10 text-primary' },
    catBg: { type: String, default: 'bg-surface-container text-primary' },
    views: { type: Schema.Types.Mixed, default: '1' },
    content: { type: String, default: '' },
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

export const ArticleModel = mongoose.models.Article || mongoose.model<Article>('Article', ArticleSchema);
