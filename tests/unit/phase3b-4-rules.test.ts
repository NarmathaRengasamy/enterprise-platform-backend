import { describe, expect, it } from 'vitest';
import { familyOf, measureLabel, normaliseUnit, parseMeasureText, toMeasure, unitsOf } from '../../src/utils/units.util.js';
import { limitsService } from '../../src/services/limits.service.js';
import { pricePerUnit } from '../../src/services/price.service.js';
import { checkItemAttributes, checkVariantAxes, measureOf } from '../../src/services/attributeValidation.service.js';
import { variantService } from '../../src/services/variant.service.js';
import { derivedAvailable, packAvailability, productAvailability, rowsAvailability } from '../../src/services/availability.service.js';

/**
 * Phase 3b (measured sizes, price per unit, purchase limits) and Phase 4
 * (availability maths) — the pure rules, no database.
 */

const field = (over: Record<string, unknown>) => ({
  label: { en: 'Net quantity' },
  type: 'number',
  options: [],
  variant_forming: true,
  filterable: false,
  required: false,
  sort_order: 1,
  source: 'custom',
  deprecated: false,
  added_in_version: 1,
  ...over,
});

const TYPE = {
  fields: [
    field({ key: 'net_quantity', unit: 'ml', unit_family: 'volume' }),
    field({ key: 'weight', label: { en: 'Weight' }, unit: 'g', unit_family: 'weight' }),
    field({ key: 'seats', label: { en: 'Seats' } }),
    field({ key: 'colour', label: { en: 'Colour' }, type: 'enum', options: [{ value: 'red', label: { en: 'Red' }, deprecated: false }, { value: 'blue', label: { en: 'Blue' }, deprecated: false }] }),
  ],
};

/* ================================================================ units */

describe('units (R45)', () => {
  it('converts every unit to its family base unit', () => {
    expect(toMeasure(500, 'ml', 'volume', 'p')).toEqual({ amount: 500, unit: 'ml', base_amount: 500 });
    expect(toMeasure(1, 'L', 'volume', 'p')).toEqual({ amount: 1, unit: 'l', base_amount: 1000 });
    expect(toMeasure(1.5, 'kg', 'weight', 'p').base_amount).toBe(1500);
    expect(toMeasure(0.3, 'l', 'volume', 'p').base_amount).toBe(300); // no floating-point dust
    expect(toMeasure(2, 'm', 'length', 'p').base_amount).toBe(200);
    expect(toMeasure(6, 'piece', 'count', 'p').base_amount).toBe(6);
  });

  it('refuses another family, unknown units, amounts ≤ 0 and fractional pieces (422)', () => {
    expect(() => toMeasure(2, 'kg', 'volume', 'p')).toThrow(/kg is a weight unit/);
    expect(() => toMeasure(2, 'litres', 'volume', 'p')).toThrow(/not a unit we know/);
    expect(() => toMeasure(0, 'ml', 'volume', 'p')).toThrow(/above 0/);
    expect(() => toMeasure(-1, 'ml', 'volume', 'p')).toThrow(/above 0/);
    expect(() => toMeasure(1.5, 'piece', 'count', 'p')).toThrow(/whole number/);
  });

  it('reads and writes sizes as people do', () => {
    expect(measureLabel({ amount: 500, unit: 'ml' })).toBe('500 ml');
    expect(measureLabel({ amount: 1, unit: 'piece' })).toBe('1 piece');
    expect(measureLabel({ amount: 6, unit: 'piece' })).toBe('6 pieces');
    expect(parseMeasureText('1.5 L')).toEqual({ amount: 1.5, unit: 'l' });
    expect(parseMeasureText('2kg')).toEqual({ amount: 2, unit: 'kg' });
    expect(parseMeasureText('6 pcs')).toEqual({ amount: 6, unit: 'piece' });
    expect(parseMeasureText('large')).toBeNull();
    expect(normaliseUnit(' Kg ')).toBe('kg');
    expect(familyOf('ml')).toBe('volume');
    expect(unitsOf('length')).toEqual(['cm', 'm']);
  });
});

/* ============================================================ sizes as axes */

describe('measured-size variant options (R45)', () => {
  it('accepts sizes in the family, deduplicates exact repeats and keeps them as entered', () => {
    const axes = checkVariantAxes(TYPE, [{ key: 'net_quantity', values: [{ amount: 500, unit: 'ml' }, { amount: 1, unit: 'l' }, { amount: 500, unit: 'ml' }] } as any]);
    expect(axes).toEqual([{ key: 'net_quantity', values: [{ amount: 500, unit: 'ml' }, { amount: 1, unit: 'l' }] }]);
  });

  it('uses the field unit when a size gives none', () => {
    const [axis] = checkVariantAxes(TYPE, [{ key: 'net_quantity', values: [{ amount: 250 }] } as any]);
    expect(axis.values).toEqual([{ amount: 250, unit: 'ml' }]);
  });

  it('refuses the same size twice in two units (409), a wrong family (422), no sizes, text values and a number without a family', () => {
    const err = (() => {
      try {
        checkVariantAxes(TYPE, [{ key: 'net_quantity', values: [{ amount: 1, unit: 'l' }, { amount: 1000, unit: 'ml' }] } as any]);
      } catch (e: any) {
        return e;
      }
    })();
    expect(err.statusCode ?? err.status).toBe(409);
    expect(err.message).toMatch(/1 l and 1000 ml are the same size/);
    expect(() => checkVariantAxes(TYPE, [{ key: 'net_quantity', values: [{ amount: 2, unit: 'kg' }] } as any])).toThrow(/weight unit/);
    expect(() => checkVariantAxes(TYPE, [{ key: 'net_quantity', values: [] } as any])).toThrow(/at least one/);
    expect(() => checkVariantAxes(TYPE, [{ key: 'net_quantity', values: ['500ml'] } as any])).toThrow(/amount with a unit/);
    expect(() => checkVariantAxes(TYPE, [{ key: 'seats', values: [{ amount: 2, unit: 'piece' }] } as any])).toThrow(/without a unit family/);
  });

  it('allows one measured size per product, beside choice options', () => {
    expect(() =>
      checkVariantAxes(TYPE, [
        { key: 'net_quantity', values: [{ amount: 1, unit: 'l' }] },
        { key: 'weight', values: [{ amount: 1, unit: 'kg' }] },
      ] as any)
    ).toThrow(/only one measured size/);
    expect(checkVariantAxes(TYPE, [{ key: 'colour', values: ['red'] }, { key: 'weight', values: [{ amount: 500, unit: 'g' }] }] as any)).toHaveLength(2);
  });

  it('stores an item size as its base amount, so 1 l and 1000 ml sign the same (R20)', () => {
    const axes = [{ key: 'net_quantity', values: [{ amount: 500, unit: 'ml' }, { amount: 1, unit: 'l' }] }];
    const a = checkItemAttributes([{ key: 'net_quantity', value: { amount: 1000, unit: 'ml' } }], axes, 'item');
    const b = checkItemAttributes([{ key: 'net_quantity', value: 1000 }], axes, 'item');
    expect(a).toEqual([{ key: 'net_quantity', value: 1000 }]);
    expect(b).toEqual(a);
    expect(measureOf(a, axes)).toEqual({ amount: 1, unit: 'l', base_amount: 1000 });
    expect(() => checkItemAttributes([{ key: 'net_quantity', value: 750 }], axes, 'item')).toThrow(/not one of this product's net_quantity sizes/);
  });

  it('previews sizes with labels and SKUs; Colour × Size makes 4 combinations', () => {
    const axes = [
      { key: 'colour', values: ['red', 'blue'] },
      { key: 'weight', values: [{ amount: 500, unit: 'g' }, { amount: 1, unit: 'kg' }] },
    ];
    const combos = variantService.preview(axes, 'rice', new Set());
    expect(combos).toHaveLength(4);
    expect(combos[0]).toMatchObject({
      label: 'red · 500 g',
      attributes: [{ key: 'colour', value: 'red' }, { key: 'weight', value: 500 }],
      measure: { amount: 500, unit: 'g', base_amount: 500 },
      suggested_sku: 'RICE-RED-500G',
    });
    expect(combos[1].suggested_sku).toBe('RICE-RED-1KG');
  });

  it('keeps spaces in option values as hyphens in SKUs (only sizes lose them)', () => {
    const combos = variantService.preview([{ key: 'colour', values: ['off white'] }], 'tee', new Set());
    expect(combos[0].suggested_sku).toBe('TEE-OFF-WHITE');
  });
});

/* ========================================================= price per unit */

describe('price per unit (R46) — worked out, never stored', () => {
  const item = (amount_minor: number | null, measure: any, price_unit = 'each') => ({
    price: amount_minor === null ? null : { amount_minor, currency: 'INR', tax_inclusive: true, price_unit },
    measure,
  });

  it('per 100 below 1 kg / 1 l / 1 m; per kg / l / m from there; per piece for a count', () => {
    expect(pricePerUnit(item(18000, { amount: 500, unit: 'ml', base_amount: 500 }))).toMatchObject({ amount_minor: 3600, per: '100 ml' });
    expect(pricePerUnit(item(32000, { amount: 1, unit: 'l', base_amount: 1000 }))).toMatchObject({ amount_minor: 32000, per: 'l' });
    expect(pricePerUnit(item(150000, { amount: 5, unit: 'l', base_amount: 5000 }))).toMatchObject({ amount_minor: 30000, per: 'l' });
    expect(pricePerUnit(item(9900, { amount: 250, unit: 'g', base_amount: 250 }))).toMatchObject({ amount_minor: 3960, per: '100 g' });
    expect(pricePerUnit(item(50000, { amount: 2, unit: 'm', base_amount: 200 }))).toMatchObject({ amount_minor: 25000, per: 'm' });
    expect(pricePerUnit(item(60000, { amount: 6, unit: 'piece', base_amount: 6 }))).toMatchObject({ amount_minor: 10000, per: 'piece' });
  });

  it('rounds to whole paise', () => {
    expect(pricePerUnit(item(10000, { amount: 300, unit: 'ml', base_amount: 300 }))?.amount_minor).toBe(3333);
  });

  it('is null when not priced, without a size, or for an hour / day / month price', () => {
    expect(pricePerUnit(item(null, { amount: 1, unit: 'l', base_amount: 1000 }))).toBeNull();
    expect(pricePerUnit(item(10000, null))).toBeNull();
    expect(pricePerUnit(item(10000, { amount: 1, unit: 'l', base_amount: 1000 }, 'day'))).toBeNull();
  });
});

/* ======================================================== purchase limits */

describe('purchase limits (R50–R53)', () => {
  it('validates whole numbers ≥ 1, min ≤ max and every window, and windows that never shrink (422)', () => {
    const fails = (l: any) => {
      try {
        limitsService.validate(l);
        return null;
      } catch (e: any) {
        return e;
      }
    };
    expect(fails({ min_per_order: 3, max_per_order: 2 })?.message).toMatch(/minimum per order \(3\) is above the maximum \(2\)/);
    expect(fails({ per_customer: { day: 5, week: 3 } })?.message).toMatch(/7 days limit \(3\) is below the 24 hours limit \(5\)/);
    expect(fails({ max_per_order: 0 })?.message).toMatch(/whole number of 1 or more/);
    expect(fails({ max_per_order: 1.5 })?.message).toMatch(/whole number of 1 or more/);
    expect(fails({ min_per_order: 4, per_customer: { month: 3 } })?.message).toMatch(/above the 30 days limit/);
    expect(fails({ max_per_order: 1.5 })?.fieldErrors ?? fails({ max_per_order: 1.5 })?.errors).toBeTruthy();
    /* A max per order above a window is allowed — the smaller applies. */
    expect(fails({ max_per_order: 10, per_customer: { day: 2 } })).toBeNull();
  });

  it('stores null for "not sent as limits": nothing, or every value empty', () => {
    expect(limitsService.validate(undefined)).toBeUndefined();
    expect(limitsService.validate(null)).toBeNull();
    expect(limitsService.validate({ min_per_order: null, per_customer: { day: null } })).toBeNull();
    expect(limitsService.validate({ max_per_order: 2 })).toEqual({
      min_per_order: null,
      max_per_order: 2,
      per_customer: { day: null, week: null, month: null, year: null, lifetime: null },
    });
  });

  it('works out the effective limits: item → product → none', () => {
    const product = { min_per_order: 1, max_per_order: 2, per_customer: { month: 4 } };
    expect(limitsService.effective(product, { max_per_order: 1 })).toMatchObject({ min_per_order: 1, max_per_order: 1, per_customer: { month: 4 } });
    expect(limitsService.effective(product, null)).toMatchObject({ max_per_order: 2 });
    expect(limitsService.effective(null, null)).toEqual({ min_per_order: null, max_per_order: null, per_customer: { day: null, week: null, month: null, year: null, lifetime: null } });
  });

  it('refuses an item override that breaks the product limits it is combined with (422)', () => {
    expect(() => limitsService.assertEffective({ min_per_order: 2 }, [{ sku: 'A', purchase_limits: { max_per_order: 1 } }])).toThrow(/Item A/);
    expect(() => limitsService.assertEffective({ min_per_order: 1, max_per_order: 2 }, [{ sku: 'A', purchase_limits: { max_per_order: 1 } }])).not.toThrow();
  });

  it('describes limits in plain words', () => {
    expect(limitsService.summary(limitsService.validate({ min_per_order: 1, max_per_order: 2, per_customer: { month: 4 } }) as any)).toBe(
      'Max 2 per order · 4 per customer every 30 days'
    );
    expect(limitsService.summary(limitsService.validate({ min_per_order: 2, per_customer: { day: 3, lifetime: 10 } }) as any)).toBe(
      'Min 2 per order · 3 per customer every 24 hours · 10 per customer in total'
    );
    expect(limitsService.summary(null)).toBe('');
  });

  it('counts single units against product limits: packs as quantity × pack (R52)', () => {
    expect(limitsService.unitsOf({ pack_of: { quantity: 4 } }, 2)).toBe(8);
    expect(limitsService.unitsOf({ pack_of: null }, 3)).toBe(3);
    expect(limitsService.productUnits([{ item: {}, qty: 1 }, { item: { pack_of: { quantity: 4 } }, qty: 2 }])).toBe(9);
  });

  it('says per-customer limits are not enforced until orders exist', async () => {
    expect(await limitsService.remaining('c', 'i', 1)).toMatchObject({ enforced: false, allowed: true });
  });
});

/* ============================================================ availability */

describe('availability maths (Phase 4)', () => {
  it('adds stock rows up and flags low stock against the reorder point', () => {
    expect(rowsAvailability([])).toMatchObject({ status: 'tracked', on_hand: 0, available: 0, low_stock: false });
    expect(rowsAvailability([{ item_id: 'a', on_hand: 5, reserved: 1, reorder_point: 4 }])).toMatchObject({ available: 4, low_stock: true });
    expect(rowsAvailability([{ item_id: 'a', on_hand: 9, reserved: 0, reorder_point: 4 }])).toMatchObject({ low_stock: false });
  });

  it('a bundle of 2× A (5 available) + 1× B (1 available) makes 1; an untracked part makes it untracked', () => {
    expect(derivedAvailable([{ available: 5, quantity: 2 }, { available: 1, quantity: 1 }])).toBe(1);
    expect(derivedAvailable([{ available: 5, quantity: 2 }, { available: null, quantity: 1 }])).toBeNull();
    expect(derivedAvailable([])).toBeNull();
  });

  it('a box of 4 from 10 singles makes 2, per location (never borrowing across)', () => {
    expect(packAvailability(true, [{ item_id: 's', on_hand: 10, reserved: 0 }], 4)).toMatchObject({ available: 2, from: 'pack' });
    expect(packAvailability(true, [{ item_id: 's', location_id: 'a', on_hand: 3 }, { item_id: 's', location_id: 'b', on_hand: 3 }], 4)).toMatchObject({ available: 0 });
    expect(packAvailability(false, [], 4)).toEqual({ status: 'not_tracked' });
  });

  it("a product's total never counts packs on top of their singles", () => {
    const byItem = new Map<string, any>([
      ['single', { status: 'tracked', available: 10 }],
      ['box', { status: 'tracked', available: 2, from: 'pack' }],
    ]);
    const items = [{ id: 'single', status: 'active' }, { id: 'box', status: 'active', pack_of: { base_item_id: 'single', quantity: 4 } }];
    expect(productAvailability(items, byItem)).toEqual({ status: 'tracked', available: 10 });
    expect(productAvailability([], byItem)).toEqual({ status: 'not_tracked' });
  });
});
