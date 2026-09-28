import { escapeRegex } from '../../utils/response.util.js';
import { CatalogItemModel, CatalogProductModel } from '../models.js';
import type {
  AvailabilityState,
} from './availability.js';
import { resolveAvailabilityFor } from './availability.js';
import { descendantIds, loadAllCategories, resolveCommerce } from './categoryTree.js';
import { resolvePricesFor } from './pricing.js';
import type {
  CatalogCategory,
  CatalogItem,
  CatalogProduct,
  CommerceConfig,
} from '../types.js';

/**
 * Catalogue reads: filtering, faceting and enrichment.
 *
 * Shared by the admin list, the public storefront API and the MCP tools, so all
 * three agree on what "in stock", "from ₹X" and "filtered by colour" mean.
 */

export interface CatalogFilter {
  search?: string;
  categoryId?: string;
  categoryIds?: string[];
  typeId?: string;
  brand?: string;
  status?: string;
  /** Attribute filters: { Colour: ['Blue'], Storage: ['256GB'] }. */
  attributes?: Record<string, string[]>;
  priceMin?: number;
  priceMax?: number;
  inStockOnly?: boolean;
  priceListId?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  skip?: number;
  limit?: number;
  /** Opt in to soft-deleted rows — for the restore screen only. */
  includeDeleted?: boolean;
}

export interface EnrichedItem extends CatalogItem {
  price: { amount: number; currency: string; priceListId: string } | null;
  availability: AvailabilityState;
}

export interface EnrichedProduct extends CatalogProduct {
  commerce: CommerceConfig;
  items: EnrichedItem[];
  priceFrom: number | null;
  priceTo: number | null;
  currency: string;
  available: boolean;
  availabilityLabel: string;
}

/* ------------------------------------------------------------- filtering */

const buildProductFilter = async (
  f: CatalogFilter,
  allCategories: CatalogCategory[]
): Promise<Record<string, unknown>> => {
  const filter: Record<string, unknown> = {};

  if (f.typeId) filter.typeId = f.typeId;
  if (f.brand) filter.brand = new RegExp(`^${escapeRegex(f.brand)}$`, 'i');
  if (f.status) filter.status = f.status;

  const categoryIds = [...(f.categoryIds ?? []), ...(f.categoryId ? [f.categoryId] : [])];
  if (categoryIds.length) {
    /* Selecting "Electronics" has to include everything beneath it, or a parent
       category looks empty while its children hold every product. */
    const expanded = new Set<string>();
    for (const id of categoryIds) {
      for (const descendant of descendantIds(id, allCategories)) expanded.add(descendant);
    }
    filter.categoryIds = { $in: [...expanded] };
  }

  if (f.search?.trim()) {
    const rx = new RegExp(escapeRegex(f.search.trim()), 'i');
    /* Item SKUs and attribute values are searched separately below, because a
       product does not hold its items' text. */
    const itemMatches = await CatalogItemModel.find({
      $or: [{ sku: rx }, { 'attributes.value': rx }, { description: rx }],
    })
      .select('productId')
      .lean();

    const productIds = [...new Set(itemMatches.map((i: any) => i.productId))];

    filter.$or = [
      { name: rx },
      { sku: rx },
      { description: rx },
      { brand: rx },
      { 'attributes.value': rx },
      ...(productIds.length ? [{ id: { $in: productIds } }] : []),
    ];
  }

  return filter;
};

/**
 * Attribute filters, as one `$elemMatch` per axis.
 *
 * `{'attributes.key': 'Colour', 'attributes.value': 'Blue'}` is wrong: it
 * matches an item whose Colour is Green as long as some other attribute has the
 * value Blue. $elemMatch forces both to hold in the same array element.
 */
const attributeClauses = (attributes: Record<string, string[]> | undefined): Record<string, unknown>[] =>
  Object.entries(attributes ?? {})
    .filter(([, values]) => values?.length)
    .map(([key, values]) => ({
      attributes: { $elemMatch: { key, value: { $in: values } } },
    }));

/* --------------------------------------------------------------- listing */

export interface CatalogPage {
  products: EnrichedProduct[];
  total: number;
}

export const queryCatalog = async (f: CatalogFilter = {}): Promise<CatalogPage> => {
  const allCategories = await loadAllCategories();
  const productFilter = await buildProductFilter(f, allCategories);

  const itemAxes = attributeClauses(f.attributes);
  const needsItemFilter = itemAxes.length > 0 || f.priceMin !== undefined || f.priceMax !== undefined || f.inStockOnly;

  /* When a filter applies to items, the set of matching products is decided by
     the items first and only then paged, or the page counts come out wrong. */
  if (itemAxes.length) {
    const matching = await CatalogItemModel.find({ $and: itemAxes }).select('productId').lean();
    const ids = [...new Set(matching.map((i: any) => i.productId))];
    productFilter.id = ids.length ? { $in: ids } : { $in: ['__none__'] };
  }

  const sort: Record<string, 1 | -1> = (() => {
    const allowed = ['name', 'createdAt', 'updatedAt', 'sku', 'brand'];
    const field = f.sortBy && allowed.includes(f.sortBy) ? f.sortBy : 'createdAt';
    return { [field]: f.sortOrder === 'asc' ? 1 : -1 };
  })();

  /* Price and stock filters are applied after enrichment, so the total has to
     be recomputed from the filtered set rather than taken from countDocuments. */
  const applyPostFilter = f.priceMin !== undefined || f.priceMax !== undefined || Boolean(f.inStockOnly);

  const seeDeleted = Boolean(f.includeDeleted);
  const withDeleted = <T>(q: T): T => (seeDeleted ? (q as any).setOptions({ withDeleted: true }) : q);

  if (!applyPostFilter) {
    const [rows, total] = await Promise.all([
      withDeleted(
        CatalogProductModel.find(productFilter)
          .sort(sort)
          .skip(f.skip ?? 0)
          .limit(f.limit ?? 20)
      ).lean(),
      withDeleted(CatalogProductModel.countDocuments(productFilter)),
    ]);

    const products = await enrichProducts(rows as unknown as CatalogProduct[], allCategories, f);
    return { products, total };
  }

  const rows = (await withDeleted(
    CatalogProductModel.find(productFilter).sort(sort)
  ).lean()) as unknown as CatalogProduct[];
  const enriched = await enrichProducts(rows, allCategories, f);

  const filtered = enriched.filter((p) => {
    if (f.inStockOnly && !p.available) return false;
    if (f.priceMin !== undefined && (p.priceFrom === null || p.priceTo === null)) return false;
    if (f.priceMax !== undefined && (p.priceFrom === null || p.priceTo === null)) return false;
    if (f.priceMin !== undefined && (p.priceTo ?? 0) < f.priceMin) return false;
    if (f.priceMax !== undefined && (p.priceFrom ?? 0) > f.priceMax) return false;
    return true;
  });

  const skip = f.skip ?? 0;
  const limit = f.limit ?? 20;
  return { products: filtered.slice(skip, skip + limit), total: filtered.length };
};

/* ------------------------------------------------------------ enrichment */

/**
 * Attaches items, prices, availability and the inherited commerce config.
 *
 * Three queries total regardless of page size — items, prices, availability —
 * because the alternative is a query per product per concern, which is how a
 * 20-row page becomes 60 round trips.
 */
export const enrichProducts = async (
  products: CatalogProduct[],
  allCategories: CatalogCategory[],
  f: CatalogFilter = {}
): Promise<EnrichedProduct[]> => {
  if (!products.length) return [];

  const productIds = products.map((p) => p.id);
  const itemFilter: Record<string, unknown> = { productId: { $in: productIds } };
  const axes = attributeClauses(f.attributes);
  if (axes.length) itemFilter.$and = axes;

  const items = (await CatalogItemModel.find(itemFilter).lean()) as unknown as CatalogItem[];

  const commerceFor = new Map(
    products.map((p) => [p.id, resolveCommerce(p.categoryIds ?? [], allCategories)])
  );

  const prices = await resolvePricesFor(items.map((i) => i.id), { priceListId: f.priceListId });

  const availability = await resolveAvailabilityFor(
    items.map((i) => ({
      itemId: i.id,
      strategy:
        commerceFor.get(i.productId)?.availability.model ?? 'quantity',
    }))
  );

  const itemsByProduct = new Map<string, CatalogItem[]>();
  for (const item of items) {
    itemsByProduct.set(item.productId, [...(itemsByProduct.get(item.productId) ?? []), item]);
  }

  return products.map((product) => {
    const commerce = commerceFor.get(product.id) ?? resolveCommerce([], allCategories);
    const own = itemsByProduct.get(product.id) ?? [];

    const enrichedItems: EnrichedItem[] = own.map((item) => {
      const price = prices.get(item.id) ?? null;
      return {
        ...item,
        price: price
          ? { amount: price.amount, currency: price.currency, priceListId: price.priceListId }
          : null,
        availability:
          availability.get(item.id) ??
          { strategy: commerce.availability.model, available: true, label: 'Availability not tracked', detail: {} },
      };
    });

    const amounts = enrichedItems
      .map((i) => i.price?.amount)
      .filter((a): a is number => typeof a === 'number' && Number.isFinite(a));

    /* Guarded because `Math.min(...[])` is Infinity, which v1 wrote straight
       into four product rows before it was caught. */
    const priceFrom = amounts.length ? Math.min(...amounts) : null;
    const priceTo = amounts.length ? Math.max(...amounts) : null;

    const anyAvailable = enrichedItems.some((i) => i.availability.available);
    const label =
      commerce.pricing.model === 'on_request' && !enrichedItems.length
        ? 'Enquire'
        : enrichedItems.length
          ? (enrichedItems.find((i) => i.availability.available)?.availability.label ??
             enrichedItems[0].availability.label)
          : 'No items configured';

    return {
      ...product,
      commerce,
      items: enrichedItems,
      priceFrom,
      priceTo,
      currency: commerce.pricing.currency ?? 'INR',
      available: anyAvailable,
      availabilityLabel: label,
    };
  });
};

/* ------------------------------------------------------------- faceting */

export interface Facet {
  key: string;
  label: string;
  values: { value: string; count: number }[];
}

/**
 * The filter sidebar, built from the items that actually match.
 *
 * An aggregation rather than `distinct()`: distinct returns every value in the
 * collection with no counts and no respect for the current filter, which is
 * silently wrong the moment a facet is combined with anything else.
 */
export const buildFacets = async (
  f: CatalogFilter = {},
  labelFor: Map<string, string> = new Map()
): Promise<Facet[]> => {
  const allCategories = await loadAllCategories();
  const productFilter = await buildProductFilter(f, allCategories);

  const productIds = (await CatalogProductModel.find(productFilter).select('id').lean()).map(
    (p: any) => p.id
  );
  if (!productIds.length) return [];

  const match: Record<string, unknown> = { productId: { $in: productIds } };
  const axes = attributeClauses(f.attributes);
  if (axes.length) match.$and = axes;

  const rows = await CatalogItemModel.aggregate([
    { $match: match },
    { $unwind: '$attributes' },
    {
      $group: {
        _id: { key: '$attributes.key', value: '$attributes.value' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.key': 1, count: -1 } },
  ]);

  const byKey = new Map<string, { value: string; count: number }[]>();
  for (const row of rows) {
    const { key, value } = row._id;
    byKey.set(key, [...(byKey.get(key) ?? []), { value, count: row.count }]);
  }

  return [...byKey.entries()].map(([key, values]) => ({
    key,
    label: labelFor.get(key) ?? key,
    values,
  }));
};
