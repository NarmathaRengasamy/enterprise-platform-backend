import { AppError } from '../../middlewares/errorHandler.js';
import { CatalogAvailabilityModel, CatalogBookingModel } from '../models.js';
import type { AvailabilityModel, CatalogAvailability, CatalogBooking } from '../types.js';

/**
 * Availability, as a set of strategies rather than a stock number.
 *
 * "Is this available" means something different for a t-shirt, a hotel room on
 * the 14th, a 3pm slot with a named doctor, and a car with a six-week lead
 * time. v1 answered all four with an integer, which is why three of them were
 * inexpressible.
 */

export interface AvailabilityState {
  strategy: AvailabilityModel;
  /** The one boolean a storefront actually needs. */
  available: boolean;
  /** Human-facing: "12 in stock", "3 left on 14 Oct", "Ships in 6 weeks". */
  label: string;
  /** Strategy-specific detail: counts, the date, the lead time. */
  detail: Record<string, unknown>;
}

const UNTRACKED: AvailabilityState = {
  strategy: 'none',
  available: true,
  label: 'Available',
  detail: {},
};

export interface AvailabilityQuery {
  locationId?: string;
  /** ISO date (YYYY-MM-DD) — required by capacity_per_date. */
  date?: string;
}

export const loadAvailability = async (
  itemId: string,
  { locationId, date }: AvailabilityQuery = {}
): Promise<CatalogAvailability[]> => {
  const filter: Record<string, unknown> = { itemId };
  if (locationId) filter.locationId = locationId;
  /* A row with no date is the item's standing configuration; a dated row is an
     override for that day. Both are needed, so the date filter is an OR. */
  if (date) filter.$or = [{ date }, { date: { $in: [null, undefined] } }];

  return (await CatalogAvailabilityModel.find(filter).lean()) as unknown as CatalogAvailability[];
};

/**
 * Collapses an item's availability rows into one answer.
 *
 * Rows are summed across locations: a shopper asking "can I buy this" wants the
 * total, and a shopper asking about one shop passes a `locationId`.
 */
export const resolveAvailability = async (
  itemId: string,
  strategy: AvailabilityModel,
  query: AvailabilityQuery = {}
): Promise<AvailabilityState> => {
  if (strategy === 'none') return UNTRACKED;
  if (strategy === 'unlimited') {
    return { strategy, available: true, label: 'Always available', detail: {} };
  }

  const rows = await loadAvailability(itemId, query);

  switch (strategy) {
    case 'quantity': {
      const onHand = sum(rows, (r) => r.onHand ?? 0);
      const reserved = sum(rows, (r) => r.reserved ?? 0);
      const free = Math.max(0, onHand - reserved);

      /* No row at all is "not tracked", not "sold out". Treating an absent
         record as a zero is the v1 bug that made every unpriced, unstocked
         product read as out of stock. */
      if (!rows.length) {
        return { strategy, available: true, label: 'Availability not tracked', detail: {} };
      }

      return {
        strategy,
        available: free > 0,
        label: free > 0 ? `${free} in stock` : 'Out of stock',
        detail: { onHand, reserved, free, locations: rows.length },
      };
    }

    case 'capacity_per_date': {
      const date = query.date;
      if (!date) {
        return {
          strategy,
          available: rows.length > 0,
          label: 'Select a date',
          detail: { needsDate: true },
        };
      }

      const forDate = rows.filter((r) => r.date === date);
      const capacity = sum(forDate, (r) => r.capacity ?? 0);
      if (!forDate.length) {
        return { strategy, available: false, label: 'Not available on that date', detail: { date } };
      }

      const booked = await CatalogBookingModel.countDocuments({
        itemId,
        status: { $in: ['held', 'confirmed'] },
        startsAt: { $gte: new Date(`${date}T00:00:00.000Z`), $lte: new Date(`${date}T23:59:59.999Z`) },
        ...(query.locationId ? { locationId: query.locationId } : {}),
      });

      const free = Math.max(0, capacity - booked);
      return {
        strategy,
        available: free > 0,
        label: free > 0 ? `${free} left on ${date}` : `Fully booked on ${date}`,
        detail: { date, capacity, booked, free },
      };
    }

    case 'lead_time': {
      const days = rows.length ? Math.min(...rows.map((r) => r.leadDays ?? 0)) : null;
      const note = rows.find((r) => r.note)?.note;

      if (days === null) {
        return { strategy, available: true, label: note ?? 'Available to order', detail: {} };
      }
      return {
        strategy,
        available: true,
        label: note ?? describeLead(days),
        detail: { leadDays: days },
      };
    }

    case 'time_slot': {
      /* Whether a specific slot is free is a different question, answered by
         `findSlots`. Here the answer is only whether a calendar exists. */
      const configured = rows.length > 0;
      return {
        strategy,
        available: configured,
        label: configured ? 'Bookable' : 'No schedule configured',
        detail: { needsSlot: true, locations: rows.length },
      };
    }

    default:
      return UNTRACKED;
  }
};

/** Resolves many items at once, so a listing does not issue a query per row. */
export const resolveAvailabilityFor = async (
  items: { itemId: string; strategy: AvailabilityModel }[],
  query: AvailabilityQuery = {}
): Promise<Map<string, AvailabilityState>> => {
  const out = new Map<string, AvailabilityState>();
  const trackable = items.filter((i) => i.strategy !== 'none' && i.strategy !== 'unlimited');

  for (const item of items) {
    if (item.strategy === 'none') out.set(item.itemId, UNTRACKED);
    if (item.strategy === 'unlimited') {
      out.set(item.itemId, {
        strategy: 'unlimited',
        available: true,
        label: 'Always available',
        detail: {},
      });
    }
  }
  if (!trackable.length) return out;

  const filter: Record<string, unknown> = { itemId: { $in: trackable.map((i) => i.itemId) } };
  if (query.locationId) filter.locationId = query.locationId;

  const rows = (await CatalogAvailabilityModel.find(filter).lean()) as unknown as CatalogAvailability[];
  const byItem = new Map<string, CatalogAvailability[]>();
  for (const row of rows) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row]);

  for (const item of trackable) {
    const own = byItem.get(item.itemId) ?? [];

    if (item.strategy === 'quantity') {
      if (!own.length) {
        out.set(item.itemId, {
          strategy: 'quantity',
          available: true,
          label: 'Availability not tracked',
          detail: {},
        });
        continue;
      }
      const onHand = sum(own, (r) => r.onHand ?? 0);
      const reserved = sum(own, (r) => r.reserved ?? 0);
      const free = Math.max(0, onHand - reserved);
      out.set(item.itemId, {
        strategy: 'quantity',
        available: free > 0,
        label: free > 0 ? `${free} in stock` : 'Out of stock',
        detail: { onHand, reserved, free, locations: own.length },
      });
      continue;
    }

    if (item.strategy === 'lead_time') {
      const days = own.length ? Math.min(...own.map((r) => r.leadDays ?? 0)) : null;
      out.set(item.itemId, {
        strategy: 'lead_time',
        available: true,
        label: own.find((r) => r.note)?.note ?? (days === null ? 'Available to order' : describeLead(days)),
        detail: days === null ? {} : { leadDays: days },
      });
      continue;
    }

    /* time_slot and capacity_per_date need a date to mean anything, and a list
       view does not have one. The listing says "bookable" and the detail page
       resolves properly. */
    out.set(item.itemId, {
      strategy: item.strategy,
      available: own.length > 0,
      label: own.length ? 'Bookable' : 'Not bookable',
      detail: { needsDate: item.strategy === 'capacity_per_date', needsSlot: item.strategy === 'time_slot' },
    });
  }

  return out;
};

const describeLead = (days: number): string => {
  if (days <= 0) return 'Available now';
  if (days === 1) return 'Ships tomorrow';
  if (days < 14) return `Ships in ${days} days`;
  const weeks = Math.round(days / 7);
  return `Ships in about ${weeks} week${weeks === 1 ? '' : 's'}`;
};

const sum = <T>(rows: T[], pick: (row: T) => number): number =>
  rows.reduce((total, row) => total + pick(row), 0);

/* ================================================================ slots */

export interface Slot {
  startsAt: string;
  endsAt: string;
  available: boolean;
  inchargeId?: string;
  resourceId?: string;
  locationId: string;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The bookable slots on a date.
 *
 * A slot is free when the schedule opens it AND nothing overlaps it. Filtering
 * by `inchargeId` narrows to one person's calendar — "book with Dr Mehta" — and
 * omitting it searches every configured one, which is "3pm with anyone".
 */
export const findSlots = async (
  itemId: string,
  date: string,
  opts: { locationId?: string; inchargeId?: string; resourceId?: string; durationMinutes?: number } = {}
): Promise<Slot[]> => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError('date must be in YYYY-MM-DD form', 400);
  }

  const rows = (await CatalogAvailabilityModel.find({
    itemId,
    strategy: 'time_slot',
    ...(opts.locationId ? { locationId: opts.locationId } : {}),
    ...(opts.inchargeId ? { inchargeId: opts.inchargeId } : {}),
    ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
  }).lean()) as unknown as CatalogAvailability[];

  if (!rows.length) return [];

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const dayKey = DAY_KEYS[dayStart.getUTCDay()];

  const bookings = (await CatalogBookingModel.find({
    itemId,
    status: { $in: ['held', 'confirmed'] },
    startsAt: { $lt: dayEnd },
    endsAt: { $gt: dayStart },
  }).lean()) as unknown as CatalogBooking[];

  const slots: Slot[] = [];

  for (const row of rows) {
    const hours = (row.openingHours ?? {}) as Record<string, string>;
    const window = hours[dayKey] ?? hours.default;
    /* An absent day is closed, not all-day-open. A clinic with no Sunday entry
       must not quietly offer Sunday appointments. */
    if (!window) continue;

    const [openAt, closeAt] = String(window).split('-').map((s) => s.trim());
    if (!openAt || !closeAt) continue;

    const step = opts.durationMinutes ?? row.slotMinutes ?? 30;
    if (step <= 0) continue;

    let cursor = new Date(`${date}T${padTime(openAt)}:00.000Z`).getTime();
    const close = new Date(`${date}T${padTime(closeAt)}:00.000Z`).getTime();
    if (!Number.isFinite(cursor) || !Number.isFinite(close)) continue;

    while (cursor + step * 60_000 <= close) {
      const start = cursor;
      const end = cursor + step * 60_000;

      /* An overlap on the same resource or the same person blocks the slot.
         Two different doctors in two different rooms do not collide. */
      const clash = bookings.some((b) => {
        const bs = new Date(b.startsAt).getTime();
        const be = new Date(b.endsAt).getTime();
        if (!(bs < end && be > start)) return false;
        if (row.inchargeId && b.inchargeId && row.inchargeId !== b.inchargeId) return false;
        if (row.resourceId && b.resourceId && row.resourceId !== b.resourceId) return false;
        return true;
      });

      slots.push({
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        available: !clash,
        ...(row.inchargeId ? { inchargeId: row.inchargeId } : {}),
        ...(row.resourceId ? { resourceId: row.resourceId } : {}),
        locationId: row.locationId,
      });

      cursor = end;
    }
  }

  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
};

const padTime = (value: string): string => {
  const [h, m = '00'] = value.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
};

/**
 * Whether a proposed booking collides with an existing one.
 *
 * Checked immediately before the insert. It is not a substitute for a unique
 * index — two simultaneous requests can both pass — but it turns the common
 * case into a clear 409 rather than a double booking nobody notices.
 */
export const hasConflict = async (
  booking: Pick<CatalogBooking, 'itemId' | 'startsAt' | 'endsAt'> & {
    inchargeId?: string;
    resourceId?: string;
    excludeId?: string;
  }
): Promise<boolean> => {
  const filter: Record<string, unknown> = {
    itemId: booking.itemId,
    status: { $in: ['held', 'confirmed'] },
    startsAt: { $lt: new Date(booking.endsAt) },
    endsAt: { $gt: new Date(booking.startsAt) },
  };
  if (booking.inchargeId) filter.inchargeId = booking.inchargeId;
  if (booking.resourceId) filter.resourceId = booking.resourceId;
  if (booking.excludeId) filter.id = { $ne: booking.excludeId };

  return (await CatalogBookingModel.countDocuments(filter)) > 0;
};
