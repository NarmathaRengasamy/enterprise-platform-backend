import { AppError } from '../middlewares/errorHandler.js';
import { ProductV2Model } from '../models/ProductV2.model.js';
import { productTypeService } from './productType.service.js';
import { catalogCategoryService } from './catalogCategory.service.js';
import { resolvePrice } from './price.service.js';
import type { FieldDefinition } from '../types/productType.types.js';
import { BASE_UNIT, familyOf, parseMeasureText, toMeasure, UnitFamily } from '../utils/units.util.js';

/**
 * Product search (design §9.3, plan 3.2): one aggregation in the database —
 * filter, sort, page and count together, never paged in memory.
 *
 * An attribute filter such as Colour = Red matches a product whose own value
 * is Red **or** that has a Red item (§1.5 T7). Facet counts are products, and
 * each facet ignores its own filter so the other options stay visible.
 */

export const SORTS = ['relevance', 'price_asc', 'price_desc', 'name', 'newest', 'size_asc', 'size_desc'] as const;
export type Sort = (typeof SORTS)[number];
export const MAX_LIMIT = 100;

export interface SearchFilters {
  search?: string;
  category_id?: string;
  status?: 'draft' | 'active' | 'archived' | 'all' | 'deleted';
  brand?: string;
  price_min_minor?: number;
  price_max_minor?: number;
  attributes?: Record<string, (string | number | boolean)[]>;
  /** A measured-size attribute (R46); measure_min / measure_max are in its family's base unit. */
  measure_key?: string;
  measure_min?: number;
  measure_max?: number;
  include_deleted?: boolean;
  sort?: Sort;
  page?: number;
  limit?: number;
}

const invalid = (message: string, field: string) => new AppError(message, 422, undefined, { [field]: message });
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (d: any) => (d && typeof d.toJSON === 'function' ? d.toJSON() : d);

/** A category and every category under it (tree mode), by id. */
const withDescendants = async (id: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = (nodes: any[], inside: boolean) =>
    nodes.forEach((n) => {
      const hit = inside || n.id === id;
      if (hit) out.push(n.id);
      walk(n.children ?? [], hit);
    });
  walk(await catalogCategoryService.tree(false), false);
  return out.length ? out : [id];
};

/**
 * A measured size is stored on items as its base amount (a number), so a
 * filter value becomes a number too: 1000, "1000" or "1 l" → 1000 for a
 * volume attribute. Anything else is refused with a pointer to the range filter.
 */
const sizeValue = (f: FieldDefinition, v: string | number | boolean, key: string): number => {
  const family = f.unit_family as UnitFamily;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    if (/^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    const parsed = parseMeasureText(v);
    if (parsed && familyOf(parsed.unit) === family) return toMeasure(parsed.amount, parsed.unit, family, `attributes.${key}`, f.label.en).base_amount;
  }
  throw invalid(
    `${f.label.en}: filter by a size in ${BASE_UNIT[family]} (e.g. 500) or with its unit (e.g. "1 l") — for a range use measure_key with measure_min / measure_max`,
    `attributes.${key}`
  );
};

const valuesFor = (f: FieldDefinition, raw: (string | number | boolean)[], key: string) =>
  raw.map((v) => {
    if (f.type === 'number' && f.unit_family) return sizeValue(f, v, key);
    if (f.type === 'boolean') {
      if (v === true || v === 'true') return true;
      if (v === false || v === 'false') return false;
      throw invalid(`${f.label.en}: filter by true or false`, `attributes.${key}`);
    }
    return String(v);
  });

/* Values of one key on the product itself, and across its items. */
const productValues = (key: string) => ({
  $map: {
    input: { $filter: { input: { $ifNull: ['$attributes', []] }, as: 'a', cond: { $eq: ['$$a.key', key] } } },
    as: 'a',
    in: '$$a.value',
  },
});
const itemValues = (key: string) => ({
  $reduce: {
    input: { $ifNull: ['$_filter_items', []] },
    initialValue: [],
    in: {
      $concatArrays: [
        '$$value',
        { $map: { input: { $filter: { input: '$$this.attributes', as: 'a', cond: { $eq: ['$$a.key', key] } } }, as: 'a', in: '$$a.value' } },
      ],
    },
  },
});

const attrClause = (key: string, values: unknown[]) => ({
  $or: [
    { attributes: { $elemMatch: { key, value: { $in: values } } } },
    { '_filter_items.attributes': { $elemMatch: { key, value: { $in: values } } } },
  ],
});

const SORT_STAGES: Record<Sort, any[]> = {
  /* The score is copied into a field before $facet, where $meta is not available. */
  relevance: [{ $sort: { score: -1, created_at: -1 } }],
  price_asc: [{ $addFields: { _unpriced: { $cond: [{ $eq: [{ $ifNull: ['$min_price_minor', null] }, null] }, 1, 0] } } }, { $sort: { _unpriced: 1, min_price_minor: 1, created_at: -1 } }],
  price_desc: [{ $addFields: { _unpriced: { $cond: [{ $eq: [{ $ifNull: ['$min_price_minor', null] }, null] }, 1, 0] } } }, { $sort: { _unpriced: 1, min_price_minor: -1, created_at: -1 } }],
  name: [{ $addFields: { _name: { $toLower: '$name.en' } } }, { $sort: { _name: 1, created_at: -1 } }],
  newest: [{ $sort: { created_at: -1, _id: -1 } }],
  /* By the smallest matching size; products without a size go last. */
  size_asc: [{ $addFields: { _nosize: { $cond: [{ $eq: [{ $ifNull: ['$_size', null] }, null] }, 1, 0] } } }, { $sort: { _nosize: 1, _size: 1, created_at: -1 } }],
  size_desc: [{ $addFields: { _nosize: { $cond: [{ $eq: [{ $ifNull: ['$_size', null] }, null] }, 1, 0] } } }, { $sort: { _nosize: 1, _size: -1, created_at: -1 } }],
};

/**
 * `_size`: the smallest base amount among the product's items that have a
 * size — of the given attribute, and inside the range when one is given.
 */
const sizeStage = (key: string | undefined, min: number | undefined, max: number | undefined) => {
  const base = '$$i.measure.base_amount';
  const conds: any[] = [{ $ne: [{ $ifNull: [base, null] }, null] }];
  if (min !== undefined) conds.push({ $gte: [base, min] });
  if (max !== undefined) conds.push({ $lte: [base, max] });
  if (key) conds.push({ $in: [key, { $map: { input: { $ifNull: ['$$i.attributes', []] }, as: 'a', in: '$$a.key' } }] });
  return {
    $addFields: {
      _size: { $min: { $map: { input: { $filter: { input: { $ifNull: ['$_filter_items', []] }, as: 'i', cond: { $and: conds } } }, as: 'i', in: base } } },
    },
  };
};

/** The list-card shape: product fields plus price and availability summaries. */
const toSummary = (doc: any) => {
  const { _id, _filter_items, _page_items, _stock, _unpriced, _name, _size, _nosize, score, ...p } = doc;
  const items: any[] = _page_items ?? [];
  const active = items.filter((i) => i.status === 'active');
  const priced = active
    .map((i) => resolvePrice(i))
    .filter(Boolean)
    .sort((a: any, b: any) => a.amount_minor - b.amount_minor);
  const trackedIds = new Set(active.filter((i) => (i.track_inventory ?? p.track_inventory) === true).map((i) => i.id));
  const rows = (_stock ?? []).filter((s: any) => trackedIds.has(s.item_id));
  const available = rows.reduce((n: number, s: any) => n + (s.on_hand ?? 0) - (s.reserved ?? 0), 0);
  return {
    ...p,
    item_count: items.length,
    active_item_count: active.length,
    from_price: priced[0] ?? null,
    availability: trackedIds.size ? { status: 'tracked', available } : { status: 'not_tracked' },
  };
};

export const productSearchService = {
  /** `viewer` (or the public catalogue) only ever sees active products. */
  async search(filters: SearchFilters, opts: { viewer: boolean }) {
    const type = plain(await productTypeService.getActive());
    const fields = new Map<string, FieldDefinition>(((type?.fields ?? []) as FieldDefinition[]).map((f) => [f.key, f]));
    const facetFields = [...fields.values()].filter((f) => f.filterable && !f.deprecated && (f.type === 'enum' || f.type === 'boolean'));

    const page = Math.max(1, Math.floor(filters.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(filters.limit ?? 20)));
    const search = filters.search?.trim();
    const sort: Sort = filters.sort ?? (search ? 'relevance' : 'newest');
    if (sort === 'relevance' && !search) throw invalid('Sort by relevance needs a search term', 'sort');

    /* The first stage: $text must lead, and it names is_deleted so the base
       plugin leaves it as written. */
    const deletedOnly = !opts.viewer && filters.status === 'deleted';
    const first: Record<string, unknown> = {
      is_deleted: deletedOnly ? true : !opts.viewer && filters.include_deleted ? { $in: [true, false] } : false,
    };
    if (search) first.$text = { $search: search };
    if (opts.viewer) first.status = 'active';
    else if (filters.status && filters.status !== 'all' && filters.status !== 'deleted') first.status = filters.status;
    if (filters.brand?.trim()) first.brand = { $regex: `^${escapeRegex(filters.brand.trim())}$`, $options: 'i' };
    if (filters.category_id) first.category_ids = { $in: await withDescendants(filters.category_id) };
    if (filters.price_min_minor !== undefined || filters.price_max_minor !== undefined) {
      first.min_price_minor = {
        ...(filters.price_min_minor !== undefined ? { $gte: filters.price_min_minor } : {}),
        ...(filters.price_max_minor !== undefined ? { $lte: filters.price_max_minor } : {}),
      };
    }

    const attrFilters = Object.entries(filters.attributes ?? {})
      .filter(([, v]) => v?.length)
      .map(([key, raw]) => {
        const f = fields.get(key);
        if (!f) throw invalid(`Unknown attribute "${key}"`, `attributes.${key}`);
        return { key, values: valuesFor(f, raw, key) };
      });
    /* Size range (R46): needs the measured-size attribute, so the unit family is known. */
    const ranged = filters.measure_min !== undefined || filters.measure_max !== undefined;
    if (filters.measure_key) {
      const f = fields.get(filters.measure_key);
      if (!f) throw invalid(`Unknown attribute "${filters.measure_key}"`, 'measure_key');
      if (f.type !== 'number' || !f.unit_family) throw invalid(`${f.label.en} is not a measured size (a number with a unit family)`, 'measure_key');
    } else if (ranged) {
      throw invalid('Say which size attribute the range is for (measure_key)', 'measure_key');
    }
    if (ranged && filters.measure_min !== undefined && filters.measure_max !== undefined && filters.measure_min > filters.measure_max) {
      throw invalid('The smallest size cannot be above the largest', 'measure_min');
    }
    const sized = ranged || sort === 'size_asc' || sort === 'size_desc';

    const matchExcept = (skip?: string) => {
      const clauses = attrFilters.filter((a) => a.key !== skip).map((a) => attrClause(a.key, a.values));
      return { $match: clauses.length ? { $and: clauses } : {} };
    };

    const facets: Record<string, any[]> = {};
    for (const f of facetFields) {
      facets[`f_${f.key}`] = [
        matchExcept(f.key),
        { $project: { v: { $setUnion: [productValues(f.key), itemValues(f.key)] } } },
        { $unwind: '$v' },
        { $group: { _id: '$v', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ];
    }

    const pipeline: any[] = [
      { $match: first },
      {
        $lookup: {
          from: 'product_items',
          let: { pid: '$id' },
          pipeline: [{ $match: { $expr: { $eq: ['$product_id', '$$pid'] }, is_deleted: false } }, { $project: { _id: 0, attributes: 1, measure: 1 } }],
          as: '_filter_items',
        },
      },
      ...(sized ? [sizeStage(filters.measure_key, filters.measure_min, filters.measure_max)] : []),
      ...(ranged ? [{ $match: { _size: { $ne: null } } }] : []),
      ...(sort === 'relevance' ? [{ $addFields: { score: { $meta: 'textScore' } } }] : []),
      {
        $facet: {
          results: [
            matchExcept(),
            ...SORT_STAGES[sort],
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $lookup: {
                from: 'product_items',
                let: { pid: '$id' },
                pipeline: [
                  { $match: { $expr: { $eq: ['$product_id', '$$pid'] }, is_deleted: false } },
                  { $project: { _id: 0, id: 1, sku: 1, price: 1, track_inventory: 1, status: 1 } },
                ],
                as: '_page_items',
              },
            },
            {
              $lookup: {
                from: 'item_stock',
                let: { ids: '$_page_items.id' },
                pipeline: [
                  { $match: { $expr: { $in: ['$item_id', '$$ids'] }, is_deleted: false } },
                  { $project: { _id: 0, item_id: 1, on_hand: 1, reserved: 1 } },
                ],
                as: '_stock',
              },
            },
          ],
          total: [matchExcept(), { $count: 'n' }],
          ...facets,
        },
      },
    ];

    const [out] = await ProductV2Model.aggregate(pipeline);
    const total = out.total[0]?.n ?? 0;
    return {
      items: out.results.map(toSummary),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      sort,
      facets: Object.fromEntries(
        facetFields.map((f) => [f.key, (out[`f_${f.key}`] ?? []).map((b: any) => ({ value: b._id, count: b.count }))])
      ),
    };
  },
};
