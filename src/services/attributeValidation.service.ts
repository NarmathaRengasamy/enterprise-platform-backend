import { AppError } from '../middlewares/errorHandler.js';
import type { FieldDefinition } from '../types/productType.types.js';
import { familyOf, Measure, measureLabel, toMeasure, UNITS, UnitFamily } from '../utils/units.util.js';

/**
 * Checks attribute values against the tenant's attribute library (design §10).
 *
 * Products never define attributes of their own (R40): every key must exist in
 * the active product type. A retired attribute or option keeps the values
 * already stored (K7) but takes no new ones.
 */

export interface AttributeValue {
  key: string;
  value: unknown;
}

/** A measured size on a variant axis (R45), e.g. { amount: 500, unit: "ml" }. */
export interface MeasuredValue {
  amount: number;
  unit: string;
}

export type AxisValue = string | MeasuredValue;

export interface VariantAxis {
  key: string;
  /** Option values for a choice attribute; amounts with a unit for a measured size. */
  values: AxisValue[];
}

/** A measured-size axis holds amounts with a unit instead of option values. */
export const isMeasuredAxis = (axis: VariantAxis): boolean => axis.values.some((v) => typeof v === 'object' && v !== null);

const baseOf = (v: MeasuredValue) => Math.round(v.amount * (UNITS[v.unit]?.factor ?? 1) * 1e6) / 1e6;

/**
 * How an axis value is written in an item's attributes and signature: the
 * option value itself, or a size's base amount ("1000" for 1 l), so 1 l and
 * 1000 ml are the same size (R20).
 */
export const axisValueKey = (v: AxisValue): string => (typeof v === 'string' ? v : String(baseOf(v)));
export const axisValueKeys = (axis: VariantAxis): string[] => axis.values.map(axisValueKey);

/** "Red", or "500 ml" for a size. */
export const axisValueLabel = (v: AxisValue): string => (typeof v === 'string' ? v : measureLabel(v));

export const TEXT_MAX = 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (message: string, path: string) => new AppError(message, 422, undefined, { [path]: message });
const conflict = (message: string, path: string) => new AppError(message, 409, undefined, { [path]: message });

const fieldMap = (type: any): Map<string, FieldDefinition> =>
  new Map(((type?.fields ?? []) as FieldDefinition[]).map((f) => [f.key, f]));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const liveOptions = (f: FieldDefinition) => f.options.filter((o) => !o.deprecated).map((o) => o.value);

/** One value, typed by its field. Returns the value as it will be stored. */
export const checkValue = (f: FieldDefinition, value: unknown, path: string, kept = false): unknown => {
  const name = f.label?.en ?? f.key;
  switch (f.type) {
    case 'enum': {
      const allowed = kept ? f.options.map((o) => o.value) : liveOptions(f);
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw invalid(`${name}: "${String(value)}" is not one of ${liveOptions(f).join(', ') || '(no options yet)'}`, path);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${name} must be a number`, path);
      if (f.min !== undefined && value < f.min) throw invalid(`${name} must be at least ${f.min}`, path);
      if (f.max !== undefined && value > f.max) throw invalid(`${name} must be at most ${f.max}`, path);
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(`${name} must be true or false`, path);
      return value;
    case 'date': {
      const d = typeof value === 'string' && DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
      if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
        throw invalid(`${name} must be a date as YYYY-MM-DD`, path);
      }
      return value;
    }
    case 'text': {
      if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} must be text`, path);
      if (value.length > TEXT_MAX) throw invalid(`${name} can be at most ${TEXT_MAX} characters`, path);
      return value.trim();
    }
    case 'translated_text': {
      const t = value as Record<string, unknown>;
      if (!t || typeof t !== 'object' || typeof t.en !== 'string' || !t.en.trim()) {
        throw invalid(`${name} needs at least an English value`, path);
      }
      const out: Record<string, string> = {};
      for (const lang of ['en', 'ta', 'hi']) {
        const v = t[lang];
        if (v === undefined || v === '') continue;
        if (typeof v !== 'string' || v.length > TEXT_MAX) throw invalid(`${name} (${lang}) must be text of at most ${TEXT_MAX} characters`, path);
        out[lang] = v.trim();
      }
      return out;
    }
    default:
      throw invalid(`${name} has an unsupported type`, path);
  }
};

/**
 * Measured sizes for one axis (R45): each an amount with a unit from the
 * attribute's family (the attribute's own unit when none is given), at least
 * one, stored as entered. The same size twice (1 l and 1000 ml) → 409.
 */
const checkMeasuredValues = (f: FieldDefinition, values: unknown[], path: string): MeasuredValue[] => {
  const name = f.label.en;
  const family = f.unit_family as UnitFamily;
  if (!values?.length) throw invalid(`Enter at least one ${name} size`, path);
  const out: MeasuredValue[] = [];
  const byBase = new Map<number, MeasuredValue>();
  values.forEach((v, j) => {
    const at = `${path}.values.${j}`;
    if (typeof v !== 'object' || v === null) throw invalid(`${name}: give each size as an amount with a unit, e.g. { amount: 500, unit: "ml" }`, at);
    const m = toMeasure((v as any).amount, (v as any).unit ?? f.unit, family, at, name);
    const before = byBase.get(m.base_amount);
    if (before) {
      if (before.amount === m.amount && before.unit === m.unit) return; // the same size sent twice
      throw conflict(`${name}: ${measureLabel(before)} and ${measureLabel(m)} are the same size`, at);
    }
    const value = { amount: m.amount, unit: m.unit };
    byBase.set(m.base_amount, value);
    out.push(value);
  });
  return out;
};

/**
 * The variant options a product is built from (R43, R45): each an enum
 * attribute usable for variants with at least one of its live options chosen,
 * or a number attribute with a unit family with at least one positive amount
 * in that family. At most one measured size per product (an item has one measure).
 */
export const checkVariantAxes = (type: any, axes: VariantAxis[], existing: VariantAxis[] = []): VariantAxis[] => {
  const fields = fieldMap(type);
  const seen = new Set<string>();
  let measured = 0;
  return axes.map((axis, i) => {
    const path = `variant_axes.${i}`;
    const f = fields.get(axis.key);
    if (!f) throw invalid(`Unknown attribute "${axis.key}" — add it in Attributes first`, path);
    if (seen.has(axis.key)) throw invalid(`${f.label.en} is a variant option twice`, path);
    seen.add(axis.key);
    const was = existing.find((e) => e.key === axis.key);
    if (f.type === 'number') {
      if (!f.unit_family) {
        throw invalid(`${f.label.en} is a number without a unit family, so it cannot be a variant option — set its unit family in Attributes`, path);
      }
      if (!f.variant_forming) throw invalid(`${f.label.en} is not set up to be used for variants`, path);
      if (f.deprecated && !was) throw invalid(`${f.label.en} is retired`, path);
      if (++measured > 1) throw invalid('A product can have only one measured size (e.g. Net quantity) among its variant options', path);
      return { key: axis.key, values: checkMeasuredValues(f, axis.values, path) };
    }
    if (f.type !== 'enum') throw invalid(`${f.label.en} is not a choice list, so it cannot be a variant option`, path);
    if (!f.variant_forming) throw invalid(`${f.label.en} is not set up to be used for variants`, path);
    const kept = new Set(was?.values ?? []);
    if (f.deprecated && !kept.size) throw invalid(`${f.label.en} is retired`, path);
    if (!axis.values?.length) throw invalid(`Choose at least one ${f.label.en} option`, path);
    const values = [...new Set(axis.values)];
    for (const v of values) {
      if (!kept.has(v)) checkValue(f, v, path);
    }
    return { key: axis.key, values };
  });
};

/**
 * A product's own values: library keys only, no variant option among them,
 * and only fields its categories show (R12, R15b). Stored values of retired
 * fields or options are kept as they are (K7).
 */
export const checkProductAttributes = (
  type: any,
  values: AttributeValue[],
  opts: { axes: VariantAxis[]; visible: Set<string> | null; existing?: AttributeValue[] }
): AttributeValue[] => {
  const fields = fieldMap(type);
  const axisKeys = new Set(opts.axes.map((a) => a.key));
  const existing = new Map((opts.existing ?? []).map((a) => [a.key, a.value]));
  const seen = new Set<string>();
  return values.map((a, i) => {
    const path = `attributes.${i}`;
    const f = fields.get(a.key);
    if (!f) throw invalid(`Unknown attribute "${a.key}" — add it in Attributes first`, path);
    if (seen.has(a.key)) throw invalid(`${f.label.en} is given twice`, path);
    seen.add(a.key);
    if (axisKeys.has(a.key)) throw invalid(`${f.label.en} is a variant option, so its value belongs on each item`, path);
    const kept = existing.has(a.key) && same(existing.get(a.key), a.value);
    if (kept) return { key: a.key, value: a.value };
    if (f.deprecated) throw invalid(`${f.label.en} is retired and takes no new values`, path);
    if (opts.visible && !opts.visible.has(a.key)) {
      throw invalid(`${f.label.en} is not shown for this product's categories`, path);
    }
    return { key: a.key, value: checkValue(f, a.value, path) };
  });
};

/** Keys that must have a value before publishing: required, live and shown. */
export const missingRequired = (type: any, values: AttributeValue[], axes: VariantAxis[], visible: Set<string> | null): FieldDefinition[] => {
  const have = new Set([...values.map((v) => v.key), ...axes.map((a) => a.key)]);
  return ((type?.fields ?? []) as FieldDefinition[]).filter(
    (f) => f.required && !f.deprecated && (!visible || visible.has(f.key)) && !have.has(f.key)
  );
};

/** Sorted `key=value` pairs joined with "|" — the identity of a combination (R20). */
export const signatureOf = (values: AttributeValue[]): string =>
  [...values]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((a) => `${a.key}=${String(a.value)}`)
    .join('|');

/**
 * One item's size: given as the base amount (as the variant preview returns it)
 * or as an amount with a unit; it must be one of the axis's sizes. Returns the
 * base amount, which is what the item stores in its attributes.
 */
const itemSize = (value: unknown, axis: VariantAxis, path: string): number | null => {
  const sizes = axis.values as MeasuredValue[];
  let base: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) base = value;
  else if (typeof value === 'object' && value !== null) {
    const family = familyOf(sizes[0]?.unit);
    if (!family) return null;
    base = toMeasure((value as any).amount, (value as any).unit, family, path, axis.key).base_amount;
  }
  return base !== null && sizes.some((s) => baseOf(s) === base) ? base : null;
};

/** The item's measure (R45) from its size value; null when the product has no measured size. */
export const measureOf = (attributes: AttributeValue[], axes: VariantAxis[]): Measure | null => {
  const axis = axes.find(isMeasuredAxis);
  if (!axis) return null;
  const base = attributes.find((a) => a.key === axis.key)?.value;
  const size = (axis.values as MeasuredValue[]).find((s) => baseOf(s) === base);
  return size ? { amount: size.amount, unit: size.unit, base_amount: baseOf(size) } : null;
};

/** An item's values: exactly one chosen option (or size) per variant axis, nothing else. */
export const checkItemAttributes = (values: AttributeValue[], axes: VariantAxis[], path: string): AttributeValue[] => {
  const byKey = new Map(axes.map((a) => [a.key, a]));
  const seen = new Set<string>();
  const sizeOf = new Map<string, number>();
  for (const [i, a] of values.entries()) {
    const axis = byKey.get(a.key);
    if (!axis) {
      throw invalid(
        axes.length ? `"${a.key}" is not one of this product's variant options` : 'This product has no variant options, so its item takes no values',
        `${path}.attributes.${i}`
      );
    }
    if (seen.has(a.key)) throw invalid(`"${a.key}" is given twice`, `${path}.attributes.${i}`);
    seen.add(a.key);
    if (isMeasuredAxis(axis)) {
      const base = itemSize(a.value, axis, `${path}.attributes.${i}`);
      if (base === null) {
        throw invalid(
          `That is not one of this product's ${a.key} sizes (${axis.values.map(axisValueLabel).join(', ')})`,
          `${path}.attributes.${i}`
        );
      }
      sizeOf.set(a.key, base);
      continue;
    }
    if (typeof a.value !== 'string' || !axis.values.includes(a.value)) {
      throw invalid(`"${String(a.value)}" is not one of this product's ${a.key} options (${axis.values.join(', ')})`, `${path}.attributes.${i}`);
    }
  }
  const missing = axes.filter((a) => !seen.has(a.key)).map((a) => a.key);
  if (missing.length) throw invalid(`Each item needs a value for ${missing.join(', ')}`, `${path}.attributes`);
  /* A size is stored as its base amount, so 1 l and 1000 ml sign the same (R20). */
  return axes
    .map((axis) => values.find((v) => v.key === axis.key)!)
    .map((v) => ({ key: v.key, value: sizeOf.has(v.key) ? sizeOf.get(v.key)! : v.value }));
};
