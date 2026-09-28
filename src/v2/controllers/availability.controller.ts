import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../middlewares/errorHandler.js';
import { toAppError } from '../../utils/error.util.js';
import { createLogger } from '../../utils/logger.js';
import { generateId, getPageParams, ok, paginated } from '../../utils/response.util.js';
import {
  CatalogAvailabilityModel,
  CatalogBookingModel,
  CatalogItemModel,
  CatalogProductModel,
} from '../models.js';
import { findSlots, hasConflict, resolveAvailability } from '../services/availability.js';
import { loadAllCategories, resolveCommerce } from '../services/categoryTree.js';
import { newId, restoreOne, softDeleteOne } from '../softDelete.js';

const log = createLogger('V2AvailabilityController');

const STRATEGIES = ['quantity', 'time_slot', 'capacity_per_date', 'unlimited', 'lead_time', 'none'] as const;

export const upsertAvailabilitySchema = z.object({
  body: z
    .object({
      itemId: z.string().min(1),
      locationId: z.string().optional().default('default'),
      strategy: z.enum(STRATEGIES),
      onHand: z.number().int().nonnegative().optional(),
      reserved: z.number().int().nonnegative().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      capacity: z.number().int().nonnegative().optional(),
      openingHours: z.record(z.string()).optional(),
      slotMinutes: z.number().int().positive().optional(),
      resourceId: z.string().optional(),
      inchargeId: z.string().optional(),
      leadDays: z.number().int().nonnegative().optional(),
      note: z.string().optional(),
    })
    /* Each strategy has one field it cannot work without. Accepting a row that
       is missing it produces a schedule with no slots, or a date with no
       capacity, and no error anywhere to explain why. */
    .refine((r) => r.strategy !== 'quantity' || r.onHand !== undefined, {
      message: 'A quantity row needs onHand',
    })
    .refine((r) => r.strategy !== 'capacity_per_date' || (r.date && r.capacity !== undefined), {
      message: 'A capacity_per_date row needs both date and capacity',
    })
    .refine((r) => r.strategy !== 'time_slot' || (r.openingHours && r.slotMinutes), {
      message: 'A time_slot row needs openingHours and slotMinutes',
    })
    .refine((r) => r.strategy !== 'lead_time' || r.leadDays !== undefined, {
      message: 'A lead_time row needs leadDays',
    }),
});

export const adjustStockSchema = z.object({
  body: z.object({
    itemId: z.string().min(1),
    locationId: z.string().optional().default('default'),
    /** Signed: -2 sells two, +10 receives ten. */
    delta: z.number().int(),
    reason: z.string().optional(),
  }),
});

export const updateBookingSchema = z.object({
  body: z.object({
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    locationId: z.string().optional(),
    inchargeId: z.string().optional(),
    resourceId: z.string().optional(),
    customerName: z.string().optional(),
    customerPhone: z.string().optional(),
    customerEmail: z.string().email().optional(),
    status: z.enum(['held', 'confirmed', 'cancelled', 'completed']).optional(),
    notes: z.string().optional(),
  }),
});

export const createBookingSchema = z.object({
  body: z.object({
    itemId: z.string().min(1),
    locationId: z.string().optional(),
    inchargeId: z.string().optional(),
    resourceId: z.string().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    customerName: z.string().optional(),
    customerPhone: z.string().optional(),
    customerEmail: z.string().email().optional(),
    status: z.enum(['held', 'confirmed']).optional().default('confirmed'),
    notes: z.string().optional(),
  }),
});

/* ------------------------------------------------------- availability */

export const listAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.itemId) filter.itemId = req.query.itemId;
    if (req.query.locationId) filter.locationId = req.query.locationId;
    if (req.query.date) filter.date = req.query.date;

    const query = CatalogAvailabilityModel.find(filter).sort({ itemId: 1, date: 1 });
    if (String(req.query.includeDeleted) === 'true') query.setOptions({ withDeleted: true });

    res.json(ok(await query.lean()));
  } catch (error) {
    next(toAppError(error, 'Could not list availability', log));
  }
};

/**
 * Creates or replaces one availability row.
 *
 * Keyed on item + location + date + strategy, so re-posting the same day's
 * capacity updates it rather than stacking a second row that silently doubles
 * it. Strategy is part of the key because an item can be configured both ways
 * at once during a migration, and a quantity write must not overwrite a slot
 * schedule that happens to share the location.
 */
export const upsertAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const item = await CatalogItemModel.findOne({ id: req.body.itemId }).lean();
    if (!item) throw new AppError(`Item '${req.body.itemId}' not found`, 404);

    const { itemId, locationId = 'default', date, strategy } = req.body;
    const key: Record<string, unknown> = { itemId, locationId, strategy };
    key.date = date ?? { $in: [null, undefined] };

    const updated = await CatalogAvailabilityModel.findOneAndUpdate(
      key,
      { $set: { ...req.body, locationId }, $setOnInsert: { id: newId() } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    res.status(201).json(ok(updated.toJSON(), 'Availability saved'));
  } catch (error) {
    next(toAppError(error, 'Could not save availability', log));
  }
};

export const deleteAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deleted = await softDeleteOne(CatalogAvailabilityModel, req.params.id, 'Availability row');
    res.json(ok(deleted, 'Availability row deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the availability row', log));
  }
};

export const restoreAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const restored = await restoreOne(CatalogAvailabilityModel, req.params.id, 'Availability row');
    res.json(ok(restored, 'Availability row restored'));
  } catch (error) {
    next(toAppError(error, 'Could not restore the availability row', log));
  }
};

/**
 * Moves stock by a delta rather than setting an absolute figure.
 *
 * Two concurrent sales that each read 10 and write 9 lose a unit; `$inc` in a
 * single guarded update does not. The guard is what makes overselling a 409
 * instead of a negative count.
 */
export const adjustStock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { itemId, locationId = 'default', delta } = req.body;

    const row = await CatalogAvailabilityModel.findOne({
      itemId,
      locationId,
      date: null,
      strategy: 'quantity',
    });
    if (!row) {
      throw new AppError(
        `No quantity row for item '${itemId}' at '${locationId}' — create one first`,
        404
      );
    }

    const updated = await CatalogAvailabilityModel.findOneAndUpdate(
      /* The filter carries the constraint: when there is not enough on hand the
         update matches nothing, and no row is written. */
      delta < 0
        ? { itemId, locationId, date: null, strategy: 'quantity', onHand: { $gte: Math.abs(delta) } }
        : { itemId, locationId, date: null, strategy: 'quantity' },
      { $inc: { onHand: delta } },
      { new: true }
    );

    if (!updated) {
      throw new AppError(
        `Not enough stock: ${row.onHand ?? 0} on hand, ${Math.abs(delta)} requested`,
        409
      );
    }

    log.log(`Stock for ${itemId} at ${locationId}: ${delta > 0 ? '+' : ''}${delta} -> ${updated.onHand}`);
    res.json(ok(updated.toJSON(), 'Stock adjusted'));
  } catch (error) {
    next(toAppError(error, 'Could not adjust stock', log));
  }
};

/** The resolved answer for one item: the strategy applied, not the raw rows. */
export const getItemAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const item = await CatalogItemModel.findOne({ id: req.params.itemId }).lean();
    if (!item) throw new AppError(`Item '${req.params.itemId}' not found`, 404);

    const product = await CatalogProductModel.findOne({ id: (item as any).productId }).lean();
    const all = await loadAllCategories();
    const commerce = resolveCommerce((product as any)?.categoryIds ?? [], all);

    const state = await resolveAvailability((item as any).id, commerce.availability.model, {
      locationId: req.query.locationId as string | undefined,
      date: req.query.date as string | undefined,
    });

    res.json(ok({ itemId: (item as any).id, sku: (item as any).sku, ...state }));
  } catch (error) {
    next(toAppError(error, 'Could not resolve availability', log));
  }
};

/* -------------------------------------------------------------- slots */

export const getSlots = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const date = String(req.query.date ?? '');
    if (!date) throw new AppError('date is required (YYYY-MM-DD)', 400);

    const slots = await findSlots(req.params.itemId, date, {
      locationId: req.query.locationId as string | undefined,
      inchargeId: req.query.inchargeId as string | undefined,
      resourceId: req.query.resourceId as string | undefined,
      durationMinutes: req.query.durationMinutes ? Number(req.query.durationMinutes) : undefined,
    });

    const free = slots.filter((s) => s.available);
    res.json(
      ok({
        date,
        total: slots.length,
        available: free.length,
        /* Both lists are returned: a booked 3pm shown greyed out is more useful
           than a gap the customer cannot explain. */
        slots: String(req.query.availableOnly) === 'true' ? free : slots,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not build the slot list', log));
  }
};

/* ----------------------------------------------------------- bookings */

export const listBookings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, skip } = getPageParams(req);

    const filter: Record<string, unknown> = {};
    if (req.query.itemId) filter.itemId = req.query.itemId;
    if (req.query.inchargeId) filter.inchargeId = req.query.inchargeId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.from || req.query.to) {
      filter.startsAt = {
        ...(req.query.from ? { $gte: new Date(req.query.from as string) } : {}),
        ...(req.query.to ? { $lte: new Date(req.query.to as string) } : {}),
      };
    }

    const seeDeleted = String(req.query.includeDeleted) === 'true';
    const scoped = <T>(q: T): T => (seeDeleted ? (q as any).setOptions({ withDeleted: true }) : q);

    const [rows, total] = await Promise.all([
      scoped(CatalogBookingModel.find(filter).sort({ startsAt: 1 }).skip(skip).limit(limit)).lean(),
      scoped(CatalogBookingModel.countDocuments(filter)),
    ]);

    res.json(paginated(rows, total, page, limit));
  } catch (error) {
    next(toAppError(error, 'Could not list bookings', log));
  }
};

export const createBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { itemId, startsAt, endsAt, inchargeId, resourceId } = req.body;

    if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      throw new AppError('endsAt must be after startsAt', 422);
    }

    const item = await CatalogItemModel.findOne({ id: itemId }).lean();
    if (!item) throw new AppError(`Item '${itemId}' not found`, 404);

    const product = await CatalogProductModel.findOne({ id: (item as any).productId }).lean();
    const all = await loadAllCategories();
    const commerce = resolveCommerce((product as any)?.categoryIds ?? [], all);

    if (commerce.availability.requiresIncharge && !inchargeId) {
      throw new AppError('This booking needs an inchargeId', 422);
    }

    if (commerce.availability.model === 'capacity_per_date') {
      /* A dated capacity is a count, not a calendar: the check is "is there one
         left on this date", not "does this interval overlap". */
      const date = String(startsAt).slice(0, 10);
      const state = await resolveAvailability(itemId, 'capacity_per_date', {
        date,
        locationId: req.body.locationId,
      });
      if (!state.available) throw new AppError(state.label, 409);
    } else if (await hasConflict({ itemId, startsAt, endsAt, inchargeId, resourceId })) {
      throw new AppError('That slot is already booked', 409);
    }

    const created = await CatalogBookingModel.create({
      ...req.body,
      id: newId(),
    });

    log.log(`Booked ${itemId} from ${startsAt} to ${endsAt}`);
    res.status(201).json(ok(created.toJSON(), 'Booking created'));
  } catch (error) {
    next(toAppError(error, 'Could not create the booking', log));
  }
};

/**
 * Reschedules or amends a booking.
 *
 * A time change re-runs the overlap check, excluding this booking from it —
 * otherwise moving a booking by ten minutes would always collide with itself.
 */
export const updateBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const existing = await CatalogBookingModel.findOne({ id: req.params.id });
    if (!existing) throw new AppError(`Booking '${req.params.id}' not found`, 404);

    const startsAt = req.body.startsAt ?? existing.startsAt;
    const endsAt = req.body.endsAt ?? existing.endsAt;

    if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      throw new AppError('endsAt must be after startsAt', 422);
    }

    const item = await CatalogItemModel.findOne({ id: existing.itemId }).lean();
    const product = item
      ? await CatalogProductModel.findOne({ id: (item as any).productId }).lean()
      : null;
    const all = await loadAllCategories();
    const commerce = resolveCommerce((product as any)?.categoryIds ?? [], all);

    const inchargeId = req.body.inchargeId ?? existing.inchargeId;
    if (commerce.availability.requiresIncharge && !inchargeId) {
      throw new AppError('This booking needs an inchargeId', 422);
    }

    /* Only re-check when something that affects the slot actually moved. A
       pure change of customer name must not be able to fail on a conflict. */
    const slotChanged =
      req.body.startsAt !== undefined ||
      req.body.endsAt !== undefined ||
      req.body.inchargeId !== undefined ||
      req.body.resourceId !== undefined;

    const becomingLive = (req.body.status ?? existing.status) !== 'cancelled';

    if (slotChanged && becomingLive && commerce.availability.model !== 'capacity_per_date') {
      const clash = await hasConflict({
        itemId: existing.itemId,
        startsAt,
        endsAt,
        inchargeId,
        resourceId: req.body.resourceId ?? existing.resourceId,
        excludeId: existing.id,
      });
      if (clash) throw new AppError('That slot is already booked', 409);
    }

    const updated = await CatalogBookingModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    log.log(`Updated booking ${req.params.id}`);
    res.json(ok(updated!.toJSON(), 'Booking updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the booking', log));
  }
};

/**
 * Removes a booking from the list entirely.
 *
 * Distinct from cancelling: a cancelled booking stays visible as a record of
 * what was called off, whereas a deleted one was a mistake — a test entry, a
 * duplicate — that nobody needs to see. Both free the slot.
 */
export const deleteBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deleted = await softDeleteOne(CatalogBookingModel, req.params.id, 'Booking');
    log.log(`Soft-deleted booking ${req.params.id}`);
    res.json(ok(deleted, 'Booking deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the booking', log));
  }
};

export const restoreBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const restored = await restoreOne(CatalogBookingModel, req.params.id, 'Booking');
    res.json(ok(restored, 'Booking restored'));
  } catch (error) {
    next(toAppError(error, 'Could not restore the booking', log));
  }
};

export const cancelBooking = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    /* Cancelled, not deleted: the slot frees up because the status is excluded
       from the overlap query, and the record survives for the history. */
    const updated = await CatalogBookingModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!updated) throw new AppError(`Booking '${req.params.id}' not found`, 404);

    res.json(ok(updated.toJSON(), 'Booking cancelled'));
  } catch (error) {
    next(toAppError(error, 'Could not cancel the booking', log));
  }
};
