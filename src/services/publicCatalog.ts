import { store } from '../data/store.js';
import type { Product, Category } from '../types/index.js';

/**
 * The catalogue as the outside world may see it.
 *
 * One place, shared by the public API and the MCP tools. Two copies of a
 * "strip the internal fields" rule is two places to forget one, and the cost of
 * forgetting is a margin published on a shop front.
 */

/* Figures that are nobody's business outside the office. */
const INTERNAL_FIELDS = [
  'margin',
  'committed',
  'reorderPoint',
  'originalPrice',
  'discount',
  'categoryCode',
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
] as const;

export const publicProduct = (p: Product | undefined): Record<string, any> | undefined => {
  if (!p) return undefined;
  const out: Record<string, any> = { ...(p as any) };
  for (const field of INTERNAL_FIELDS) delete out[field];

  /* Absence is stated rather than left as a hole. A missing price field reads
     as a bug to a website and as an invitation to guess to a language model;
     `null` plus a note is neither. */
  if (out.price === undefined || out.price === null) {
    out.price = null;
    out.priceNote = 'Not priced — do not quote a figure. Offer to take an enquiry.';
  }
  if (out.stock === undefined || out.stock === null) {
    out.stock = null;
    out.stockNote = 'Stock not recorded — do not claim it is in or out of stock.';
  }

  if (Array.isArray(out.variants)) {
    out.variants = out.variants.map((v: any) => ({
      option: v.option,
      value: v.value,
      price: v.price ?? null,
      stock: v.stock ?? null,
      status: v.status ?? 'Unspecified',
    }));
  }
  return out;
};

export const publicCategory = (c: Category | undefined): Record<string, any> | undefined => {
  if (!c) return undefined;
  const { _id, __v, ...rest } = c as any;
  return rest;
};

/** `Number('')` is 0, which would silently become a real bound. */
export const toBound = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

export interface CatalogQuery {
  search?: string;
  categoryId?: string;
  /** Several categories at once, for a storefront showing a whole department. */
  categoryIds?: string[];
  priceMin?: number;
  priceMax?: number;
  status?: string;
  sortBy?: string;
  sortOrder?: string;
  page?: number;
  limit?: number;
}

export interface CatalogPage {
  products: Record<string, any>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Hard ceiling: a public caller does not get to ask for the whole catalogue. */
const MAX_LIMIT = 50;

/**
 * One filtered, sorted, paged slice of the catalogue.
 *
 * Newest first unless asked otherwise — a storefront's default question is
 * "what is new", not "what is alphabetically first".
 */
export const queryCatalog = async (query: CatalogQuery): Promise<CatalogPage> => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || 12));

  const sortField = String(query.sortBy ?? '').trim();
  const direction = String(query.sortOrder ?? '').toLowerCase() === 'asc' ? 1 : -1;

  const all = await store.getProducts({
    categoryId: query.categoryId,
    status: query.status,
    search: query.search,
    priceMin: toBound(query.priceMin),
    priceMax: toBound(query.priceMax),
    /* Newest first by default. */
    sort: sortField
      ? ({ [sortField]: direction } as Record<string, 1 | -1>)
      : ({ createdAt: -1 } as Record<string, 1 | -1>),
  });

  /* Several categories is filtered here: the store takes one id, and widening
     it would change a signature four other callers rely on. */
  const wanted = (query.categoryIds ?? []).filter(Boolean);
  const scoped = wanted.length ? all.filter((p) => wanted.includes(p.categoryId)) : all;

  /* Sorting by price puts the unpriced first in ascending order, so "cheapest
     first" would answer with products carrying no price at all. They go last:
     a product nobody priced is not the cheapest, it is not in the running. */
  const ordered =
    sortField === 'price'
      ? [...scoped].sort((a, b) => {
          const left = typeof a.price === 'number' ? a.price : null;
          const right = typeof b.price === 'number' ? b.price : null;
          if (left === null && right === null) return 0;
          if (left === null) return 1;
          if (right === null) return -1;
          return direction === 1 ? left - right : right - left;
        })
      : scoped;

  const start = (page - 1) * limit;
  return {
    products: ordered.slice(start, start + limit).map(publicProduct) as Record<string, any>[],
    total: ordered.length,
    page,
    limit,
    totalPages: Math.ceil(ordered.length / limit) || 0,
  };
};

/** Categories, newest first, optionally filtered by name. */
export const queryCategories = async (options: { search?: string; limit?: number }) => {
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 100));
  const all = await store.getCategories();

  const term = String(options.search ?? '').trim().toLowerCase();
  const matched = term ? all.filter((c) => c.name?.toLowerCase().includes(term)) : all;

  return {
    categories: matched.slice(0, limit).map(publicCategory) as Record<string, any>[],
    total: matched.length,
  };
};
