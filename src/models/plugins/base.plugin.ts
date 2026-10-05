import { Schema } from 'mongoose';
import { newId } from '../../utils/id.util.js';
import { currentUserId } from '../../utils/request-context.js';

/**
 * The fields and behaviour every product-module collection shares.
 *
 *   id                      UUIDv7, unique            (design R33)
 *   is_deleted, deleted_at  soft delete               (R35)
 *   created_at/by,
 *   updated_at/by           audit, UTC                (R36, R37)
 *
 * Reads hide soft-deleted rows automatically. A query or aggregate that says
 * anything about `is_deleted` itself is left alone — so to include deleted rows,
 * filter with `INCLUDE_DELETED` (or `{ is_deleted: true }` for deleted only).
 *
 * Hooks take no `next`: Mongoose 9 removed it, and a hook without it works on
 * every version.
 */

/** Spread into a filter (or a leading `$match`) to read deleted and live rows alike. */
export const INCLUDE_DELETED = Object.freeze({ is_deleted: { $in: [true, false] } });

const READ_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'countDocuments',
  'updateOne',
  'updateMany',
] as const;

const UPDATE_HOOKS = ['findOneAndUpdate', 'updateOne', 'updateMany'] as const;

const PROTECTED_ON_UPDATE = ['id', 'created_by', 'created_at'];

export interface BaseFields {
  id: string;
  is_deleted: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  updated_by: string;
}

export const basePlugin = (schema: Schema): void => {
  schema.add({
    id: { type: String, required: true, unique: true, default: newId, immutable: true },
    is_deleted: { type: Boolean, default: false, index: true },
    deleted_at: { type: Date, default: null },
    created_by: { type: String, immutable: true },
    updated_by: { type: String },
  });

  /* The real `id` field is the identity; Mongoose's own `id` virtual (a copy of
     _id) would shadow it. */
  schema.set('id', false);
  /* Stored as real Dates; Mongo keeps them in UTC. */
  schema.set('timestamps', { createdAt: 'created_at', updatedAt: 'updated_at' });
  schema.set('versionKey', false);

  const previous = (schema.get('toJSON') as any)?.transform;
  schema.set('toJSON', {
    virtuals: false,
    transform: (doc: any, ret: any, options: any) => {
      delete ret._id;
      delete ret.__v;
      return typeof previous === 'function' ? previous(doc, ret, options) : ret;
    },
  });

  schema.pre('save', function (this: any) {
    const actor = currentUserId();
    if (this.isNew && !this.get('created_by')) this.set('created_by', actor);
    this.set('updated_by', actor);
  });

  for (const hook of READ_HOOKS) {
    schema.pre(hook as any, function (this: any) {
      if (!('is_deleted' in (this.getFilter() ?? {}))) this.where({ is_deleted: false });
    });
  }

  for (const hook of UPDATE_HOOKS) {
    schema.pre(hook as any, function (this: any) {
      const update = this.getUpdate();
      /* An aggregation-pipeline update is left as written. */
      if (!update || Array.isArray(update)) return;
      for (const key of PROTECTED_ON_UPDATE) {
        delete update[key];
        if (update.$set) delete update.$set[key];
      }
      update.$set = { ...(update.$set ?? {}), updated_by: currentUserId() };
      this.setUpdate(update);
    });
  }

  schema.pre('aggregate', function (this: any) {
    const pipeline = this.pipeline();
    const first = pipeline[0];
    if (first?.$match && 'is_deleted' in first.$match) return;
    /* $geoNear and $search must stay the first stage. */
    const mustBeFirst = first && ('$geoNear' in first || '$search' in first);
    pipeline.splice(mustBeFirst ? 1 : 0, 0, { $match: { is_deleted: false } });
  });
};
