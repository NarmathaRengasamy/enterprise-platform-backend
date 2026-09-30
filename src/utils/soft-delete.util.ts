import { Model } from 'mongoose';
import { AppError } from '../middlewares/errorHandler.js';
import { INCLUDE_DELETED } from '../models/plugins/base.plugin.js';

/**
 * Nothing in the product module is hard-deleted (design R35).
 *
 * A delete flags the row and keeps its id, so anything that referenced it — an
 * order line, a booking, an AI answer — can still resolve what it pointed at,
 * and a mistake can be undone. Both operations are idempotent: deleting a
 * deleted row or restoring a live one returns it unchanged.
 *
 * `deletedAt` is passed in when a cascade deletes several rows together, so a
 * later restore can bring back exactly the rows deleted with it.
 */

export const softDelete = async <T>(model: Model<T>, id: string, deletedAt = new Date()) => {
  const existing = await model.findOne({ id, ...INCLUDE_DELETED } as any);
  if (!existing) throw new AppError('Record not found', 404);
  if ((existing as any).is_deleted) return existing;

  (existing as any).set({ is_deleted: true, deleted_at: deletedAt });
  await (existing as any).save();
  return existing;
};

export const restore = async <T>(model: Model<T>, id: string) => {
  const existing = await model.findOne({ id, ...INCLUDE_DELETED } as any);
  if (!existing) throw new AppError('Record not found', 404);
  if (!(existing as any).is_deleted) return existing;

  (existing as any).set({ is_deleted: false, deleted_at: null });
  await (existing as any).save();
  return existing;
};
