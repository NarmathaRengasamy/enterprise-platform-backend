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
const tr = (t: any, lang: Lang): string => (t ? t[lang] || t.en || '' : '');

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
const assetUrl = (url: string | undefined | null) => {
  if (!url) return null;
  const base = process.env.PUBLIC_ASSET_BASE_URL?.trim().replace(/\/+$/, '');
  return base && url.startsWith('/') ? `${base}${url}` : url;
};

const hasTaxOf = (p: any, items: any[]) =>
  Boolean(p.hsn_code || p.sac_code || (p.gst_rate ?? null) !== null || items.some((i) => (i.gst_rate ?? null) !== null || i.hsn_code));

/* ------------------------------------------------------------- context */

interface Ctx {
  lang: Lang;
  fields: Map<string, any>;
  /** Live, visible categories: id → path ("Vehicles › SUV"). */
  paths: Map<string, string>;
}

const context = async (lang: Lang): Promise<Ctx> => {
  const type = plain(await productTypeService.getActive());
  const fields = new Map<string, any>(((type?.fields ?? []) as any[]).map((f) => [f.key, f]));
  const paths = new Map<string, string>();
  const walk = (nodes: any[], trail: string[]) =>
    nodes.forEach((n) => {
      if (n.status === 'hidden' || n.is_deleted) return; // a hidden category hides its sub-categories too
      const path = [...trail, tr(n.name, lang) || n.code];
      paths.set(n.id, path.join(' › '));
      walk(n.children ?? [], path);
    });
  walk(await catalogCategoryService.tree(false), []);
  return { lang, fields, paths };
};

const valueText = (ctx: Ctx, key: string, value: unknown, item?: any): string => {
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

export const aiCatalogService = {
  /** search_products: compact cards (G2) with up to 3 matching items each (G1, G3). */
  async search(input: AiSearchInput) {
    const lang: Lang = LANGUAGES.includes(input.language as Lang) ? (input.language as Lang) : 'en';
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));
    const filters: SearchFilters = {
      search: input.search?.trim() || undefined,
      category_id: input.category_id || undefined,
      attributes: input.filters,
      price_min_minor: toPaise(input.price_min),
      price_max_minor: toPaise(input.price_max),
      sort: (input.sort === 'relevance' && !input.search?.trim() ? undefined : input.sort) as Sort | undefined,
      page: Math.max(1, Math.floor(input.page ?? 1)),
      limit,
    };
    const res = await productSearchService.search(filters, { viewer: true });
    const ctx = await context(lang);

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
      return {
        id: p.id,
        name: tr(p.name, lang),
        brand: p.brand || null,
        category: (p.primary_category_id && ctx.paths.get(p.primary_category_id)) || (p.category_ids ?? []).map((c: string) => ctx.paths.get(c)).find(Boolean) || null,
        price_minor: from?.amount_minor ?? null,
        price_text: from ? `${pool.length > 1 ? 'from ' : ''}${priceText(from, p.gst_rate ?? null, hasTax)}` : null,
        ...(from ? {} : { price_note: NOT_PRICED_NOTE }),
        availability: availabilityView(p.availability?.status === 'tracked' ? { ...p.availability, on_hand: p.availability.available, reserved: 0 } : p.availability),
        items: cardItems,
        more_items: Math.max(0, pool.length - cardItems.length),
        ...(p.is_bundle ? { bundle: true } : {}),
        image: assetUrl(p.media?.[0]?.url),
      };
    });
    if (input.in_stock_only) cards = cards.filter((c) => c.items.length && c.items.some((i) => i.availability.status !== 'out_of_stock'));

    return {
      products: cards,
      total: res.total,
      page: res.page,
      pages: res.pages,
      ...(input.in_stock_only ? { note: 'Out-of-stock items are left out of this page; totals count every match.' } : {}),
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

  /** get_filters: what the agent can filter on, with the options that have products. */
  async filters(categoryId?: string, language?: Lang) {
    const lang: Lang = LANGUAGES.includes(language as Lang) ? (language as Lang) : 'en';
    const ctx = await context(lang);
    const res = await productSearchService.search({ category_id: categoryId || undefined, limit: 1 }, { viewer: true });
    const filters = [...ctx.fields.values()]
      .filter((f) => !f.deprecated && (f.filterable || f.variant_forming))
      .map((f) => {
        const counts = new Map<unknown, number>(((res.facets as any)[f.key] ?? []).map((b: any) => [b.value, b.count]));
        const base = { key: f.key, name: tr(f.label, lang), type: f.type };
        if (f.type === 'enum') {
          const options = (f.options ?? [])
            .filter((o: any) => !o.deprecated && (!counts.size || counts.has(o.value)))
            .map((o: any) => ({ value: o.value, label: tr(o.label, lang), ...(counts.has(o.value) ? { products: counts.get(o.value) } : {}) }));
          return { ...base, options };
        }
        if (f.type === 'number' && f.unit_family) return { ...base, size: true, unit_family: f.unit_family, example: f.unit_family === 'volume' ? '1 l' : f.unit_family === 'weight' ? '500 g' : f.unit_family === 'length' ? '2 m' : '4 pieces' };
        return { ...base, ...(f.unit ? { unit: f.unit } : {}) };
      })
      .filter((f: any) => f.type !== 'enum' || f.options.length);
    return {
      filters,
      sorts: ['relevance', 'price_asc', 'price_desc', 'newest', 'name', 'size_asc', 'size_desc'],
      products_in_scope: res.total,
      how_to_use: 'Pass filters to search_products as { "<key>": ["<value>"] } using the option `value`, not the label. Sizes take "1 l" style text.',
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
