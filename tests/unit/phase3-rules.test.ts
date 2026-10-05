import { describe, expect, it } from 'vitest';
import {
  checkItemAttributes,
  checkProductAttributes,
  checkValue,
  checkVariantAxes,
  missingRequired,
  signatureOf,
} from '../../src/services/attributeValidation.service.js';
import { countCombinations, suggestSku, variantService } from '../../src/services/variant.service.js';
import { resolvePrice } from '../../src/services/price.service.js';
import { slugify } from '../../src/services/productV2.service.js';

const field = (over: Record<string, unknown>) => ({
  key: 'k',
  label: { en: 'K' },
  type: 'text',
  options: [],
  variant_forming: false,
  filterable: false,
  required: false,
  sort_order: 1,
  source: 'custom',
  deprecated: false,
  added_in_version: 1,
  ...over,
});

const opt = (value: string, deprecated = false) => ({ value, label: { en: value }, deprecated });
const TYPE = {
  fields: [
    field({ key: 'make', label: { en: 'Make' }, required: true }),
    field({ key: 'fuel', label: { en: 'Fuel' }, type: 'enum', variant_forming: true, options: [opt('petrol'), opt('diesel'), opt('lpg', true)] }),
    field({ key: 'body', label: { en: 'Body' }, type: 'enum', options: [opt('suv')] }),
    field({ key: 'seats', label: { en: 'Seats' }, type: 'number', min: 2, max: 9 }),
    field({ key: 'launch', label: { en: 'Launch' }, type: 'date' }),
    field({ key: 'awd', label: { en: 'AWD' }, type: 'boolean' }),
    field({ key: 'tagline', label: { en: 'Tagline' }, type: 'translated_text' }),
    field({ key: 'old', label: { en: 'Old' }, deprecated: true }),
  ],
};
const f = (key: string) => TYPE.fields.find((x) => x.key === key) as any;

describe('checkValue — each field type', () => {
  it.each([
    ['fuel', 'petrol', 'petrol'],
    ['seats', 7, 7],
    ['launch', '2026-02-28', '2026-02-28'],
    ['awd', false, false],
    ['make', '  Hyundai ', 'Hyundai'],
    ['tagline', { en: 'Bold', ta: 'துணிவு', hi: '' }, { en: 'Bold', ta: 'துணிவு' }],
  ])('%s accepts %j', (key, value, stored) => expect(checkValue(f(key), value, 'p')).toEqual(stored));

  it.each([
    ['fuel', 'steam', /not one of petrol, diesel/],
    ['fuel', 'lpg', /not one of/], // retired option: no new values
    ['seats', 12, /at most 9/],
    ['seats', '7', /must be a number/],
    ['launch', '2026-02-30', /YYYY-MM-DD/],
    ['awd', 'yes', /true or false/],
    ['make', 'x'.repeat(1001), /at most 1000/],
    ['tagline', { ta: 'only tamil' }, /English/],
  ])('%s refuses %j', (key, value, message) => expect(() => checkValue(f(key), value, 'p')).toThrow(message));

  it('keeps a retired option already stored (K7)', () => {
    expect(checkValue(f('fuel'), 'lpg', 'p', true)).toBe('lpg');
  });
});

describe('variant axes and item combinations', () => {
  it('accepts a variant-ready choice list and refuses anything else', () => {
    expect(checkVariantAxes(TYPE, [{ key: 'fuel', values: ['petrol', 'petrol', 'diesel'] }])).toEqual([{ key: 'fuel', values: ['petrol', 'diesel'] }]);
    expect(() => checkVariantAxes(TYPE, [{ key: 'body', values: ['suv'] }])).toThrow(/not set up to be used for variants/);
    /* A number can be a variant option only with a unit family (measured sizes, Phase 3b). */
    expect(() => checkVariantAxes(TYPE, [{ key: 'seats', values: ['2'] }])).toThrow(/number without a unit family/);
    expect(() => checkVariantAxes(TYPE, [{ key: 'fuel', values: [] }])).toThrow(/at least one/);
    expect(() => checkVariantAxes(TYPE, [{ key: 'fuel', values: ['petrol'] }, { key: 'fuel', values: ['diesel'] }])).toThrow(/twice/);
  });

  it('needs exactly one value per axis on an item, in axis order', () => {
    const axes = [{ key: 'fuel', values: ['petrol'] }];
    expect(checkItemAttributes([{ key: 'fuel', value: 'petrol' }], axes, 'items.0')).toEqual([{ key: 'fuel', value: 'petrol' }]);
    expect(() => checkItemAttributes([], axes, 'items.0')).toThrow(/needs a value for fuel/);
    expect(() => checkItemAttributes([{ key: 'fuel', value: 'diesel' }], axes, 'items.0')).toThrow(/not one of this product's fuel options/);
    expect(() => checkItemAttributes([{ key: 'fuel', value: 'x' }], [], 'items.0')).toThrow(/no variant options/);
  });

  it('signs a combination independent of key order', () => {
    expect(signatureOf([{ key: 'z', value: 1 }, { key: 'a', value: 'b' }])).toBe('a=b|z=1');
  });
});

describe('product attributes and publish requirements', () => {
  it('refuses unknown keys, variant keys and hidden fields; keeps retired stored values', () => {
    const axes = [{ key: 'fuel', values: ['petrol'] }];
    expect(() => checkProductAttributes(TYPE, [{ key: 'wings', value: 1 }], { axes, visible: null })).toThrow(/Unknown attribute/);
    expect(() => checkProductAttributes(TYPE, [{ key: 'fuel', value: 'petrol' }], { axes, visible: null })).toThrow(/variant option/);
    expect(() => checkProductAttributes(TYPE, [{ key: 'seats', value: 5 }], { axes, visible: new Set(['make']) })).toThrow(/not shown/);
    expect(() => checkProductAttributes(TYPE, [{ key: 'old', value: 'x' }], { axes, visible: null })).toThrow(/retired/);
    expect(checkProductAttributes(TYPE, [{ key: 'old', value: 'x' }], { axes, visible: null, existing: [{ key: 'old', value: 'x' }] })).toEqual([{ key: 'old', value: 'x' }]);
  });

  it('lists required fields that are missing and shown', () => {
    expect(missingRequired(TYPE, [], [], null).map((x) => x.key)).toEqual(['make']);
    expect(missingRequired(TYPE, [], [], new Set(['seats']))).toEqual([]); // not shown for these categories
    expect(missingRequired(TYPE, [{ key: 'make', value: 'H' }], [], null)).toEqual([]);
  });
});

describe('variant preview, SKUs, slugs and prices', () => {
  it('builds the cartesian product with suggested SKUs and marks existing ones', () => {
    const axes = [{ key: 'fuel', values: ['petrol', 'diesel'] }, { key: 'colour', values: ['red', 'off white'] }];
    const combos = variantService.preview(axes, 'creta', new Set(['colour=red|fuel=petrol']));
    expect(combos.map((c) => c.suggested_sku)).toEqual(['CRETA-PETROL-RED', 'CRETA-PETROL-OFF-WHITE', 'CRETA-DIESEL-RED', 'CRETA-DIESEL-OFF-WHITE']);
    expect(combos.map((c) => c.exists)).toEqual([true, false, false, false]);
    expect(countCombinations([])).toBe(0);
    expect(suggestSku('', [])).toBe('ITEM');
  });

  it('caps at 500 combinations', () => {
    const ten = Array.from({ length: 10 }, (_, i) => String(i));
    expect(() => variantService.preview([{ key: 'a', values: ten }, { key: 'b', values: ten }, { key: 'c', values: ten }], 'x')).toThrow(/1000 combinations/);
    expect(variantService.preview([{ key: 'a', values: ten }, { key: 'b', values: ten }, { key: 'c', values: ten.slice(0, 5) }], 'x')).toHaveLength(500);
  });

  it('makes URL-safe slugs', () => {
    expect(slugify('Hyundai Creta 1.5 (SX)')).toBe('hyundai-creta-1-5-sx');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('கார்')).toBe('product');
  });

  it('reads a price through resolvePrice: null means not priced, ₹0 is a price', () => {
    expect(resolvePrice({ price: null })).toBeNull();
    expect(resolvePrice(null)).toBeNull();
    expect(resolvePrice({ price: { amount_minor: 0 } })).toEqual({ amount_minor: 0, currency: 'INR', tax_inclusive: true, price_unit: 'each' });
  });
});
