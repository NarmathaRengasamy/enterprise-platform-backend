import { Model } from 'mongoose';
import { AppError } from '../middlewares/errorHandler.js';

/**
 * Soft deletion helpers, shared by every v2 controller.
 *
 * Nothing in the catalogue is ever removed. An order line, a booking or a
 * report that points at a product still has to resolve years later, and a row
 * that vanished takes the history with it.
 */

export { randomUUID as newId } from 'node:crypto';

/**
 * Marks one row deleted, or 404s.
 *
 * Idempotent by construction: the filter excludes rows already deleted (via
 * the schema hook), so deleting twice reports "not found" rather than silently
 * rewriting the timestamp and losing when it actually happened.
 */
export const softDeleteOne = async (
  model: Model<any>,
  id: string,
  label: string,
  at: Date = new Date()
): Promise<Record<string, unknown>> => {
  const updated = await model.findOneAndUpdate(
    { id },
    { $set: { is_deleted: true, deletedAt: at } },
    { new: true }
  );
  if (!updated) throw new AppError(`${label} '${id}' not found`, 404);
  return updated.toJSON();
};

/** Marks many rows deleted. Used by the cascades; returns how many moved. */
export const softDeleteMany = async (
  model: Model<any>,
  filter: Record<string, unknown>,
  at: Date = new Date()
): Promise<number> => {
  /* Only rows that are still live. Re-stamping an already-deleted row would
     overwrite when it actually went, and a cascade restore keys off exactly
     that timestamp to know what it is allowed to bring back. */
  const result = await model.updateMany(
    { ...filter, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, deletedAt: at } }
  );
  return result.modifiedCount ?? 0;
};

/**
 * Reverses one cascade, and only that cascade.
 *
 * Matching on the parent's exact deletion timestamp is the point: an item the
 * user deleted deliberately last week was stamped with a different time, so
 * restoring the product leaves it deleted instead of silently resurrecting a
 * variant nobody asked for.
 */
export const restoreCascade = async (
  model: Model<any>,
  filter: Record<string, unknown>,
  at: Date
): Promise<number> => {
  const result = await model
    .updateMany(
      { ...filter, is_deleted: true, deletedAt: at },
      { $set: { is_deleted: false, deletedAt: null } }
    )
    .setOptions({ withDeleted: true });
  return result.modifiedCount ?? 0;
};

/**
 * Brings a deleted row back.
 *
 * A soft delete you cannot undo is just a slow hard delete — the point of
 * keeping the row is being able to reach it again.
 */
export const restoreOne = async (
  model: Model<any>,
  id: string,
  label: string
): Promise<Record<string, unknown>> => {
  /* `withDeleted` is required here: the default query filter hides exactly the
     row this is trying to find. */
  const row = await model
    .findOne({ id })
    .setOptions({ withDeleted: true });

  if (!row) throw new AppError(`${label} '${id}' not found`, 404);
  if (!row.is_deleted) throw new AppError(`${label} '${id}' is not deleted`, 409);

  row.is_deleted = false;
  row.deletedAt = null;
  await row.save();
  return row.toJSON();
};

/** True when the caller asked to see deleted rows too (`?includeDeleted=true`). */
export const wantsDeleted = (query: Record<string, unknown>): boolean =>
  String(query.includeDeleted) === 'true';

/**
 * Applies `?includeDeleted=` to a query builder.
 *
 * Deliberately opt-in per request rather than a global switch: a listing that
 * quietly included deleted rows would put them straight back in front of the
 * user with no way to tell them apart.
 */
export const withDeleted = <T>(q: T, include: boolean): T =>
  include ? ((q as any).setOptions({ withDeleted: true }) as T) : q;
