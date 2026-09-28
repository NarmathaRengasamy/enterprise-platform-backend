import { CatalogItemModel, CatalogProductModel } from '../models.js';
import { buildFacets, enrichProducts, queryCatalog } from './catalogQuery.js';
import { buildTree, loadAllCategories, resolveCommerce } from './categoryTree.js';
import { collectCharges, computeCharges, resolvePrice } from './pricing.js';
import { fieldsOf, loadType } from './typeRegistry.js';
import type { Facet } from './catalogQuery.js';
import type { CatalogCategory, CatalogProduct, FieldDefinition } from '../types.js';

/**
 * PUBLIC CATALOGUE V2 — what a customer-facing site is allowed to see.
 *
 * The admin API and this one read the same collections, so the only thing
 * keeping internal data off a public website is this file. Two rules:
 *
 *  1. **Allow-list, never deny-list.** Every shape below is built field by
 *     field. A new internal field added to a model is invisible here by
 *     default, which is the opposite of stripping known-bad keys and hoping
 *     nobody adds another one.
 *  2. **Only what is published.** Draft and archived products never leave,
 *     and soft-deleted rows are already excluded by the model hooks.
 */

/* ------------------------------------------------------------- shapes */

/** One asset as a storefront needs it — no filename, no byte count. */
export interface PublicMedia {
  id: string;
  kind: 'image' | 'video';
  url: string;
  source: 'upload' | 'link';
  alt?: string;
}

export interface PublicItem {
  id: string;
  sku: string;
  /** "Colour / Storage" and "Black / 64GB". */
  optionLabel?: string;
  valueLabel?: string;
  attributes: { key: string; label: string; value: string }[];
  description?: string;
  image?: string;
  media: PublicMedia[];
  price: { amount: number; currency: string } | null;
  available: boolean;
  availabilityLabel: string;
}

export interface PublicProduct {
  id: string;
  sku: string;
  name: string;
  description?: string;
  brand?: string;
  image?: string;
  media: PublicMedia[];
  categoryIds: string[];
  attributes: { key: string; label: string; value: string }[];
  /** How this product is sold — the storefront renders from these. */
  pricing: { model: string; label?: string; unit?: string; currency: string };
  priceFrom: number | null;
  priceTo: number | null;
  available: boolean;
  availabilityLabel: string;
  items: PublicItem[];
  createdAt?: string;
}

export interface PublicCategory {
  id: string;
  name: string;
  description?: string;
  parentId?: string | null;
  icon?: string;
  color?: string;
  productsCount: number;
  pricing: { model: string; label?: string; unit?: string; currency: string };
  children?: PublicCategory[];
}

/* -------------------------------------------------------- sanitisers */

const labelMap = (fields: FieldDefinition[]): Map<string, string> =>
  new Map(fields.map((f) => [f.key, f.label]));

/**
 * Media, in display order, stripped to what a page needs.
 *
 * `filename`, `sizeBytes` and `contentType` describe how the file is stored,
 * which is nobody's business but ours.
 */
const publicMedia = (media: any[] | undefined): PublicMedia[] =>
  [...(media ?? [])]
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      url: m.url,
      source: m.source,
      ...(m.alt ? { alt: m.alt } : {}),
    }));

const publicAttributes = (
  attributes: { key: string; value: string }[] | undefined,
  labels: Map<string, string>
) =>
  (attributes ?? []).map((a) => ({
    key: a.key,
    label: labels.get(a.key) ?? a.key,
    value: a.value,
  }));

/**
 * One product, reduced to what a shopper needs.
 *
 * `typeId`, `status`, `is_deleted`, `deletedAt` and `updatedAt` are all absent
 * by construction — they say something about how the catalogue is run, not
 * about what is for sale.
 */
export const toPublicProduct = (
  product: CatalogProduct & Record<string, any>,
  fields: FieldDefinition[]
): PublicProduct => {
  const labels = labelMap(fields);
  const commerce = product.commerce;

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description || undefined,
    brand: product.brand || undefined,
    image: product.image || undefined,
    media: publicMedia(product.media),
    categoryIds: product.categoryIds ?? [],
    attributes: publicAttributes(product.attributes, labels),
    pricing: {
      model: commerce?.pricing.model ?? 'fixed',
      label: commerce?.pricing.label,
      unit: commerce?.pricing.unit,
      currency: commerce?.pricing.currency ?? 'INR',
    },
    priceFrom: product.priceFrom ?? null,
    priceTo: product.priceTo ?? null,
    available: Boolean(product.available),
    availabilityLabel: product.availabilityLabel ?? '',
    items: (product.items ?? []).map(
      (i: any): PublicItem => ({
        id: i.id,
        sku: i.sku,
        optionLabel: i.optionLabel || undefined,
        valueLabel: i.valueLabel || undefined,
        attributes: publicAttributes(i.attributes, labels),
        description: i.description || undefined,
        image: i.image || undefined,
        media: publicMedia(i.media),
        price: i.price ? { amount: i.price.amount, currency: i.price.currency } : null,
        available: Boolean(i.availability?.available),
        availabilityLabel: i.availability?.label ?? '',
      })
    ),
    createdAt: product.createdAt,
  };
};

export const toPublicCategory = (
  category: CatalogCategory & Record<string, any>,
  all: CatalogCategory[],
  counts: Map<string, number>
): PublicCategory => {
  const commerce = category.effectiveCommerce ?? resolveCommerce([category.id], all);
  return {
    id: category.id,
    name: category.name,
    description: category.description || undefined,
    parentId: category.parentId ?? null,
    icon: category.icon,
    color: category.color,
    productsCount: counts.get(category.id) ?? 0,
    pricing: {
      model: commerce.pricing.model,
      label: commerce.pricing.label,
      unit: commerce.pricing.unit,
      currency: commerce.pricing.currency ?? 'INR',
    },
  };
};

/* ----------------------------------------------------------- queries */

export interface PublicQuery {
  search?: string;
  categoryId?: string;
  categoryIds?: string[];
  brand?: string;
  attributes?: Record<string, string[]>;
  priceMin?: number;
  priceMax?: number;
  inStockOnly?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
  facets?: boolean;
}

/** Field definitions for the types involved, so attributes carry real labels. */
const fieldsForProducts = async (products: CatalogProduct[]): Promise<FieldDefinition[]> => {
  const typeIds = [...new Set(products.map((p) => p.typeId).filter(Boolean))];
  const all: FieldDefinition[] = [];
  for (const id of typeIds) {
    const type = await loadType(id).catch(() => null);
    if (type) all.push(...fieldsOf(type));
  }
  return all;
};

export const publicProducts = async (
  q: PublicQuery
): Promise<{ products: PublicProduct[]; total: number; page: number; limit: number; totalPages: number; facets?: Facet[] }> => {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(50, Math.max(1, q.limit ?? 20));

  const { products, total } = await queryCatalog({
    ...q,
    /* The single most important line in this file: a storefront sees only what
       has been published. Draft and archived never leave. */
    status: 'active',
    skip: (page - 1) * limit,
    limit,
  });

  const fields = await fieldsForProducts(products);
  const shaped = products.map((p) => toPublicProduct(p as any, fields));

  const out: any = {
    products: shaped,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };

  if (q.facets) {
    const labels = new Map(fields.map((f) => [f.key, f.label]));
    /* Only fields the tenant marked filterable are offered publicly — an
       internal-only attribute should not become a storefront facet. */
    const filterable = new Set(fields.filter((f) => f.filterable).map((f) => f.key));
    const all = await buildFacets({ ...q, status: 'active' }, labels);
    out.facets = all.filter((f) => filterable.has(f.key));
  }

  return out;
};

export const publicProduct = async (id: string): Promise<PublicProduct | null> => {
  const row = await CatalogProductModel.findOne({ id, status: 'active' }).lean();
  if (!row) return null;

  const all = await loadAllCategories();
  const [enriched] = await enrichProducts([row as any], all);
  const fields = await fieldsForProducts([row as any]);
  return toPublicProduct(enriched as any, fields);
};

/** The category tree, with a live product count per node. */
export const publicCategories = async (
  nested: boolean
): Promise<PublicCategory[]> => {
  const all = await loadAllCategories();

  const rows = await CatalogProductModel.aggregate([
    { $match: { status: 'active', is_deleted: { $ne: true } } },
    { $unwind: '$categoryIds' },
    { $group: { _id: '$categoryIds', count: { $sum: 1 } } },
  ]);
  const counts = new Map<string, number>(rows.map((r: any) => [r._id, r.count]));

  const shaped = all.map((c) => toPublicCategory(c as any, all, counts));

  if (!nested) return shaped;

  const byId = new Map(shaped.map((c) => [c.id, { ...c, children: [] as PublicCategory[] }]));
  const roots: PublicCategory[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent.id !== node.id) parent.children!.push(node);
    else roots.push(node);
  }
  return roots;
};

/**
 * The money for one item: base, required charges, optional add-ons.
 *
 * Exposed publicly because it is exactly what a product page must show — and
 * because a base of `null` plus a required fee is a legitimate answer that a
 * storefront has to be able to render.
 */
export const publicItemCharges = async (itemId: string) => {
  const item = await CatalogItemModel.findOne({ id: itemId, status: 'active' }).lean();
  if (!item) return null;

  const product = await CatalogProductModel.findOne({
    id: (item as any).productId,
    status: 'active',
  }).lean();
  if (!product) return null;

  const all = await loadAllCategories();
  const commerce = resolveCommerce((product as any).categoryIds ?? [], all);

  const price = await resolvePrice((item as any).id);
  const charges = await collectCharges(
    {
      itemId: (item as any).id,
      productId: (product as any).id,
      categoryIds: (product as any).categoryIds ?? [],
    },
    all
  );

  const breakdown = computeCharges(charges, price?.amount ?? null, {
    currency: price?.currency ?? commerce.pricing.currency ?? 'INR',
  });

  /* `source` says which category a fee was inherited from — useful in the
     admin, meaningless and faintly leaky on a storefront. */
  const strip = (c: any) => ({
    id: c.id,
    label: c.label,
    amount: c.amount,
    basis: c.basis,
    maxQuantity: c.maxQuantity,
    currency: c.currency,
    note: c.note,
  });

  return {
    itemId: (item as any).id,
    sku: (item as any).sku,
    priceLabel: commerce.pricing.label ?? null,
    base: breakdown.base,
    currency: breakdown.currency,
    required: breakdown.required.map(strip),
    optional: breakdown.optional.map(strip),
    totalRequired: breakdown.totalRequired,
    note: breakdown.note,
  };
};

export { buildTree };
