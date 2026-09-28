import { CatalogItemModel, CatalogProductModel } from '../models.js';

/** One value in use, and how many records carry it. */
export interface VocabularyEntry {
  value: string;
  count: number;
}

/**
 * The values already recorded for one attribute key, with usage counts.
 *
 * Why this is not `distinct('attributes.value', { 'attributes.key': key })`:
 * that filter selects **documents** having an attribute with the key, and then
 * collects every attribute value on them — so asking for `colour` came back
 * with the storage sizes and grades of every product that happens to have a
 * colour. The casing vocabulary was built from that list, which meant typing
 * "touch" into an unrelated field could be snapped to a "Touch" that belongs
 * to a different field entirely.
 *
 * Unwinding first is what keeps the key and the value together.
 *
 * Both collections are read because an open field can be used at either scope:
 * a variant-forming one records its values on the items, a product-level one
 * on the product. The count is therefore "records using this value" — items
 * for a variant axis, products for a product-level field — which is what makes
 * a settled value distinguishable from a one-off typo.
 */
export const attributeVocabulary = async (key: string): Promise<VocabularyEntry[]> => {
  const pipeline = [
    { $match: { 'attributes.key': key } },
    { $unwind: '$attributes' },
    { $match: { 'attributes.key': key } },
    { $group: { _id: '$attributes.value', count: { $sum: 1 } } },
  ];

  const [items, products] = await Promise.all([
    CatalogItemModel.aggregate(pipeline),
    CatalogProductModel.aggregate(pipeline),
  ]);

  const totals = new Map<string, number>();
  for (const row of [...items, ...products] as { _id: unknown; count: number }[]) {
    const value = String(row._id);
    if (!value || value === 'null' || value === 'undefined') continue;
    totals.set(value, (totals.get(value) ?? 0) + row.count);
  }

  return [...totals.entries()]
    .map(([value, count]) => ({ value, count }))
    /* Most used first: promoting a discovered list should put the values that
       have earned their place at the top, and the one-off typos at the bottom
       where they are easy to spot. */
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

/** Just the spellings, for the casing vocabulary. */
export const distinctAttributeValues = async (key: string): Promise<string[]> =>
  (await attributeVocabulary(key)).map((entry) => entry.value);
