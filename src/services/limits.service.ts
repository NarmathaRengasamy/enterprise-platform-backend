import { AppError } from '../middlewares/errorHandler.js';

/**
 * Purchase limits (design R50–R53) — the ONE place limits are read, checked
 * and described, so checkout, the public API and the AI always agree.
 *
 * Every value is optional; `null` = no limit (on a product) or "use the
 * product's value" (on an item). Limits are stored, validated and shown now;
 * they are enforced once a cart / checkout and customer orders exist (R53).
 */

export const WINDOWS = ['day', 'week', 'month', 'year', 'lifetime'] as const;
export type Window = (typeof WINDOWS)[number];

const WINDOW_TEXT: Record<Window, string> = {
  day: 'every 24 hours',
  week: 'every 7 days',
  month: 'every 30 days',
  year: 'every year',
  lifetime: 'in total',
};

const WINDOW_NAME: Record<Window, string> = { day: '24 hours', week: '7 days', month: '30 days', year: '1 year', lifetime: 'ever' };

export interface PurchaseLimits {
  min_per_order: number | null;
  max_per_order: number | null;
  per_customer: Record<Window, number | null>;
}

export interface PurchaseLimitsInput {
  min_per_order?: number | null;
  max_per_order?: number | null;
  per_customer?: Partial<Record<Window, number | null>> | null;
}

const emptyWindows = (): Record<Window, number | null> => ({ day: null, week: null, month: null, year: null, lifetime: null });

export const noLimits = (): PurchaseLimits => ({ min_per_order: null, max_per_order: null, per_customer: emptyWindows() });

/** The full shape, with every missing value as null (old documents have no limits at all). */
const shape = (l: PurchaseLimitsInput | null | undefined): PurchaseLimits => ({
  min_per_order: l?.min_per_order ?? null,
  max_per_order: l?.max_per_order ?? null,
  per_customer: { ...emptyWindows(), ...Object.fromEntries(WINDOWS.map((w) => [w, l?.per_customer?.[w] ?? null])) },
});

const isEmpty = (l: PurchaseLimits) => l.min_per_order === null && l.max_per_order === null && WINDOWS.every((w) => l.per_customer[w] === null);

const fail = (errors: Record<string, string>) => {
  const reasons = Object.values(errors);
  return new AppError(`Purchase limits: ${reasons.join('; ')}`, 422, undefined, errors);
};

/** R51 on one set of values; returns the field errors (empty when fine). */
const problems = (l: PurchaseLimits, path: string, who = ''): Record<string, string> => {
  const errors: Record<string, string> = {};
  const at = (k: string) => `${path}.${k}`;
  const label = (s: string) => (who ? `${who}: ${s}` : s);

  const each: [string, number | null][] = [
    ['min_per_order', l.min_per_order],
    ['max_per_order', l.max_per_order],
    ...WINDOWS.map((w): [string, number | null] => [`per_customer.${w}`, l.per_customer[w]]),
  ];
  for (const [k, v] of each) {
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) errors[at(k)] = label('must be a whole number of 1 or more');
  }
  if (Object.keys(errors).length) return errors;

  const min = l.min_per_order;
  if (min !== null && l.max_per_order !== null && min > l.max_per_order) {
    errors[at('min_per_order')] = label(`the minimum per order (${min}) is above the maximum (${l.max_per_order})`);
  }
  for (const w of WINDOWS) {
    const v = l.per_customer[w];
    if (min !== null && v !== null && min > v) {
      errors[at(`per_customer.${w}`)] = label(`the minimum per order (${min}) is above the ${WINDOW_NAME[w]} limit (${v})`);
    }
  }
  /* The windows may not shrink as they get longer: 24 h ≤ 7 d ≤ 30 d ≤ 1 y ≤ ever. */
  let shorter: { w: Window; v: number } | null = null;
  for (const w of WINDOWS) {
    const v = l.per_customer[w];
    if (v === null) continue;
    if (shorter && v < shorter.v) {
      errors[at(`per_customer.${w}`)] = label(`the ${WINDOW_NAME[w]} limit (${v}) is below the ${WINDOW_NAME[shorter.w]} limit (${shorter.v})`);
    }
    if (!shorter || v > shorter.v) shorter = { w, v };
  }
  /* A max per order above a window limit is allowed — the smaller applies (R51). */
  return errors;
};

export const limitsService = {
  /**
   * Checks what was sent and returns what to store: `undefined` = not sent
   * (leave as is), `null` = no limits. A partial object is completed with
   * nulls, and an all-null object is stored as null.
   */
  validate(input: PurchaseLimitsInput | null | undefined, path = 'purchase_limits'): PurchaseLimits | null | undefined {
    if (input === undefined) return undefined;
    if (input === null) return null;
    const l = shape(input);
    const errors = problems(l, path);
    if (Object.keys(errors).length) throw fail(errors);
    return isEmpty(l) ? null : l;
  },

  /** What applies to an item: each value from the item, else the product, else no limit. */
  effective(product: PurchaseLimitsInput | null | undefined, item?: PurchaseLimitsInput | null): PurchaseLimits {
    const p = shape(product);
    const i = shape(item);
    return {
      min_per_order: i.min_per_order ?? p.min_per_order,
      max_per_order: i.max_per_order ?? p.max_per_order,
      per_customer: Object.fromEntries(WINDOWS.map((w) => [w, i.per_customer[w] ?? p.per_customer[w]])) as Record<Window, number | null>,
    };
  },

  /**
   * The combination must hold too (an item's own max 1 under the product's
   * min 2 is refused). Checks each item's effective limits; 422 names the item.
   */
  assertEffective(product: PurchaseLimitsInput | null | undefined, items: { sku?: string; purchase_limits?: PurchaseLimitsInput | null }[], path = 'items') {
    const errors: Record<string, string> = {};
    items.forEach((it, i) => {
      if (!it.purchase_limits && !product) return;
      Object.assign(errors, problems(this.effective(product, it.purchase_limits), `${path}.${i}.effective_limits`, it.sku ? `Item ${it.sku}` : `Item ${i + 1}`));
    });
    if (Object.keys(errors).length) throw fail(errors);
  },

  /** "Max 2 per order · 4 per customer every 30 days"; "" when there are no limits. */
  summary(l: PurchaseLimits | null | undefined): string {
    if (!l) return '';
    const parts: string[] = [];
    if (l.min_per_order !== null && l.min_per_order > 1) parts.push(`Min ${l.min_per_order} per order`);
    if (l.max_per_order !== null) parts.push(`Max ${l.max_per_order} per order`);
    for (const w of WINDOWS) {
      const v = l.per_customer[w];
      if (v !== null) parts.push(`${v} per customer ${WINDOW_TEXT[w]}`);
    }
    return parts.join(' · ');
  },

  /**
   * How many more this customer may buy (R52–R53). A stub until customers and
   * orders exist: it never blocks, and says so.
   */
  async remaining(_customerId: string, _itemId: string, _qty: number) {
    return { enforced: false as const, allowed: true, remaining: null as number | null, reason: 'Per-customer limits are not enforced until orders exist' };
  },
};
