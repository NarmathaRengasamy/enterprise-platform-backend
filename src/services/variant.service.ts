import { AppError } from '../middlewares/errorHandler.js';
import { AttributeValue, AxisValue, axisValueKey, axisValueLabel, measureOf, signatureOf, VariantAxis } from './attributeValidation.service.js';
import type { Measure } from '../utils/units.util.js';

/**
 * The variant builder's preview (design §7.5, R19): every combination of the
 * chosen options, each with a suggested SKU. Nothing is saved — the user ticks
 * the combinations actually sold and those become items.
 */

export const MAX_COMBINATIONS = 500;

const skuPart = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase();

/** `{SLUG-UPPER}-{VALUE1}-{VALUE2}`, e.g. CRETA-PETROL-RED (at most 64 characters). */
export const suggestSku = (slug: string, attributes: AttributeValue[]): string =>
  [skuPart(slug) || 'ITEM', ...attributes.map((a) => skuPart(String(a.value)))].join('-').slice(0, 64);

export interface Combination {
  /** A size is given as its base amount (1000 for 1 l) — send it back as is when creating the item. */
  attributes: AttributeValue[];
  attribute_signature: string;
  /** "Red · 500 ml" */
  label: string;
  /** The measured size (R45); null when the product has none. */
  measure: Measure | null;
  suggested_sku: string;
  /** Already an item of this product (K4: only new combinations are offered). */
  exists: boolean;
}

export const countCombinations = (axes: VariantAxis[]) => axes.reduce((n, a) => n * a.values.length, axes.length ? 1 : 0);

export const variantService = {
  preview(axes: VariantAxis[], slug: string, existingSignatures: Set<string> = new Set()): Combination[] {
    const total = countCombinations(axes);
    if (total > MAX_COMBINATIONS) {
      throw new AppError(`${total} combinations — at most ${MAX_COMBINATIONS} per product. Choose fewer options.`, 422, undefined, {
        variant_axes: `At most ${MAX_COMBINATIONS} combinations`,
      });
    }
    if (!total) return [];
    let combos: { key: string; value: AxisValue }[][] = [[]];
    for (const axis of axes) {
      combos = combos.flatMap((combo) => axis.values.map((value) => [...combo, { key: axis.key, value }]));
    }
    return combos.map((combo) => {
      /* Sizes sign by their base amount, so 1 l and 1000 ml are the same combination (R20). */
      const attributes = combo.map((c) => ({ key: c.key, value: typeof c.value === 'string' ? c.value : Number(axisValueKey(c.value)) }));
      const labels = combo.map((c) => ({ key: c.key, value: axisValueLabel(c.value) }));
      const attribute_signature = signatureOf(attributes);
      return {
        attributes,
        attribute_signature,
        label: labels.map((l) => l.value).join(' · '),
        measure: measureOf(attributes, axes),
        /* "500 ml" → OIL-500ML, not OIL-500 */
        suggested_sku: suggestSku(slug, labels.map((l) => ({ key: l.key, value: l.value.replace(/\s+/g, '') }))),
        exists: existingSignatures.has(attribute_signature),
      };
    });
  },
};
