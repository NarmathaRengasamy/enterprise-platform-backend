import { CatalogChargeModel, CatalogPriceModel } from '../models.js';
import type { CatalogCategory, CatalogCharge, CatalogPrice } from '../types.js';
import { ancestorChain } from './categoryTree.js';

/**
 * Price and charge resolution.
 *
 * Both are records rather than fields, so "what does this cost" is a query, not
 * a property read. That is what makes price lists, seasonal rates, quantity
 * bands and fees-without-a-price all expressible in one model.
 */

export const DEFAULT_PRICE_LIST = 'default';

const asTime = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const t = new Date(value as string).getTime();
  return Number.isFinite(t) ? t : null;
};

/** A row is live when `at` falls inside its window; an open end is unbounded. */
const inWindow = (row: { validFrom?: unknown; validTo?: unknown }, at: number): boolean => {
  const from = asTime(row.validFrom);
  const to = asTime(row.validTo);
  if (from !== null && at < from) return false;
  if (to !== null && at > to) return false;
  return true;
};

export interface PriceQuery {
  priceListId?: string;
  at?: Date;
  quantity?: number;
}

/**
 * The single price that applies, or null.
 *
 * Null is a real answer, not a failure: an item on request or one that has
 * simply not been priced yet both land here, and the caller renders "Price on
 * request" rather than a zero.
 */
export const resolvePrice = async (
  itemId: string,
  { priceListId = DEFAULT_PRICE_LIST, at = new Date(), quantity = 1 }: PriceQuery = {}
): Promise<CatalogPrice | null> => {
  const rows = (await CatalogPriceModel.find({
    itemId,
    priceListId: { $in: [priceListId, DEFAULT_PRICE_LIST] },
  }).lean()) as unknown as CatalogPrice[];

  return pickPrice(rows, priceListId, at.getTime(), quantity);
};

/** Resolves many items in one round trip — a list view must not fan out per row. */
export const resolvePricesFor = async (
  itemIds: string[],
  { priceListId = DEFAULT_PRICE_LIST, at = new Date(), quantity = 1 }: PriceQuery = {}
): Promise<Map<string, CatalogPrice | null>> => {
  const out = new Map<string, CatalogPrice | null>(itemIds.map((id) => [id, null]));
  if (!itemIds.length) return out;

  const rows = (await CatalogPriceModel.find({
    itemId: { $in: itemIds },
    priceListId: { $in: [priceListId, DEFAULT_PRICE_LIST] },
  }).lean()) as unknown as CatalogPrice[];

  const byItem = new Map<string, CatalogPrice[]>();
  for (const row of rows) {
    byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row]);
  }

  const ts = at.getTime();
  for (const id of itemIds) {
    out.set(id, pickPrice(byItem.get(id) ?? [], priceListId, ts, quantity));
  }
  return out;
};

const pickPrice = (
  rows: CatalogPrice[],
  priceListId: string,
  at: number,
  quantity: number
): CatalogPrice | null => {
  const live = rows.filter((r) => inWindow(r, at) && (r.minQuantity ?? 1) <= quantity);
  if (!live.length) return null;

  /* The requested list wins outright; `default` is only a fallback. Mixing the
     two by price would let a retail rate undercut a negotiated B2B one. */
  const preferred = live.filter((r) => r.priceListId === priceListId);
  const pool = preferred.length ? preferred : live;

  /* Highest applicable band first: at quantity 12, the row starting at 11 beats
     the row starting at 1. */
  return [...pool].sort((a, b) => (b.minQuantity ?? 1) - (a.minQuantity ?? 1))[0] ?? null;
};

/* =============================================================== charges */

export interface ResolvedCharge {
  id: string;
  name: string;
  label: string;
  basis: CatalogCharge['basis'];
  amount: number | null;
  required: boolean;
  selectable: boolean;
  maxQuantity: number;
  currency: string;
  showInListing: boolean;
  /** Which level it came from, so the UI can say "inherited from Cars". */
  source: { level: CatalogCharge['scope']['level']; refId: string };
  /** Set when a percentage charge cannot be computed without a base price. */
  note?: string;
}

export interface ChargeBreakdown {
  base: number | null;
  currency: string;
  required: ResolvedCharge[];
  optional: ResolvedCharge[];
  totalRequired: number | null;
  note: string | null;
}

export interface ChargeQuery extends PriceQuery {
  /** Number of units, nights or hours — what per_unit and per_time multiply by. */
  units?: number;
}

/**
 * Every charge that applies to an item, most specific first.
 *
 * Collected from the item, its product, and its categories with their
 * ancestors. A nearer charge with the same `name` overrides a broader one,
 * which is how a single category waives a platform-wide fee.
 */
export const collectCharges = async (
  ctx: { itemId: string; productId: string; categoryIds: string[] },
  allCategories: CatalogCategory[],
  { priceListId = DEFAULT_PRICE_LIST, at = new Date() }: ChargeQuery = {}
): Promise<CatalogCharge[]> => {
  const categoryRefs: string[] = [];
  for (const id of ctx.categoryIds) {
    for (const node of ancestorChain(id, allCategories)) {
      if (!categoryRefs.includes(node.id)) categoryRefs.push(node.id);
    }
  }

  const rows = (await CatalogChargeModel.find({
    $or: [
      { 'scope.level': 'item', 'scope.refId': ctx.itemId },
      { 'scope.level': 'product', 'scope.refId': ctx.productId },
      { 'scope.level': 'category', 'scope.refId': { $in: categoryRefs } },
    ],
    priceListId: { $in: [priceListId, null] },
  }).lean()) as unknown as CatalogCharge[];

  const ts = at.getTime();
  const live = rows.filter((r) => inWindow(r, ts));

  /* Specificity: item beats product beats category, and a nearer category beats
     a more distant ancestor. `categoryRefs` is already in nearest-first order. */
  const rank = (c: CatalogCharge): number => {
    if (c.scope.level === 'item') return 0;
    if (c.scope.level === 'product') return 1;
    const depth = categoryRefs.indexOf(c.scope.refId);
    return 2 + (depth < 0 ? categoryRefs.length : depth);
  };

  const ordered = [...live].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    /* An explicit price-list override beats the list-agnostic default. */
    return (a.priceListId ? 0 : 1) - (b.priceListId ? 0 : 1);
  });

  const winners = new Map<string, CatalogCharge>();
  for (const charge of ordered) {
    if (!winners.has(charge.name)) winners.set(charge.name, charge);
  }
  return [...winners.values()];
};

/**
 * Turns the applicable charges into money.
 *
 * `base` is allowed to be null throughout. A dealership vehicle is quoted on
 * request and still has a known registration fee, so fixed charges are computed
 * and returned while percentage ones report that they need a price first.
 */
export const computeCharges = (
  charges: CatalogCharge[],
  base: number | null,
  { units = 1, currency = 'INR' }: { units?: number; currency?: string } = {}
): ChargeBreakdown => {
  const required: ResolvedCharge[] = [];
  const optional: ResolvedCharge[] = [];

  const shape = (c: CatalogCharge, amount: number | null, note?: string): ResolvedCharge => ({
    id: c.id,
    name: c.name,
    label: c.label ?? c.name,
    basis: c.basis,
    amount,
    required: c.required,
    selectable: c.selectable ?? !c.required,
    maxQuantity: c.maxQuantity ?? 1,
    currency: c.currency ?? currency,
    showInListing: c.showInListing ?? false,
    source: { level: c.scope.level, refId: c.scope.refId },
    ...(note ? { note } : {}),
  });

  /* Three passes, in a declared order: fixed amounts, then percentages of the
     base, then percentages of the base plus everything already required. A
     hotel's GST applies to the room rate plus the service charge — which is
     itself a percentage — so the last pass has to see the second one's output,
     and none of it may depend on the order the charges happened to be created. */
  const flat = charges.filter((c) => c.basis !== 'percent');
  const percent = [
    ...charges.filter((c) => c.basis === 'percent' && c.percentOf !== 'base_plus_charges'),
    ...charges.filter((c) => c.basis === 'percent' && c.percentOf === 'base_plus_charges'),
  ];

  /* Every required charge settled so far — what `base_plus_charges` adds on. */
  let requiredSoFar = 0;

  for (const c of flat) {
    const unitAmount = c.amount ?? 0;
    const amount =
      c.basis === 'per_unit' || c.basis === 'per_time' ? round2(unitAmount * units) : round2(unitAmount);

    const row = shape(c, amount);
    if (c.required) {
      required.push(row);
      requiredSoFar += amount;
    } else {
      optional.push(row);
    }
  }

  for (const c of percent) {
    if (base === null) {
      /* Reported rather than silently dropped: "18% GST applies" is genuinely
         useful next to "Price on request", and a zero would be a lie. */
      const row = shape(c, null, 'Calculated once the price is confirmed');
      (c.required ? required : optional).push(row);
      continue;
    }

    const against = c.percentOf === 'base_plus_charges' ? base + requiredSoFar : base;
    const amount = round2((against * (c.percent ?? 0)) / 100);

    const row = shape(c, amount);
    if (c.required) {
      required.push(row);
      requiredSoFar += amount;
    } else {
      optional.push(row);
    }
  }

  /* Null when the base is unknown, or when a required percentage could not be
     computed. A partial total presented as a full one is worse than none. */
  const computable = base !== null && required.every((r) => r.amount !== null);
  const totalRequired = computable
    ? round2(base + required.reduce((sum, r) => sum + (r.amount ?? 0), 0))
    : null;

  const note =
    base === null && required.length
      ? 'These charges apply on top of the quoted price'
      : null;

  return { base, currency, required, optional, totalRequired, note };
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
