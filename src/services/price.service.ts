import { BASE_UNIT, familyOf } from '../utils/units.util.js';

/**
 * The one place a price is read (R26, hook H2).
 *
 * Phase 1 returns the item's own price. Price lists, city prices, quantity
 * bands and offers change only this function, so the UI, export, public API and
 * AI tools can never disagree about what something costs.
 */

export interface ResolvedPrice {
  amount_minor: number;
  currency: string;
  tax_inclusive: boolean;
  price_unit: string;
}

/** `null` = "not priced" (R27), which is never the same as ₹0. */
export const resolvePrice = (item: { price?: Partial<ResolvedPrice> | null } | null | undefined): ResolvedPrice | null => {
  const p = item?.price;
  if (!p || typeof p.amount_minor !== 'number') return null;
  return {
    amount_minor: p.amount_minor,
    currency: p.currency ?? 'INR',
    tax_inclusive: p.tax_inclusive ?? true,
    price_unit: p.price_unit ?? 'each',
  };
};

export interface PricePerUnit {
  /** Paise per `per`, rounded to whole paise. */
  amount_minor: number;
  currency: string;
  tax_inclusive: boolean;
  /** "100 g" · "kg" · "100 ml" · "l" · "100 cm" · "m" · "piece" */
  per: string;
}

/* Below 1 kg / 1 l / 1 m (in base units) the price is shown per 100 of the base unit. */
const LARGE: Record<string, { at: number; unit: string }> = {
  weight: { at: 1000, unit: 'kg' },
  volume: { at: 1000, unit: 'l' },
  length: { at: 100, unit: 'm' },
};

/**
 * Price per unit for a measured item (R46): worked out from resolvePrice and
 * the item's measure, NEVER stored. Per 100 g / 100 ml / 100 cm below 1 kg /
 * 1 l / 1 m, otherwise per kg / l / m; per piece for a count. `null` when the
 * item is not priced, has no measure, or is priced per hour / day / month
 * (`price.price_unit` is for rentals and is not used here).
 */
export const pricePerUnit = (
  item: { price?: Partial<ResolvedPrice> | null; measure?: { base_amount?: number; unit?: string } | null } | null | undefined
): PricePerUnit | null => {
  const price = resolvePrice(item);
  const m = item?.measure;
  const family = familyOf(m?.unit);
  if (!price || price.price_unit !== 'each' || !m || !family || !m.base_amount || m.base_amount <= 0) return null;
  const base = BASE_UNIT[family];
  let per: string;
  let size: number;
  if (family === 'count') {
    per = 'piece';
    size = 1;
  } else if (m.base_amount < LARGE[family].at) {
    per = `100 ${base}`;
    size = 100;
  } else {
    per = LARGE[family].unit;
    size = LARGE[family].at;
  }
  return {
    amount_minor: Math.round((price.amount_minor * size) / m.base_amount),
    currency: price.currency,
    tax_inclusive: price.tax_inclusive,
    per,
  };
};
