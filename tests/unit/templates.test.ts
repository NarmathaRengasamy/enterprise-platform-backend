import { describe, expect, it } from 'vitest';
import { optionValue, templatesService, toFieldDefinition, validateTemplate } from '../../src/services/templates.service.js';
import { keyFromLabel, similarOption } from '../../src/services/productType.service.js';

describe('templates (Phase 1b: basic fields only)', () => {
  it('ships ecommerce, car_dealership and general (D3), all at version 2', () => {
    expect(templatesService.codes().sort()).toEqual(['car_dealership', 'ecommerce', 'general']);
    for (const t of templatesService.list()) expect(t.version).toBe(2);
  });

  it('pre-loads the agreed basic fields', () => {
    expect(templatesService.get('ecommerce')!.fields.map((f) => f.key)).toEqual(['brand', 'material', 'gender']);
    expect(templatesService.get('car_dealership')!.fields.map((f) => f.key)).toEqual(['make', 'model', 'body_type']);
    expect(templatesService.get('general')!.fields.map((f) => f.key)).toEqual(['brand', 'material']);
  });

  it('pre-loads no variant fields (R41)', () => {
    for (const t of templatesService.list()) {
      expect(t.fields.some((f) => f.variant_forming)).toBe(false);
    }
  });

  it('marks make and model as required for cars', () => {
    const car = templatesService.get('car_dealership')!;
    expect(car.fields.filter((f) => f.required).map((f) => f.key)).toEqual(['make', 'model']);
    expect(car.default_tracking).toBe('serial');
  });

  it('only lists visible fields that exist in the template', () => {
    for (const t of templatesService.list()) {
      const keys = new Set(t.fields.map((f) => f.key));
      const walk = (cats: any[]): void =>
        cats.forEach((c) => {
          (c.visible_field_keys ?? []).forEach((k: string) => expect(keys.has(k)).toBe(true));
          walk(c.children ?? []);
        });
      walk(t.starter_categories);
    }
  });

  it('starter categories set no fulfilment or tracking (R13, Phase 2b)', () => {
    for (const t of templatesService.list()) {
      const walk = (cats: any[]): void =>
        cats.forEach((c) => {
          expect(c).not.toHaveProperty('fulfilment');
          expect(c).not.toHaveProperty('tracking');
          walk(c.children ?? []);
        });
      walk(t.starter_categories);
    }
    const car = templatesService.get('car_dealership')!;
    expect(car.starter_categories.map((c) => c.code)).toEqual(['cars', 'accessories', 'service']);
    expect(car).toMatchObject({ default_fulfilment: 'goods', default_tracking: 'serial' }); // the product defaults stay
  });

  it('refuses at load a starter category that sets fulfilment or tracking, even nested', () => {
    const car = templatesService.get('car_dealership')!;
    const withCats = (starter_categories: any[]) => ({ ...car, starter_categories }) as any;
    expect(() => validateTemplate(withCats([{ code: 'service', name: { en: 'Service' }, fulfilment: 'service' }]))).toThrow(
      /starter category "service": categories do not set fulfilment or tracking/
    );
    expect(() =>
      validateTemplate(withCats([{ code: 'cars', name: { en: 'Cars' }, children: [{ code: 'suv', name: { en: 'SUV' }, tracking: 'serial' }] }]))
    ).toThrow(/starter category "suv"/);
    expect(() => validateTemplate(car)).not.toThrow();
  });

  it('turns options into stable values', () => {
    expect(optionValue('Free size')).toBe('free_size');
    expect(optionValue('Certified pre-owned')).toBe('certified_pre_owned');
  });

  it('converts a template field into a stored definition', () => {
    const f = toFieldDefinition(templatesService.get('car_dealership')!.fields[2], 3, 1);
    expect(f).toMatchObject({ key: 'body_type', type: 'enum', source: 'template', sort_order: 3, variant_forming: false });
    expect(f.options[2]).toEqual({ value: 'suv', label: { en: 'SUV' }, deprecated: false });
  });
});

describe('keyFromLabel', () => {
  it.each([
    ['Warranty (Months)', 'warranty_months'],
    ['  Seats  ', 'seats'],
    ['4WD available', 'f_4wd_available'],
    ['Engine — CC', 'engine_cc'],
  ])('%s → %s', (label, key) => expect(keyFromLabel(label)).toBe(key));
});

describe('similarOption (near-duplicate check)', () => {
  const colours = ['red', 'blue', 'off_white'];
  it.each([
    ['rde', 'red'], // swapped letters
    ['reds', 'red'], // plural
    ['bleu', 'blue'], // swapped letters
    ['blu', 'blue'], // one missing
    ['offwhite', 'off_white'], // spacing
  ])('%s looks like %s', (value, like) => expect(similarOption(value, colours)).toBe(like));

  it.each(['green', 'maroon', 'black'])('%s is new', (value) => expect(similarOption(value, colours)).toBeUndefined());

  it('does not flag short, genuinely different values', () => {
    expect(similarOption('l', ['s', 'm'])).toBeUndefined();
    expect(similarOption('xl', ['s', 'm', 'l'])).toBeUndefined();
  });
});
