import { ProductV2Model } from '../models/ProductV2.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { productTypeService } from './productType.service.js';
import { catalogCategoryService } from './catalogCategory.service.js';
import { productSearchService, SearchFilters, Sort } from './productSearch.service.js';
import { productV2Service } from './productV2.service.js';
import { availabilityFor, Availability } from './availability.service.js';
import { pricePerUnit, resolvePrice, ResolvedPrice } from './price.service.js';
import { limitsService } from './limits.service.js';
import { bundleService } from './bundle.service.js';
import { measureLabel } from '../utils/units.util.js';
import { AppError } from '../middlewares/errorHandler.js';

/**
 * The product catalogue as the AI agent (MCP) and the public storefront see it
 * (design §9.5, G2): one place, so the website and the agent never disagree.
 *
 *  - Active products and active items only. Drafts, archived, deleted, hidden
 *    categories and internal figures (reorder point, on hand, stock history,
 *    who changed what, per-customer limit settings) never leave.
 *  - Every number comes with ready-made text ("₹499 incl. GST", "Only 3 left"),
 *    so the agent never does arithmetic.
 *  - Exact stock only when it is low; otherwise "In stock" / "Out of stock".
 *  - Names in the asked language (en / ta / hi), falling back to English.
 */

export const LANGUAGES = ['en', 'ta', 'hi'] as const;
export type Lang = (typeof LANGUAGES)[number];

/** With no reorder point set, this many or fewer counts as low. */
const LOW_STOCK_FALLBACK = 5;
const MATCHING_ITEMS_ON_CARD = 3;
export const MAX_DETAIL_IDS = 20;
export const MAX_AVAILABILITY_IDS = 50;

const plain = (d: any) => (d && typeof d.toJSON === 'function' ? d.toJSON() : d);
export const tr = (t: any, lang: Lang): string => (t ? t[lang] || t.en || '' : '');

/* ---------------------------------------------------------------- text */

/** Paise → "₹1,49,999.50"; whole rupees without ".00". */
export const moneyText = (minor: number, currency = 'INR'): string => {
  const whole = minor % 100 === 0;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(whole ? 0 : 2)}`;
  }
};

const PER_UNIT: Record<string, string> = { hour: ' / hour', day: ' / day', month: ' / month' };

/** "₹499 incl. GST" · "₹499 + 18% GST" · "₹499" (no tax set) · "₹1,200 / day". */
const priceText = (price: ResolvedPrice, gstRate: number | null, hasTax: boolean) => {
  let text = moneyText(price.amount_minor, price.currency) + (PER_UNIT[price.price_unit] ?? '');
  if (hasTax) text += price.tax_inclusive ? ' incl. GST' : gstRate !== null ? ` + ${gstRate}% GST` : ' + GST';
  return text;
};

export interface AvailabilityView {
  status: 'available' | 'in_stock' | 'low_stock' | 'out_of_stock';
  text: string;
  /** Only when low — the exact count is never given otherwise. */
  quantity?: number;
}

export const availabilityView = (a: Availability | null | undefined): AvailabilityView => {
  if (!a || a.status === 'not_tracked') return { status: 'available', text: 'Available' };
  const n = a.available;
  if (n <= 0) return { status: 'out_of_stock', text: 'Out of stock' };
  const low = a.low_stock || (!a.reorder_point && n <= LOW_STOCK_FALLBACK);
  return low ? { status: 'low_stock', text: `Only ${n} left`, quantity: n } : { status: 'in_stock', text: 'In stock' };
};

const NOT_PRICED_NOTE = 'Not priced — do not quote a figure. Offer to take an enquiry.';

/** An absolute media URL when PUBLIC_ASSET_BASE_URL is set (uploads are stored as "/uploads/…"). */
export const assetUrl = (url: string | undefined | null) => {
  if (!url) return null;
  const base = process.env.PUBLIC_ASSET_BASE_URL?.trim().replace(/\/+$/, '');
  return base && url.startsWith('/') ? `${base}${url}` : url;
};

const hasTaxOf = (p: any, items: any[]) =>
  Boolean(p.hsn_code || p.sac_code || (p.gst_rate ?? null) !== null || items.some((i) => (i.gst_rate ?? null) !== null || i.hsn_code));

/* ------------------------------------------------------------- context */

export interface Ctx {
  lang: Lang;
  fields: Map<string, any>;
  /** Live, visible categories: id → path ("Vehicles › SUV"). */
  paths: Map<string, string>;
  /** Visible category id → its own name in every language (for matching the customer's words). */
  names: Map<string, string[]>;
  /** Visible category id → its visible sub-category ids. */
  children: Map<string, string[]>;
}

export const context = async (lang: Lang): Promise<Ctx> => {
  const type = plain(await productTypeService.getActive());
  const fields = new Map<string, any>(((type?.fields ?? []) as any[]).map((f) => [f.key, f]));
  const paths = new Map<string, string>();
  const names = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const walk = (nodes: any[], trail: string[], parent: string | null) =>
    nodes.forEach((n) => {
      if (n.status === 'hidden' || n.is_deleted) return; // a hidden category hides its sub-categories too
      const path = [...trail, tr(n.name, lang) || n.code];
      paths.set(n.id, path.join(' › '));
      names.set(n.id, [n.name?.en, n.name?.ta, n.name?.hi, n.code].filter(Boolean));
      if (parent) children.set(parent, [...(children.get(parent) ?? []), n.id]);
      walk(n.children ?? [], path, n.id);
    });
  walk(await catalogCategoryService.tree(false), [], null);
  return { lang, fields, paths, names, children };
};

/** A category and its visible sub-categories. */
const scopeOf = (ctx: Ctx, id: string): string[] => [id, ...(ctx.children.get(id) ?? []).flatMap((c) => scopeOf(ctx, c))];

export const valueText = (ctx: Ctx, key: string, value: unknown, item?: any): string => {
  if (item?.measure && typeof value === 'number') return measureLabel(item.measure);
  const f = ctx.fields.get(key);
  if (f?.type === 'boolean') return value ? 'Yes' : 'No';
  const option = f?.options?.find((o: any) => o.value === value);
  if (option) return tr(option.label, ctx.lang) || String(value);
  if (value && typeof value === 'object') return tr(value, ctx.lang) || '';
  return f?.unit && typeof value === 'number' ? `${value} ${f.unit}` : String(value ?? '');
};

/** "Petrol · Red" · "500 ml" · "Pack of 4"; "Standard" for a product without options. */
const itemLabel = (ctx: Ctx, item: any): string => {
  const parts = (item.attributes ?? []).map((a: any) => valueText(ctx, a.key, a.value, item)).filter(Boolean);
  if (item.pack_of) parts.push(`Pack of ${item.pack_of.quantity}`);
  return parts.join(' · ') || 'Standard';
};

const minMaxSummary = (product: any, item: any) => {
  const l = limitsService.effective(product.purchase_limits, item.purchase_limits);
  /* Per-customer windows are not offered on the form, so they are not shown either. */
  return limitsService.summary({ ...l, per_customer: { day: null, week: null, month: null, year: null, lifetime: null } }) || null;
};

/* ------------------------------------------------- understanding words */

/*
 * The agent (and a storefront search box) speaks the customer's words —
 * "6 inch", "144 mm", "brown", "petrol", "plain tape" — while filters need
 * exact keys and option values ("tape_size": "6inch_144mm"). Translating is
 * done HERE, in code, so a model never has to guess: words in the search text
 * become a category and filters, filter values may be labels or loose text,
 * and an unknown filter key is ignored with a hint instead of failing.
 */

/* Words that carry no product meaning. */
const STOP = new Set(
  'i im want wanted need needs show me give the a an with in of for do does you have has any please some and or to is are what which whats available buy looking look get details detail about your we our my can could price prices cost tell all list options option see find there under below above over within upto between less more than lakh lakhs crore rs rupees inr budget cheap cheapest cheaper best good new latest top'.split(
    ' '
  )
);
/* Words too generic to pick an option on their own ("inch" would match every size). */
const GENERIC = new Set('inch inches mm cm m l lit litre liter ml g kg tape tapes color colors colour colours standard special base wheel wheels size sizes type types'.split(' '));

const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[″”"]/g, ' inch ')
    .replace(/\binches\b/g, 'inch')
    .replace(/[_()\-/,:;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const compact = (s: unknown) => norm(s).replace(/[^\p{L}\p{N}.]/gu, '');
const numbersIn = (s: unknown) => (String(s ?? '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const labelsOf = (o: any): string[] => [o.label?.en, o.label?.ta, o.label?.hi].filter(Boolean);
const liveOptions = (f: any): any[] => (f.options ?? []).filter((o: any) => !o.deprecated);

/** Option values of a choice attribute matching one piece of input (value, label, "6 inch", "144 mm", "petrol"). */
const matchOptions = (f: any, input: unknown): string[] => {
  const opts = liveOptions(f);
  const raw = String(input ?? '').trim();
  if (!raw) return [];
  const exact = opts.filter((o) => o.value === raw);
  if (exact.length) return exact.map((o) => o.value);
  const c = compact(raw);
  const same = opts.filter((o) => compact(o.value) === c || labelsOf(o).some((l) => compact(l) === c));
  if (same.length) return same.map((o) => o.value);
  const nums = numbersIn(raw);
  if (nums.length) {
    /* "6", "6 inch", "144mm" → the option whose LABEL has those numbers ("6inch(144mm)"). */
    return opts.filter((o) => labelsOf(o).some((l) => nums.every((n) => numbersIn(l).includes(n)))).map((o) => o.value);
  }
  if (c.length < 3) return [];
  /* "petrol" → "1.5 l Petrol" and "1 lit Petrol"; "white" → "Milky White". */
  return opts
    .filter((o) => [o.value, ...labelsOf(o)].some((l) => compact(l).includes(c) || (compact(l).length >= 3 && c.includes(compact(l)))))
    .map((o) => o.value);
};

export const fieldName = (ctx: Ctx, f: any) => tr(f.label, ctx.lang) || f.key;
const optionLabel = (ctx: Ctx, f: any, value: unknown) => {
  const o = (f.options ?? []).find((x: any) => x.value === value);
  return o ? tr(o.label, ctx.lang) || String(value) : String(value);
};

/** Attribute keys used by products on sale (optionally inside some categories). */
const usedKeys = async (scope?: string[]): Promise<Set<string>> => {
  const rows = await ProductV2Model.aggregate<{ _id: string }>([
    { $match: { is_deleted: false, status: 'active', ...(scope ? { category_ids: { $in: scope } } : {}) } },
    { $project: { k: { $setUnion: [{ $ifNull: ['$attributes.key', []] }, { $ifNull: ['$variant_axes.key', []] }] } } },
    { $unwind: '$k' },
    { $group: { _id: '$k' } },
  ]);
  return new Set(rows.map((r) => r._id));
};

interface Understood {
  category_id?: string;
  filters: Record<string, (string | number | boolean)[]>;
  text: string;
  notes: string[];
}

/** Resolves the agent's `filters`: keys by key or label, values by value, label or loose text. */
const resolveFilters = (ctx: Ctx, input: Record<string, unknown> | undefined, used: Set<string>, notes: string[]) => {
  const out: Record<string, (string | number | boolean)[]> = {};
  const usable = [...ctx.fields.values()].filter((f) => !f.deprecated && used.has(f.key));
  const validKeys = () => usable.map((f) => f.key).join(', ');
  for (const [rawKey, rawValues] of Object.entries(input ?? {})) {
    const values = (Array.isArray(rawValues) ? rawValues : [rawValues]).filter((v) => v !== null && v !== undefined && v !== '') as (string | number | boolean)[];
    if (!values.length) continue;
    const kc = compact(rawKey);
    let field = ctx.fields.get(rawKey) ?? usable.find((f) => compact(f.key) === kc || labelsOf(f).some((l) => compact(l) === kc));
    const resolve = (f: any) => {
      if (f.type === 'enum') return [...new Set(values.flatMap((v) => matchOptions(f, v)))];
      if (f.type === 'boolean') return values.map((v) => v === true || /^(true|yes|y|1)$/i.test(String(v)));
      return values; // sizes ("1 l") and text are checked by the search itself
    };
    let resolved = field && !field.deprecated ? resolve(field) : [];
    /* Wrong or unknown key ("width", "size" for a tape): use the one attribute these values belong to. */
    if (!resolved.length) {
      const owners = usable.filter((f) => f.type === 'enum' && values.some((v) => matchOptions(f, v).length));
      if (owners.length === 1) {
        if (field?.key !== owners[0].key) notes.push(`"${rawKey}" read as ${fieldName(ctx, owners[0])}`);
        field = owners[0];
        resolved = resolve(field);
      }
    }
    if (!field || !resolved.length) {
      notes.push(`Ignored filter ${rawKey}=${values.join('/')}: no such option. Valid filter keys: ${validKeys()} (call get_filters for their options).`);
      continue;
    }
    out[field.key] = [...new Set([...(out[field.key] ?? []), ...resolved])];
  }
  return out;
};

/**
 * Reads the search text: a category name, sizes ("6 inch", "144mm", "1.5 l")
 * and option words ("brown", "petrol", "milky white") become a category and
 * filters; what is left is searched as text. Ambiguous words stay as text.
 */
const understandText = async (ctx: Ctx, text: string, categoryId: string | undefined): Promise<Understood> => {
  const result: Understood = { filters: {}, text: '', notes: [] };
  let t = ` ${norm(text)} `;
  const take = (phrase: string) => {
    t = t.replace(` ${phrase} `, ' ');
  };

  /* 1. Category: the longest category name found ("plain tape", "suv", "suvs"). */
  if (!categoryId) {
    let best: { id: string; phrase: string } | null = null;
    for (const [id, list] of ctx.names) {
      for (const name of list) {
        const n = norm(name);
        if (n.length < 2) continue;
        for (const phrase of [n, `${n}s`, n.replace(/s$/, '')]) {
          if (phrase && t.includes(` ${phrase} `) && (!best || phrase.length > best.phrase.length)) best = { id, phrase };
        }
      }
    }
    if (best) {
      result.category_id = best.id;
      take(best.phrase);
    }
  }

  /* Only attributes used inside the category, so "red" means the tape colour, not a leftover t-shirt colour. */
  const scopeId = categoryId ?? result.category_id;
  const used = await usedKeys(scopeId ? scopeOf(ctx, scopeId) : undefined);
  const enumFields = [...ctx.fields.values()].filter((f) => f.type === 'enum' && !f.deprecated && used.has(f.key));
  const add = (f: any, values: string[]) => (result.filters[f.key] = [...new Set([...(result.filters[f.key] ?? []), ...values])] as string[]);

  /* 2. Sizes: a number with a unit. */
  for (const m of [...t.matchAll(/(\d+(?:\.\d+)?)\s*(inch|in|mm|cm|m|l|lit|litre|liter|ml|kg|g)(?=\s)/g)]) {
    let owners = enumFields.map((f) => ({ f, v: matchOptions(f, m[0]) })).filter((x) => x.v.length);
    /* "144 mm" is the tape width, not "144 pieces per box": prefer options whose label carries the unit. */
    if (owners.length > 1) {
      const unit = `${m[1]}${m[2] === 'in' ? 'inch' : m[2]}`;
      const withUnit = owners
        .map((x) => ({ f: x.f, v: x.v.filter((val) => labelsOf(liveOptions(x.f).find((o) => o.value === val) ?? {}).some((l) => compact(l).includes(unit))) }))
        .filter((x) => x.v.length);
      if (withUnit.length) owners = withUnit;
    }
    if (owners.length === 1) {
      add(owners[0].f, owners[0].v);
      take(m[0].trim());
    }
  }

  /* 3. Whole option labels first ("milky white"), then single meaningful words ("brown", "petrol"). */
  const hits = new Map<string, { f: any; values: Set<string> }[]>();
  const hit = (phrase: string, f: any, value: string) => {
    const list = hits.get(phrase) ?? [];
    const entry = list.find((x) => x.f.key === f.key) ?? (list.push({ f, values: new Set() }), list[list.length - 1]);
    entry.values.add(value);
    hits.set(phrase, list);
  };
  for (const pass of ['phrase', 'word'] as const) {
    hits.clear();
    for (const f of enumFields) {
      for (const o of liveOptions(f)) {
        for (const label of [...labelsOf(o), String(o.value)]) {
          const n = norm(label);
          if (pass === 'phrase') {
            if (n.includes(' ') && n.length >= 3 && t.includes(` ${n} `)) hit(n, f, o.value);
          } else {
            for (const w of n.split(' ')) {
              if (w.length >= 3 && !/\d/.test(w) && !GENERIC.has(w) && !STOP.has(w) && t.includes(` ${w} `)) hit(w, f, o.value);
            }
          }
        }
      }
    }
    for (const [phrase, owners] of hits) {
      if (owners.length !== 1) continue; // the same word in two attributes: leave it as text
      add(owners[0].f, [...owners[0].values]);
      take(phrase);
    }
  }

  result.text = norm(t)
    .split(' ')
    .filter((w) => w && !STOP.has(w) && !GENERIC.has(w) && !/^\d+(\.\d+)?$/.test(w))
    .join(' ');
  return result;
};

/* --------------------------------------------------------------- items */

const itemCard = (ctx: Ctx, product: any, item: any, hasTax: boolean, availability: Availability | undefined) => {
  const price = resolvePrice(item);
  const gst = item.gst_rate ?? product.gst_rate ?? null;
  return {
    item_id: item.id,
    sku: item.sku,
    label: itemLabel(ctx, item),
    price_minor: price?.amount_minor ?? null,
    price_text: price ? priceText(price, gst, hasTax) : null,
    ...(price ? {} : { price_note: NOT_PRICED_NOTE }),
    availability: availabilityView(availability),
  };
};

const byPrice = (a: any, b: any) => (a.price?.amount_minor ?? Infinity) - (b.price?.amount_minor ?? Infinity);

/* ------------------------------------------------------------- service */

export interface AiSearchInput {
  search?: string;
  category_id?: string;
  /** Attribute key → wanted values, e.g. { fuel: ["petrol"], colour: ["red"] }. Keys from get_filters. */
  filters?: Record<string, (string | number | boolean)[]>;
  /** Rupees (the agent's unit); converted to paise here. */
  price_min?: number;
  price_max?: number;
  in_stock_only?: boolean;
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'name' | 'size_asc' | 'size_desc';
  page?: number;
  limit?: number;
  language?: Lang;
}

const toPaise = (rupees: unknown) => {
  if (rupees === undefined || rupees === null || rupees === '') return undefined;
  const n = Number(rupees);
  if (!Number.isFinite(n) || n < 0) throw new AppError('Prices must be numbers of rupees, 0 or more', 422);
  return Math.round(n * 100);
};

export const pickLang = (language: unknown): Lang => (LANGUAGES.includes(language as Lang) ? (language as Lang) : 'en');

/** A category id — or a name the agent passed instead of one ("Plain Tape", "suv"). */
const resolveCategory = (ctx: Ctx, raw: string | undefined, notes: string[]): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  if (ctx.paths.has(value)) return value;
  const c = compact(value);
  const byName = [...ctx.names].find(([, list]) => list.some((n) => compact(n) === c || `${compact(n)}s` === c))?.[0];
  if (byName) return byName;
  notes.push(`Ignored category "${value}" — not found. Call list_categories for the ids.`);
  return undefined;
};

/** Every option a product's active variants have, by attribute name. */
export const optionsOf = (ctx: Ctx, p: any, own: any[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const a of p.variant_axes ?? []) {
    const f = ctx.fields.get(a.key);
    const seen = new Map<string, string>();
    for (const i of own) {
      if (i.pack_of) continue;
      const v = (i.attributes ?? []).find((x: any) => x.key === a.key)?.value;
      if (v !== undefined && !seen.has(String(v))) seen.set(String(v), valueText(ctx, a.key, v, i));
    }
    if (seen.size) out[f ? fieldName(ctx, f) : a.key] = [...seen.values()];
  }
  return out;
};

/** Facet counts → { "Tape Size": ["1 inch(24mm) · 2 products", …] } in the attribute's own option order. */
const rangeOf = (ctx: Ctx, facets: Record<string, { value: unknown; count: number }[]>, used: Set<string>): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const f of ctx.fields.values()) {
    if (f.type !== 'enum' || !used.has(f.key) || !facets[f.key]?.length) continue;
    const counts = new Map<unknown, number>(facets[f.key].map((b) => [b.value, b.count]));
    out[fieldName(ctx, f)] = liveOptions(f)
      .filter((o) => counts.has(o.value))
      .map((o) => `${tr(o.label, ctx.lang) || o.value} · ${counts.get(o.value)} product${counts.get(o.value) === 1 ? '' : 's'}`);
  }
  return out;
};

export const aiCatalogService = {
  /**
   * search_products: compact cards (G2) with up to 3 matching items each (G1, G3).
   * The customer's words are understood here (category, sizes, colours …), every
   * card lists ALL its options, and the reply says plainly whether more pages exist.
   */
  async search(input: AiSearchInput) {
    const ctx = await context(pickLang(input.language));
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const notes: string[] = [];

    let categoryId = resolveCategory(ctx, input.category_id, notes);
    const understood: Understood = input.search?.trim()
      ? await understandText(ctx, input.search, categoryId)
      : { filters: {}, text: '', notes: [] };
    const categoryFromWords = !categoryId && Boolean(understood.category_id);
    categoryId = categoryId ?? understood.category_id;
    let used = await usedKeys(categoryId ? scopeOf(ctx, categoryId) : undefined);
    /* What the agent passed wins over what was read from the words. */
    const attributes = { ...understood.filters, ...resolveFilters(ctx, input.filters, used, notes) };

    const base: SearchFilters = {
      category_id: categoryId,
      attributes: Object.keys(attributes).length ? attributes : undefined,
      price_min_minor: toPaise(input.price_min),
      price_max_minor: toPaise(input.price_max),
      page,
      limit,
    };
    const sortFor = (text?: string) => (input.sort === 'relevance' && !text ? undefined : input.sort) as Sort | undefined;
    let text: string | undefined = understood.text || undefined;
    let res = await productSearchService.search({ ...base, search: text, sort: sortFor(text) }, { viewer: true, allVariantFacets: true });
    /* Leftover words that match no name: keep the category / filters, drop the words. */
    if (!res.total && text && (base.category_id || base.attributes)) {
      notes.push(`No product name contains "${text}", so those words were left out of the search.`);
      text = undefined;
      res = await productSearchService.search({ ...base, sort: sortFor(undefined) }, { viewer: true, allVariantFacets: true });
    }
    /* A category read from a word ("car" → "Cars") that finds nothing: search everywhere instead. */
    if (!res.total && categoryFromWords) {
      notes.push(`Nothing in "${ctx.paths.get(base.category_id!)}" matched, so all categories were searched.`);
      base.category_id = categoryId = undefined;
      used = await usedKeys();
      res = await productSearchService.search({ ...base, search: text, sort: sortFor(text) }, { viewer: true, allVariantFacets: true });
    }
    /* Words no product has ("fortuner"): say so, so the agent does not present a near match as the thing asked for. */
    if (text && res.total) {
      const missing: string[] = [];
      for (const w of text.split(' ').slice(0, 5)) {
        if (w.length > 2 && !(await ProductV2Model.countDocuments({ $text: { $search: w }, status: 'active', is_deleted: false }))) missing.push(w);
      }
      if (missing.length) {
        notes.push(`No product matches "${missing.join(' ')}" — these are the closest matches. Tell the customer we do not have "${missing.join(' ')}" before offering them.`);
      }
    }

    const ids = res.items.map((p: any) => p.id);
    const items = ids.length
      ? await ProductItemModel.find({ product_id: { $in: ids }, status: 'active' }).sort({ sort_order: 1, created_at: 1 }).lean<any[]>()
      : [];
    const availability = await availabilityFor(items.map((i) => i.id));

    let cards = res.items.map((p: any) => {
      const own = items.filter((i) => i.product_id === p.id);
      const matched: string[] | undefined = p.matching_item_ids;
      const pool = (matched ? own.filter((i) => matched.includes(i.id)) : own).slice().sort(byPrice);
      /* Normal items first; packs only when there is nothing else (R49). */
      const normal = pool.filter((i) => !i.pack_of);
      const shown = (normal.length ? normal : pool)
        .filter((i) => !input.in_stock_only || availabilityView(availability.get(i.id)).status !== 'out_of_stock')
        .slice(0, MATCHING_ITEMS_ON_CARD);
      const hasTax = hasTaxOf(p, own);
      const from = p.from_price ? resolvePrice({ price: p.from_price }) : null;
      const cardItems = shown.map((i) => itemCard(ctx, p, i, hasTax, availability.get(i.id)));
      const more = Math.max(0, pool.length - cardItems.length);
      return {
        id: p.id,
        name: tr(p.name, ctx.lang),
        brand: p.brand || null,
        category: (p.primary_category_id && ctx.paths.get(p.primary_category_id)) || (p.category_ids ?? []).map((c: string) => ctx.paths.get(c)).find(Boolean) || null,
        price_minor: from?.amount_minor ?? null,
        price_text: from ? `${pool.length > 1 ? 'from ' : ''}${priceText(from, p.gst_rate ?? null, hasTax)}` : null,
        ...(from ? {} : { price_note: NOT_PRICED_NOTE }),
        availability: availabilityView(p.availability?.status === 'tracked' ? { ...p.availability, on_hand: p.availability.available, reserved: 0 } : p.availability),
        /* EVERY option of this product, e.g. { "Tape Size": ["6inch(144mm)"], "Colour": [all 7] }. */
        options: optionsOf(ctx, p, own),
        items: cardItems,
        ...(more
          ? {
              more_items: more,
              items_note: `${cardItems.length} of ${pool.length} variants shown — every option is listed in "options"; get_product_details gives each variant's price and stock.`,
            }
          : {}),
        ...(p.is_bundle ? { bundle: true } : {}),
        image: assetUrl(p.media?.[0]?.url),
      };
    });
    if (input.in_stock_only) {
      cards = cards.filter((c: any) => c.items.length && c.items.some((i: { availability: AvailabilityView }) => i.availability.status !== 'out_of_stock'));
    }

    const first = (page - 1) * limit + 1;
    const last = (page - 1) * limit + res.items.length;
    const hasMore = page < res.pages;
    return {
      understood: {
        category: categoryId ? ctx.paths.get(categoryId) ?? null : null,
        filters: Object.fromEntries(
          Object.entries(attributes).map(([k, vs]) => {
            const f = ctx.fields.get(k);
            return [f ? fieldName(ctx, f) : k, vs.map((v) => (f ? optionLabel(ctx, f, v) : String(v)))];
          })
        ),
        search_text: text ?? null,
      },
      showing: res.total ? `${first}–${last} of ${res.total}` : '0 of 0',
      has_more: hasMore,
      ...(hasMore ? { next_page: page + 1 } : {}),
      message: hasMore
        ? `More results exist: call search_products again with page ${page + 1} (same inputs) before telling the customer this is everything — or answer "which sizes / colours" from "range".`
        : res.total
          ? 'These are all the matches.'
          : 'Nothing matched. Suggest a broader search, fewer words or another category (list_categories). Do not invent products.',
      /* Every option across ALL matches (not just this page), with how many products have it. */
      range: rangeOf(ctx, res.facets as any, used),
      products: cards,
      total: res.total,
      page: res.page,
      pages: res.pages,
      ...(notes.length ? { notes } : {}),
      ...(input.in_stock_only ? { stock_note: 'Out-of-stock variants are left out; totals count every match.' } : {}),
    };
  },


  /** get_product_details: everything a customer may ask about, for up to 20 products. */
  async details(ids: string[], language?: Lang) {
    const lang: Lang = LANGUAGES.includes(language as Lang) ? (language as Lang) : 'en';
    const wanted = [...new Set(ids.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!wanted.length) throw new AppError('At least one product id is required', 422);
    if (wanted.length > MAX_DETAIL_IDS) throw new AppError(`At most ${MAX_DETAIL_IDS} ids per call; ${wanted.length} were given`, 422);
    const ctx = await context(lang);

    const products: any[] = [];
    const missing: string[] = [];
    for (const id of wanted) {
      let p: any;
      try {
        p = await productV2Service.get(id, { activeOnly: true });
      } catch (e) {
        if ((e as AppError).statusCode === 404) {
          missing.push(id);
          continue;
        }
        throw e;
      }
      const live = (p.items ?? []).filter((i: any) => i.status === 'active');
      const hasTax = hasTaxOf(p, live);

      const items = [];
      for (const i of live) {
        const card = itemCard(ctx, p, i, hasTax, i.availability);
        const gst = i.effective?.gst_rate ?? null;
        const ppu = i.price_per_unit;
        const bundle = p.is_bundle ? await bundleService.list(i.id).catch(() => null) : null;
        items.push({
          ...card,
          options: Object.fromEntries((i.attributes ?? []).map((a: any) => [ctx.fields.get(a.key) ? tr(ctx.fields.get(a.key).label, lang) : a.key, valueText(ctx, a.key, a.value, i)])),
          ...(typeof i.compare_at_minor === 'number' && card.price_minor !== null && i.compare_at_minor > card.price_minor
            ? { mrp_text: `MRP ${moneyText(i.compare_at_minor)}`, saving_text: `You save ${moneyText(i.compare_at_minor - card.price_minor)}` }
            : {}),
          ...(hasTax ? { tax_text: `GST ${gst ?? 'not set'}${gst !== null ? '%' : ''}${i.effective?.hsn_code ? ` · HSN ${i.effective.hsn_code}` : ''}` } : {}),
          ...(ppu ? { price_per_unit_text: `${moneyText(ppu.amount_minor, ppu.currency)} / ${ppu.per}` } : {}),
          ...(i.pack_of
            ? {
                pack_text: `Pack of ${i.pack_of.quantity}${i.pack_saving ? ` · save ${i.pack_saving.percent}% (${moneyText(i.pack_saving.amount_minor)}) vs buying singles` : ''}`,
              }
            : {}),
          ...(minMaxSummary(p, i) ? { limits_text: minMaxSummary(p, i) } : {}),
          ...(bundle
            ? {
                bundle_contents: bundle.components.map((c: any) => `${c.quantity} × ${c.product_name ?? c.sku}`),
              }
            : {}),
          ...(i.digital_delivery ? { delivery: i.digital_delivery } : {}),
          image: assetUrl((i.effective?.media ?? [])[0]?.url),
        });
      }

      const attributes = (p.attributes ?? [])
        .filter((a: any) => {
          const f = ctx.fields.get(a.key);
          return f && !f.deprecated && a.value !== null && a.value !== undefined && a.value !== '';
        })
        .map((a: any) => ({ name: tr(ctx.fields.get(a.key).label, lang), value: valueText(ctx, a.key, a.value) }));

      products.push({
        id: p.id,
        name: tr(p.name, lang),
        brand: p.brand || null,
        description: tr(p.description, lang) || null,
        categories: (p.category_ids ?? []).map((c: string) => ctx.paths.get(c)).filter(Boolean),
        attributes,
        variant_options: (p.variant_axes ?? []).map((a: any) => ctx.fields.get(a.key) ? tr(ctx.fields.get(a.key).label, lang) : a.key),
        fulfilment: p.effective?.fulfilment ?? 'goods',
        availability: availabilityView(p.availability?.status === 'tracked' ? { ...p.availability, on_hand: p.availability.available, reserved: 0 } : p.availability),
        items,
        images: (p.media ?? []).slice(0, 5).map((m: any) => assetUrl(m.url)),
      });
    }

    return {
      products,
      requested: wanted.length,
      returned: products.length,
      missing,
      ...(missing.length ? { message: 'Some ids are not in the catalogue (or not on sale). Do not describe those.' } : {}),
    };
  },

  /** get_filters: only the attributes products in scope actually use, with real options and counts. */
  async filters(categoryId?: string, language?: Lang) {
    const ctx = await context(pickLang(language));
    const notes: string[] = [];
    const scopeId = resolveCategory(ctx, categoryId, notes);
    const used = await usedKeys(scopeId ? scopeOf(ctx, scopeId) : undefined);
    const res = await productSearchService.search({ category_id: scopeId, limit: 1 }, { viewer: true, allVariantFacets: true });
    const facets = res.facets as Record<string, { value: unknown; count: number }[]>;
    const filters = [...ctx.fields.values()]
      .filter((f) => !f.deprecated && used.has(f.key) && (f.filterable || f.variant_forming))
      .map((f) => {
        const base = { key: f.key, name: fieldName(ctx, f), type: f.type };
        if (f.type === 'enum') {
          const counts = new Map<unknown, number>((facets[f.key] ?? []).map((b) => [b.value, b.count]));
          const options = liveOptions(f)
            .filter((o) => counts.has(o.value))
            .map((o) => ({ value: o.value, label: tr(o.label, ctx.lang), products: counts.get(o.value) }));
          return { ...base, options };
        }
        if (f.type === 'boolean') return { ...base, options: [true, false] };
        if (f.type === 'number' && f.unit_family) {
          const example = f.unit_family === 'volume' ? '1 l' : f.unit_family === 'weight' ? '500 g' : f.unit_family === 'length' ? '2 m' : '4 pieces';
          return { ...base, size: true, unit_family: f.unit_family, example };
        }
        return { ...base, ...(f.unit ? { unit: f.unit } : {}) };
      })
      .filter((f: any) => f.type !== 'enum' || f.options.length);
    return {
      scope: scopeId ? ctx.paths.get(scopeId) ?? null : 'All products',
      filters,
      sorts: ['relevance', 'price_asc', 'price_desc', 'newest', 'name', 'size_asc', 'size_desc'],
      products_in_scope: res.total,
      how_to_use:
        'Easiest: put the customer\'s words in search_products `search` (e.g. "6 inch brown plain tape" or "diesel suv") — categories, sizes and colours are recognised automatically. ' +
        'Or pass filters { "<key>": ["<value or label>"] }; labels like "6 inch" or "Brown" also work.',
      ...(notes.length ? { notes } : {}),
    };
  },


  /** list_categories: visible categories with their path and number of products on sale. */
  async categories(search?: string, language?: Lang) {
    const lang: Lang = LANGUAGES.includes(language as Lang) ? (language as Lang) : 'en';
    const ctx = await context(lang);
    const counts = new Map<string, number>(
      (
        await ProductV2Model.aggregate<{ _id: string; n: number }>([
          { $match: { is_deleted: false, status: 'active' } },
          { $unwind: '$category_ids' },
          { $group: { _id: '$category_ids', n: { $sum: 1 } } },
        ])
      ).map((r) => [r._id, r.n])
    );
    const term = String(search ?? '').trim().toLowerCase();
    const categories = [...ctx.paths.entries()]
      .filter(([, path]) => !term || path.toLowerCase().includes(term))
      .map(([id, path]) => ({ id, name: path.split(' › ').pop(), path, products: counts.get(id) ?? 0 }));
    return categories.length
      ? { categories, total: categories.length }
      : { categories: [], total: 0, message: term ? 'No category matched that name.' : 'No categories are set up yet.' };
  },

  /** check_availability: live availability for items of products on sale. */
  async availability(itemIds: string[]) {
    const wanted = [...new Set(itemIds.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!wanted.length) throw new AppError('At least one item id is required', 422);
    if (wanted.length > MAX_AVAILABILITY_IDS) throw new AppError(`At most ${MAX_AVAILABILITY_IDS} item ids per call`, 422);
    const items = await ProductItemModel.find({ id: { $in: wanted }, status: 'active' }).lean<any[]>();
    const onSale = new Set(
      (await ProductV2Model.find({ id: { $in: [...new Set(items.map((i) => i.product_id))] }, status: 'active' }).lean<any[]>()).map((p) => p.id)
    );
    const live = items.filter((i) => onSale.has(i.product_id));
    const a = await availabilityFor(live.map((i) => i.id));
    const found = new Set(live.map((i) => i.id));
    return {
      items: live.map((i) => ({ item_id: i.id, sku: i.sku, product_id: i.product_id, availability: availabilityView(a.get(i.id)) })),
      missing: wanted.filter((id) => !found.has(id)),
    };
  },
};
