import { AppError } from '../../middlewares/errorHandler.js';
import { ProductTypeModel } from '../models.js';
import type { AttributeValue, FieldDefinition, ProductType } from '../types.js';

/**
 * The type registry: validation driven by configuration rather than by code.
 *
 * A v1 product had a fixed shape, so its rules lived in a Zod schema. Here the
 * shape is data — a tenant declares "Vehicle has Fuel, Trim and Colour" — which
 * means validation has to be built from the declaration at request time.
 */

/** Cached for the life of a request batch; types change rarely, reads are hot. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; type: ProductType }>();

export const invalidateTypeCache = (typeId?: string): void => {
  if (typeId) cache.delete(typeId);
  else cache.clear();
};

export const loadType = async (typeId: string): Promise<ProductType> => {
  const hit = cache.get(typeId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.type;

  const doc = await ProductTypeModel.findOne({ id: typeId }).lean();
  if (!doc) throw new AppError(`Product type '${typeId}' not found`, 404);

  const type = doc as unknown as ProductType;
  cache.set(typeId, { at: Date.now(), type });
  return type;
};

export const fieldsOf = (type: ProductType): FieldDefinition[] => type.fields ?? [];

export const variantFormingFields = (type: ProductType): FieldDefinition[] =>
  fieldsOf(type).filter((f) => f.variantForming && !f.deprecated);

export const productLevelFields = (type: ProductType): FieldDefinition[] =>
  fieldsOf(type).filter((f) => !f.variantForming);

/* ------------------------------------------------------------ validation */

interface ValidateOptions {
  /** Validate only variant-forming fields (an item) or only the rest (a product). */
  scope: 'product' | 'item';
  /** Partial updates must not fail on fields the caller did not send. */
  partial?: boolean;
}

/**
 * Checks attribute values against the type, and returns them normalised.
 *
 * Unknown keys are rejected rather than ignored. Silently dropping them is how
 * a typo in an import turns into a product that is missing a filter facet and
 * nobody notices for a month.
 */
export const validateAttributes = (
  type: ProductType,
  attributes: AttributeValue[] | undefined,
  { scope, partial = false }: ValidateOptions
): AttributeValue[] => {
  const supplied = attributes ?? [];
  const relevant = scope === 'item' ? variantFormingFields(type) : productLevelFields(type);
  const byKey = new Map(relevant.map((f) => [f.key, f]));
  const allKeys = new Set(fieldsOf(type).map((f) => f.key));

  const seen = new Set<string>();
  const out: AttributeValue[] = [];

  for (const attr of supplied) {
    const key = String(attr?.key ?? '').trim();
    if (!key) throw new AppError('Every attribute needs a key', 422);

    if (!allKeys.has(key)) {
      throw new AppError(
        `'${key}' is not a field on type '${type.name}'. Add it under Catalog Setup first.`,
        422
      );
    }

    const field = byKey.get(key);
    if (!field) {
      /* The key exists on the type but belongs to the other scope. Saying which
         side it belongs on is the difference between a fixable error and a
         confusing one. */
      const belongs = scope === 'item' ? 'the product' : 'each item';
      throw new AppError(`'${key}' is defined on ${belongs}, not here`, 422);
    }

    if (seen.has(key)) throw new AppError(`'${key}' is given more than once`, 422);
    seen.add(key);

    out.push({ key, value: coerce(field, attr.value) });
  }

  if (!partial) {
    for (const field of relevant) {
      if (field.required && !field.deprecated && !seen.has(field.key)) {
        throw new AppError(`'${field.label}' is required`, 422);
      }
    }
  }

  return out;
};

/**
 * Spellings already recorded, per open-choice field key.
 *
 * A fixed list is its own vocabulary. An open field has none, so this stands
 * in for one: `primeVocabulary` fills it from the values already stored before
 * a product is validated, and `coerce` snaps incoming values onto whatever
 * spelling got there first.
 *
 * Process-local and short-lived on purpose. It is a normaliser, not a source
 * of truth — the items themselves are that, and every write re-reads them.
 */
const vocabulary = new Map<string, string[]>();

/**
 * Loads the distinct values already used for the given field keys.
 *
 * Cheap: `catalogitems` carries a compound index on
 * `attributes.key + attributes.value`, so this is an index scan, not a
 * collection scan.
 */
export const primeVocabulary = async (
  keys: string[],
  distinctValues: (key: string) => Promise<string[]>
): Promise<void> => {
  for (const key of keys) {
    vocabulary.set(key, await distinctValues(key));
  }
};

/** The open-choice keys on a type — the only ones that need priming. */
export const openChoiceKeys = (type: ProductType): string[] =>
  fieldsOf(type)
    .filter((f) => f.type === 'choice' && !(f.options ?? []).length)
    .map((f) => f.key);

/** Values are stored as strings so one array can hold every field type. */
const coerce = (field: FieldDefinition, raw: unknown): string => {
  if (raw === null || raw === undefined || raw === '') {
    throw new AppError(`'${field.label}' cannot be empty`, 422);
  }
  const value = String(raw).trim();

  switch (field.type) {
    case 'number':
      if (!Number.isFinite(Number(value))) {
        throw new AppError(`'${field.label}' must be a number (got "${value}")`, 422);
      }
      return value;

    case 'boolean':
      if (!['true', 'false'].includes(value.toLowerCase())) {
        throw new AppError(`'${field.label}' must be true or false (got "${value}")`, 422);
      }
      return value.toLowerCase();

    case 'choice': {
      const options = field.options ?? [];

      /* OPEN choice — no declared list, so the product author supplies the
         value. Anything non-empty is accepted.

         The casing guarantee still has to hold, or "Blue" and "blue" become
         two values and two facets. With no list to match against, the
         vocabulary below stands in for one: it holds the spellings already
         recorded for this field, and the first one used wins. */
      if (!options.length) {
        const known = vocabulary.get(field.key) ?? [];
        return known.find((o) => o.toLowerCase() === value.toLowerCase()) ?? value;
      }

      /* FIXED list — matched case-insensitively but stored in the declared
         casing. This is the fix for v1, where "Blue", "blue" and "BLUE"
         became three facets. */
      const match = options.find((o) => o.toLowerCase() === value.toLowerCase());
      if (!match) {
        throw new AppError(
          `'${field.label}' must be one of: ${options.join(', ')} (got "${value}")`,
          422
        );
      }
      return match;
    }

    default:
      return value;
  }
};

/* -------------------------------------------------------- item identity */

/**
 * The stable identity of a combination, independent of attribute order.
 *
 * Two items are the same item when their variant-forming values match, however
 * the client happened to order the array.
 */
export const attributeSignature = (attributes: AttributeValue[]): string =>
  [...attributes]
    .map((a) => `${a.key}=${a.value}`)
    .sort()
    .join('|');

/** "Colour / Storage" and "Blue / 256GB" — display labels, derived never stored as truth. */
export const deriveLabels = (
  type: ProductType,
  attributes: AttributeValue[]
): { optionLabel: string; valueLabel: string } => {
  const labelFor = new Map(fieldsOf(type).map((f) => [f.key, f.label]));
  return {
    optionLabel: attributes.map((a) => labelFor.get(a.key) ?? a.key).join(' / '),
    valueLabel: attributes.map((a) => a.value).join(' / '),
  };
};

/** A URL- and SKU-safe suffix built from the values: "blue-256gb". */
export const attributeSlug = (attributes: AttributeValue[]): string =>
  attributes
    .map((a) => a.value)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/* ------------------------------------------------------- the matrix */

/**
 * Every combination of the chosen values, one per axis.
 *
 * Colour[Blue, Green] x Storage[128GB, 256GB] x Screen[Touch, Button] gives 8.
 * Generation is offered, not forced: a dealership rarely stocks every trim in
 * every colour, so the caller prunes the result before saving.
 */
export const buildMatrix = (
  type: ProductType,
  selection: Record<string, string[]>
): AttributeValue[][] => {
  const axes = variantFormingFields(type)
    .filter((f) => (selection[f.key] ?? []).length > 0)
    .map((f) => ({ field: f, values: selection[f.key] }));

  if (!axes.length) return [];

  let combos: AttributeValue[][] = [[]];
  for (const axis of axes) {
    const next: AttributeValue[][] = [];
    for (const combo of combos) {
      for (const raw of axis.values) {
        next.push([...combo, { key: axis.field.key, value: coerce(axis.field, raw) }]);
      }
    }
    combos = next;
  }

  return combos;
};
