import { AppError } from '../middlewares/errorHandler.js';
import { ProductV2Model } from '../models/ProductV2.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { ItemStockModel } from '../models/ItemStock.model.js';
import { INCLUDE_DELETED } from '../models/plugins/base.plugin.js';
import { newId } from '../utils/id.util.js';
import { assertMinor } from '../utils/money.util.js';
import { Tx, withTransaction } from '../utils/transaction.util.js';
import { createLogger } from '../utils/logger.js';
import { productTypeService } from './productType.service.js';
import { tenantSettingsService } from './tenantSettings.service.js';
import { catalogCategoryService } from './catalogCategory.service.js';
import { pricePerUnit, resolvePrice } from './price.service.js';
import { limitsService, PurchaseLimitsInput } from './limits.service.js';
import { variantService, suggestSku, MAX_COMBINATIONS } from './variant.service.js';
import {
  AttributeValue,
  axisValueKeys,
  axisValueLabel,
  checkItemAttributes,
  checkProductAttributes,
  checkVariantAxes,
  measureOf,
  missingRequired,
  signatureOf,
  VariantAxis,
} from './attributeValidation.service.js';
import type { Fulfilment, Tracking, Translated } from '../types/productType.types.js';

const log = createLogger('ProductV2');

/**
 * Products and items (design §3.3–§3.5, §6, §7.5, §10; R13a–R13c, R16–R27, R31).
 *
 * A product always has at least one item (R18). Items keep their ids for life
 * (R21): edits go through the item by id and removed items are soft-deleted.
 * Money is whole paise (R22). Track inventory / Tracking / Fulfilment live on
 * the product, pre-filled from the product type — categories are never
 * consulted (R13). Writes that belong together run in one transaction (or, on a
 * standalone server, in order with clean-up — see transaction.util).
 */

/* India's GST rates, including the September 2025 rationalisation (5 / 18 / 40)
   and the older 12 / 28 slabs still found on existing goods. */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/;
const TAX_CODE = /^\d{4,8}$/;
export const MAX_ITEMS = MAX_COMBINATIONS;

type Status = 'draft' | 'active' | 'archived';

export interface MediaInput {
  url: string;
  kind?: 'image' | 'video';
  alt?: string;
  sort_order?: number;
}

export interface PriceInput {
  amount_minor: number;
  currency?: string;
  tax_inclusive?: boolean;
  price_unit?: 'each' | 'hour' | 'day' | 'month';
}

export interface ItemInput {
  sku?: string;
  attributes?: AttributeValue[];
  price?: PriceInput | null;
  compare_at_minor?: number | null;
  gst_rate?: number | null;
  hsn_code?: string | null;
  track_inventory?: boolean | null;
  digital_delivery?: 'download' | 'licence' | 'link' | null;
  media?: MediaInput[];
  status?: 'active' | 'inactive';
  initial_stock?: number;
  /** R50: this item's override; each null value = the product's value. */
  purchase_limits?: PurchaseLimitsInput | null;
}

export type ItemPatch = Omit<ItemInput, 'attributes' | 'initial_stock'>;

export interface ProductInput {
  name: Translated;
  description?: Translated;
  slug?: string;
  brand?: string;
  category_ids?: string[];
  primary_category_id?: string | null;
  attributes?: AttributeValue[];
  variant_axes?: VariantAxis[];
  track_inventory?: boolean;
  tracking?: Tracking | null;
  fulfilment?: Fulfilment | null;
  hsn_code?: string | null;
  sac_code?: string | null;
  gst_rate?: number | null;
  media?: MediaInput[];
  option_media?: { attribute_key: string; value: string; media: MediaInput[] }[];
  is_bundle?: boolean;
  /** R50: null = no limits. */
  purchase_limits?: PurchaseLimitsInput | null;
  items?: ItemInput[];
}

export type ProductPatch = Partial<Omit<ProductInput, 'items'>>;

/* ------------------------------------------------------------- helpers */

const invalid = (message: string, field?: string) =>
  new AppError(message, 422, undefined, field ? { [field]: message } : undefined);
const conflict = (message: string) => new AppError(message, 409);
const notFound = (what = 'Product') => new AppError(`${what} not found`, 404);
const plain = (d: any) => (d && typeof d.toJSON === 'function' ? d.toJSON() : d);
const strip = ({ _id, ...rest }: any) => rest;

const cleanTranslated = (t?: Translated): Translated | undefined =>
  t
    ? {
        en: t.en.trim(),
        ...(t.ta?.trim() ? { ta: t.ta.trim() } : {}),
        ...(t.hi?.trim() ? { hi: t.hi.trim() } : {}),
      }
    : undefined;

/** "Hyundai Creta 1.5" → "hyundai-creta-1-5". A name with no Latin letters gets "product". */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'product';

const slugTaken = async (slug: string, exceptId?: string) =>
  Boolean(await ProductV2Model.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) }));

/** On create a clash gets a suffix: `creta`, `creta-2`, `creta-3`… */
const uniqueSlug = async (base: string) => {
  if (!(await slugTaken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 95)}-${n}`;
    if (!(await slugTaken(candidate))) return candidate;
  }
  throw conflict(`Too many products share the slug "${base}"`);
};

const checkMedia = (list: MediaInput[] | undefined, path: string) =>
  (list ?? []).map((m, i) => {
    const url = String(m.url ?? '').trim();
    if (url.startsWith('blob:')) {
      throw invalid('This file was never uploaded (a blob: link only works in one browser tab) — upload it again', `${path}.${i}.url`);
    }
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/uploads/')) {
      throw invalid('A media link must be an uploaded file (/uploads/…) or an http(s) URL', `${path}.${i}.url`);
    }
    return { url, kind: m.kind ?? 'image', alt: m.alt ?? '', sort_order: m.sort_order ?? i };
  });

const checkGst = (rate: number | null | undefined, path: string) => {
  if (rate === undefined || rate === null) return rate;
  if (!GST_RATES.includes(rate)) throw invalid(`GST rate must be one of ${GST_RATES.join(', ')} %`, path);
  return rate;
};

const checkTaxCode = (code: string | null | undefined, path: string, label: string) => {
  if (code === undefined || code === null || code === '') return code === '' ? null : code;
  const c = code.trim();
  if (!TAX_CODE.test(c)) throw invalid(`${label} must be 4–8 digits`, path);
  return c;
};

const checkPrice = (p: PriceInput, path: string, currency: string) => {
  assertPriceMinor(p.amount_minor, `${path}.amount_minor`);
  const cur = (p.currency ?? currency).toUpperCase();
  if (cur !== currency) throw invalid(`Prices are in ${currency} for this business`, `${path}.currency`);
  return {
    amount_minor: p.amount_minor,
    currency: cur,
    /* D2: prices include GST unless said otherwise (MRP-style). */
    tax_inclusive: p.tax_inclusive ?? true,
    price_unit: p.price_unit ?? 'each',
  };
};

const assertPriceMinor = (value: unknown, path: string) => {
  try {
    assertMinor(value);
  } catch (e) {
    throw invalid((e as Error).message, path);
  }
};

const assertCount = (value: unknown, path: string, what: string) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid(`${what} must be a whole number of 0 or more`, path);
};

/** Maps a unique-index race (two saves at once) to the same 409 the pre-checks give. */
const duplicateKey = (e: any) => {
  if (e?.code !== 11000) return e;
  const key = Object.keys(e.keyPattern ?? e.keyValue ?? {})[0];
  const value = e.keyValue ? Object.values(e.keyValue)[0] : undefined;
  if (key === 'sku') return conflict(`An item with the SKU "${value}" already exists`);
  if (key === 'slug') return conflict(`A product with the slug "${value}" already exists`);
  if (key === 'product_id' || key === 'attribute_signature') return conflict('This product already has an item with that combination');
  return conflict('That already exists');
};

/* ---------------------------------------------------------- categories */

interface CategoryContext {
  ids: string[];
  primary: string | null;
  /** Union of the categories' visible fields (R15b); null = every field. */
  visible: Set<string> | null;
}

const categoryIndex = async () => {
  const out = new Map<string, any>();
  const walk = (nodes: any[]) =>
    nodes.forEach((n) => {
      out.set(n.id, n);
      walk(n.children ?? []);
    });
  walk(await catalogCategoryService.tree(false));
  return out;
};

const categoryContext = async (ids: string[], primary: string | null | undefined, keep: string[] = []): Promise<CategoryContext> => {
  const unique = [...new Set(ids)];
  const index = await categoryIndex();
  unique.forEach((id, i) => {
    /* A category deleted after the product was filed under it is kept, not refused. */
    if (!index.has(id) && !keep.includes(id)) throw invalid('That category does not exist (or is deleted)', `category_ids.${i}`);
  });
  const chosen = primary ?? unique[0] ?? null;
  if (chosen && !unique.includes(chosen)) throw invalid('The primary category must be one of the chosen categories', 'primary_category_id');
  const live = unique.map((id) => index.get(id)).filter(Boolean);
  const visible = live.length ? new Set<string>(live.flatMap((c: any) => c.resolved_visible_field_keys ?? [])) : null;
  return { ids: unique, primary: chosen, visible };
};

/* ------------------------------------------------------ product settings */

/**
 * R13a–R13c. Missing values are pre-filled from the product type: fulfilment =
 * the type's; Track inventory on for goods, off otherwise; Tracking = the
 * type's when tracked, `none` when not.
 */
const settingsFor = (type: any, input: ProductPatch, existing?: any) => {
  const fulfilment: Fulfilment = input.fulfilment ?? existing?.fulfilment ?? type.fulfilment ?? 'goods';
  const track: boolean = input.track_inventory ?? existing?.track_inventory ?? fulfilment === 'goods';
  let tracking: Tracking;
  if (!track) {
    if (input.tracking === 'batch' || input.tracking === 'serial') {
      throw invalid('Batch or serial tracking needs Track inventory on', 'tracking');
    }
    tracking = 'none';
  } else if (input.tracking) {
    tracking = input.tracking;
  } else {
    /* Tracked already → keep; just switched on → the type default. */
    tracking = existing?.track_inventory ? existing.tracking ?? type.tracking ?? 'none' : type.tracking ?? 'none';
  }
  return { fulfilment, track_inventory: track, tracking };
};

const effectiveTrack = (item: any, product: any): boolean => item.track_inventory ?? product.track_inventory;

/* ----------------------------------------------------------- the items */

interface PreparedItem {
  doc: Record<string, any>;
  initial_stock?: number;
  skuGiven: boolean;
}

const prepareItem = (it: ItemInput, path: string, ctx: { axes: VariantAxis[]; product: any; currency: string; slug: string }): PreparedItem => {
  const attributes = checkItemAttributes(it.attributes ?? [], ctx.axes, path);
  const skuGiven = Boolean(it.sku?.trim());
  let sku = it.sku?.trim() ?? '';
  if (skuGiven && !SKU_PATTERN.test(sku)) {
    throw invalid('SKU: up to 64 letters, digits, ".", "_", "-" or "/", starting with a letter or digit', `${path}.sku`);
  }
  if (!skuGiven) sku = suggestSku(ctx.slug, skuValues(attributes, ctx.axes));
  if (it.compare_at_minor !== undefined && it.compare_at_minor !== null) assertPriceMinor(it.compare_at_minor, `${path}.compare_at_minor`);

  const track_inventory = it.track_inventory ?? null;
  const tracked = track_inventory ?? ctx.product.track_inventory;
  if (it.initial_stock !== undefined) {
    if (!tracked) throw conflict(`Not tracked: ${sku} has Track inventory off, so it takes no stock`);
    assertCount(it.initial_stock, `${path}.initial_stock`, 'Initial stock');
  }

  return {
    skuGiven,
    initial_stock: it.initial_stock,
    doc: {
      id: newId(),
      sku,
      attributes,
      attribute_signature: signatureOf(attributes),
      track_inventory,
      price: it.price ? checkPrice(it.price, `${path}.price`, ctx.currency) : null,
      compare_at_minor: it.compare_at_minor ?? null,
      gst_rate: checkGst(it.gst_rate, `${path}.gst_rate`) ?? null,
      hsn_code: checkTaxCode(it.hsn_code, `${path}.hsn_code`, 'HSN code') ?? null,
      digital_delivery: it.digital_delivery ?? null,
      media: checkMedia(it.media, `${path}.media`),
      /* R45: the measured size, from the item's size value; null without one. */
      measure: measureOf(attributes, ctx.axes),
      purchase_limits: limitsService.validate(it.purchase_limits, `${path}.purchase_limits`) ?? null,
      status: it.status ?? 'active',
    },
  };
};

/** Values for a suggested SKU: a size by its label ("500ml"), not its base amount. */
const skuValues = (attributes: AttributeValue[], axes: VariantAxis[]): AttributeValue[] =>
  attributes.map((a) => {
    const axis = axes.find((x) => x.key === a.key);
    const at = axis ? axisValueKeys(axis).indexOf(String(a.value)) : -1;
    return { key: a.key, value: axis && at >= 0 ? axisValueLabel(axis.values[at]).replace(/\s+/g, '') : a.value };
  });

/** First SKU among these already used by another live item. */
const skuInUse = async (skus: string[], exceptItemIds: string[] = []) => {
  if (!skus.length) return undefined;
  const hit = await ProductItemModel.findOne({ sku: { $in: skus }, ...(exceptItemIds.length ? { id: { $nin: exceptItemIds } } : {}) }).lean<any>();
  return hit?.sku as string | undefined;
};

/** Auto-made SKUs never clash: `CRETA-PETROL`, then `CRETA-PETROL-2`… */
const freeSku = async (sku: string, reserved: Set<string>) => {
  let candidate = sku;
  for (let n = 2; reserved.has(candidate) || (await skuInUse([candidate])); n++) candidate = `${sku.slice(0, 60)}-${n}`;
  reserved.add(candidate);
  return candidate;
};

const minPriceOf = (items: any[]) => {
  const prices = items
    .filter((i) => !i.is_deleted && i.status === 'active')
    .map((i) => resolvePrice(i)?.amount_minor)
    .filter((v): v is number => typeof v === 'number');
  return prices.length ? Math.min(...prices) : null;
};

const recomputeMinPrice = async (productId: string, tx?: Tx) => {
  const items = await ProductItemModel.find({ product_id: productId }).session(tx?.session ?? null).lean<any[]>();
  await ProductV2Model.updateOne({ id: productId }, { $set: { min_price_minor: minPriceOf(items) } }, { session: tx?.session });
};

/** Track inventory going off for these items: refused while any has stock (R31a); empty rows are removed (R31). */
const stopTracking = async (itemIds: string[], tx: Tx, label: string) => {
  if (!itemIds.length) return;
  const rows = await ItemStockModel.find({ item_id: { $in: itemIds } }).session(tx.session ?? null).lean<any[]>();
  const busy = rows.filter((r) => r.on_hand > 0 || r.reserved > 0);
  if (busy.length) {
    const total = busy.reduce((n, r) => n + r.on_hand, 0);
    throw conflict(`${label} still has stock (${total} on hand) — adjust it to 0 first, then turn Track inventory off`);
  }
  if (!rows.length) return;
  const at = new Date();
  const ids = rows.map((r) => r.id);
  await ItemStockModel.updateMany({ id: { $in: ids } }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
  tx.undo(() => ItemStockModel.collection.updateMany({ id: { $in: ids } }, { $set: { is_deleted: false, deleted_at: null } }));
};

/* ------------------------------------------------------------ response */

const optionMediaFor = (product: any, item: any) => {
  for (const a of item.attributes ?? []) {
    const hit = (product.option_media ?? []).find((o: any) => o.attribute_key === a.key && o.value === String(a.value) && o.media?.length);
    if (hit) return hit.media;
  }
  return null;
};

/** The wire shape: stored values plus what is actually in force (design §6.3). */
export const toResponse = (product: any, items: any[], stocks: any[], type: any, deletedItems: any[] = []) => {
  const p = strip(plain(product));
  const tracking = p.track_inventory ? p.tracking ?? type?.tracking ?? 'none' : 'none';
  const fulfilment = p.fulfilment ?? type?.fulfilment ?? 'goods';
  const stockByItem = new Map<string, any[]>();
  for (const s of stocks) stockByItem.set(s.item_id, [...(stockByItem.get(s.item_id) ?? []), s]);

  const view = (raw: any) => {
    const i = strip(plain(raw));
    const tracked = effectiveTrack(i, p);
    const rows = stockByItem.get(i.id) ?? [];
    const on_hand = rows.reduce((n, r) => n + (r.on_hand ?? 0), 0);
    const reserved = rows.reduce((n, r) => n + (r.reserved ?? 0), 0);
    const limits = limitsService.effective(p.purchase_limits, i.purchase_limits);
    return {
      ...i,
      /* Phase 3b (additive): older documents have neither field stored. */
      measure: i.measure ?? null,
      purchase_limits: i.purchase_limits ?? null,
      resolved_price: resolvePrice(i),
      /* Worked out here, never stored (R46). */
      price_per_unit: pricePerUnit(i),
      effective_limits: limits,
      limits_summary: limitsService.summary(limits),
      effective: {
        track_inventory: tracked,
        tracking: tracked ? tracking : 'none',
        gst_rate: i.gst_rate ?? p.gst_rate ?? null,
        hsn_code: i.hsn_code ?? p.hsn_code ?? null,
        media: i.media?.length ? i.media : optionMediaFor(p, i) ?? p.media ?? [],
      },
      availability: tracked
        ? { status: 'tracked', on_hand, reserved, available: on_hand - reserved }
        : { status: 'not_tracked' },
    };
  };

  const live = items.map(view);
  const tracked = live.filter((i) => i.effective.track_inventory && i.status === 'active');
  return {
    ...p,
    purchase_limits: p.purchase_limits ?? null,
    effective: { fulfilment, track_inventory: p.track_inventory, tracking },
    items: live,
    ...(deletedItems.length ? { deleted_items: deletedItems.map(view) } : {}),
    availability: tracked.length
      ? { status: 'tracked', available: tracked.reduce((n, i) => n + (i.availability as any).available, 0) }
      : { status: 'not_tracked' },
  };
};

/* ------------------------------------------------------------- service */

const liveProduct = async (id: string) => {
  const p = await ProductV2Model.findOne({ id }).lean<any>();
  if (!p) throw notFound();
  return p;
};

const itemsOf = (productId: string) => ProductItemModel.find({ product_id: productId }).sort({ sort_order: 1, created_at: 1 }).lean<any[]>();

const checkOptionMedia = (list: ProductInput['option_media'], axes: VariantAxis[]) =>
  (list ?? []).map((o, i) => {
    const axis = axes.find((a) => a.key === o.attribute_key);
    if (!axis || !axisValueKeys(axis).includes(o.value)) {
      throw invalid(`Option images must belong to one of this product's variant options`, `option_media.${i}`);
    }
    return { attribute_key: o.attribute_key, value: o.value, media: checkMedia(o.media, `option_media.${i}.media`) };
  });

const assertAxesVisible = (axes: VariantAxis[], visible: Set<string> | null, existing: VariantAxis[] = []) =>
  axes.forEach((a, i) => {
    if (visible && !visible.has(a.key) && !existing.some((e) => e.key === a.key)) {
      throw invalid(`"${a.key}" is not shown for this product's categories`, `variant_axes.${i}`);
    }
  });

export const productV2Service = {
  async get(id: string, opts: { includeDeleted?: boolean; activeOnly?: boolean } = {}) {
    const product = await ProductV2Model.findOne({ id, ...(opts.includeDeleted ? INCLUDE_DELETED : {}) }).lean<any>();
    if (!product || (opts.activeOnly && product.status !== 'active')) throw notFound();
    const all = await ProductItemModel.find({ product_id: id, ...INCLUDE_DELETED }).sort({ sort_order: 1, created_at: 1 }).lean<any[]>();
    /* A deleted product shows the items deleted with it; a live one its live items. */
    const items = all.filter((i) => (product.is_deleted ? i.deleted_at?.getTime?.() === product.deleted_at?.getTime?.() : !i.is_deleted));
    const deleted = opts.includeDeleted && !product.is_deleted ? all.filter((i) => i.is_deleted) : [];
    const stocks = await ItemStockModel.find({ item_id: { $in: items.map((i) => i.id) }, ...(product.is_deleted ? INCLUDE_DELETED : {}) }).lean<any[]>();
    const type = plain(await productTypeService.getActive());
    return toResponse(product, items, stocks, type, deleted);
  },

  async create(input: ProductInput) {
    const type = plain(await productTypeService.requireActive());
    const currency = ((await tenantSettingsService.get()).default_currency as string) || 'INR';
    const cats = await categoryContext(input.category_ids ?? [], input.primary_category_id);
    const axes = checkVariantAxes(type, input.variant_axes ?? []);
    assertAxesVisible(axes, cats.visible);
    const attributes = checkProductAttributes(type, input.attributes ?? [], { axes, visible: cats.visible });
    const settings = settingsFor(type, input);
    const purchaseLimits = limitsService.validate(input.purchase_limits) ?? null;
    const name = cleanTranslated(input.name)!;

    let itemsIn = input.items ?? [];
    if (!axes.length) {
      if (itemsIn.length > 1) throw invalid('A product without variant options has exactly one item', 'items');
      if (!itemsIn.length) itemsIn = [{}]; // R18: the one item, made automatically
    } else if (!itemsIn.length) {
      throw invalid('Choose at least one combination to create', 'items');
    }
    if (itemsIn.length > MAX_ITEMS) throw invalid(`At most ${MAX_ITEMS} items per product`, 'items');

    if (input.slug !== undefined && !SLUG_PATTERN.test(input.slug)) {
      throw invalid('Slug: lowercase letters, digits and single hyphens', 'slug');
    }
    const slug = await uniqueSlug(input.slug || slugify(name.en));
    const product = { track_inventory: settings.track_inventory };
    const prepared = itemsIn.map((it, i) => prepareItem(it, `items.${i}`, { axes, product, currency, slug }));

    const signatures = new Set<string>();
    const given = new Set<string>();
    for (const [i, p] of prepared.entries()) {
      if (signatures.has(p.doc.attribute_signature)) throw conflict(`Items ${i + 1} and an earlier one have the same combination`);
      signatures.add(p.doc.attribute_signature);
      if (p.skuGiven) {
        if (given.has(p.doc.sku)) throw conflict(`The SKU "${p.doc.sku}" is used twice`);
        given.add(p.doc.sku);
      }
    }
    /* Each item's limits combined with the product's must hold too. */
    limitsService.assertEffective(
      purchaseLimits,
      prepared.map((p) => ({ sku: p.doc.sku, purchase_limits: p.doc.purchase_limits }))
    );
    const taken = await skuInUse([...given]);
    if (taken) throw conflict(`An item with the SKU "${taken}" already exists`);
    for (const p of prepared) if (!p.skuGiven) p.doc.sku = await freeSku(p.doc.sku, given);
    prepared.forEach((p, i) => (p.doc.sort_order = i));

    const id = newId();
    const doc = {
      id,
      slug,
      name,
      ...(input.description ? { description: cleanTranslated(input.description) } : {}),
      brand: input.brand?.trim() ?? '',
      product_type_id: type.id,
      type_version: type.type_version,
      category_ids: cats.ids,
      primary_category_id: cats.primary,
      attributes,
      variant_axes: axes,
      ...settings,
      hsn_code: checkTaxCode(input.hsn_code, 'hsn_code', 'HSN code') ?? null,
      sac_code: checkTaxCode(input.sac_code, 'sac_code', 'SAC code') ?? null,
      gst_rate: checkGst(input.gst_rate, 'gst_rate') ?? null,
      media: checkMedia(input.media, 'media'),
      option_media: checkOptionMedia(input.option_media, axes),
      is_bundle: input.is_bundle ?? false,
      purchase_limits: purchaseLimits,
      min_price_minor: minPriceOf(prepared.map((p) => p.doc)),
      currency,
      status: 'draft' as Status,
    };

    try {
      await withTransaction(async (tx) => {
        await ProductV2Model.create([doc], { session: tx.session });
        tx.undo(() => ProductV2Model.collection.deleteOne({ id }));
        for (const p of prepared) {
          await ProductItemModel.create([{ ...p.doc, product_id: id }], { session: tx.session });
          tx.undo(() => ProductItemModel.collection.deleteOne({ id: p.doc.id }));
          if (p.initial_stock !== undefined) {
            const stockId = newId();
            await ItemStockModel.create([{ id: stockId, item_id: p.doc.id, on_hand: p.initial_stock }], { session: tx.session });
            tx.undo(() => ItemStockModel.collection.deleteOne({ id: stockId }));
          }
        }
      });
    } catch (e) {
      throw duplicateKey(e);
    }
    log.log(`Product created: ${slug} with ${prepared.length} item(s)`);
    return this.get(id);
  },

  async update(id: string, patch: ProductPatch) {
    const current = await liveProduct(id);
    const type = plain(await productTypeService.requireActive());

    const ids = patch.category_ids ?? current.category_ids;
    const primary =
      patch.primary_category_id !== undefined
        ? patch.primary_category_id
        : ids.includes(current.primary_category_id)
          ? current.primary_category_id
          : ids[0] ?? null; // the primary was removed: the next one takes over
    const cats = await categoryContext(ids, primary, current.category_ids);

    const items = await itemsOf(id);
    let axes: VariantAxis[] = current.variant_axes;
    if (patch.variant_axes) {
      axes = checkVariantAxes(type, patch.variant_axes, current.variant_axes);
      assertAxesVisible(axes, cats.visible, current.variant_axes);
      const before = current.variant_axes.map((a: VariantAxis) => a.key).sort().join();
      if (axes.map((a) => a.key).sort().join() !== before) {
        throw conflict('Variant options cannot be added or removed once items exist — add or remove values instead');
      }
      for (const axis of current.variant_axes as VariantAxis[]) {
        const kept = new Set(axisValueKeys(axes.find((a) => a.key === axis.key)!));
        const inUse = items.find((i) => i.attributes.some((a: AttributeValue) => a.key === axis.key && !kept.has(String(a.value))));
        if (inUse) throw conflict(`The item ${inUse.sku} uses a value being removed from ${axis.key} — delete that item first`);
      }
    }

    const attributes = checkProductAttributes(type, patch.attributes ?? current.attributes, {
      axes,
      visible: cats.visible,
      existing: current.attributes,
    });
    const settings = settingsFor(type, patch, current);

    if (patch.slug !== undefined && patch.slug !== current.slug) {
      if (!SLUG_PATTERN.test(patch.slug)) throw invalid('Slug: lowercase letters, digits and single hyphens', 'slug');
      if (await slugTaken(patch.slug, id)) throw conflict(`A product with the slug "${patch.slug}" already exists`);
    }

    const set: Record<string, unknown> = {
      product_type_id: type.id,
      type_version: type.type_version,
      category_ids: cats.ids,
      primary_category_id: cats.primary,
      attributes,
      variant_axes: axes,
      ...settings,
    };
    if (patch.name) set.name = cleanTranslated(patch.name);
    if (patch.description !== undefined) set.description = cleanTranslated(patch.description);
    if (patch.slug !== undefined) set.slug = patch.slug;
    if (patch.brand !== undefined) set.brand = patch.brand.trim();
    if (patch.hsn_code !== undefined) set.hsn_code = checkTaxCode(patch.hsn_code, 'hsn_code', 'HSN code') ?? null;
    if (patch.sac_code !== undefined) set.sac_code = checkTaxCode(patch.sac_code, 'sac_code', 'SAC code') ?? null;
    if (patch.gst_rate !== undefined) set.gst_rate = checkGst(patch.gst_rate, 'gst_rate') ?? null;
    if (patch.media !== undefined) set.media = checkMedia(patch.media, 'media');
    if (patch.option_media !== undefined) set.option_media = checkOptionMedia(patch.option_media, axes);
    if (patch.is_bundle !== undefined) set.is_bundle = patch.is_bundle;
    if (patch.purchase_limits !== undefined) {
      const limits = limitsService.validate(patch.purchase_limits) ?? null;
      /* The new product limits under every item's own override must still hold. */
      limitsService.assertEffective(limits, items);
      set.purchase_limits = limits;
    }

    try {
      await withTransaction(async (tx) => {
        if (current.track_inventory && !settings.track_inventory) {
          /* Items that follow the product stop being tracked with it. */
          await stopTracking(items.filter((i) => i.track_inventory === null).map((i) => i.id), tx, 'This product');
        }
        const before = await ProductV2Model.findOne({ id }).session(tx.session ?? null).lean<any>();
        await ProductV2Model.updateOne({ id }, { $set: set }, { session: tx.session });
        tx.undo(() => ProductV2Model.collection.replaceOne({ id }, before));
      });
    } catch (e) {
      throw duplicateKey(e);
    }
    return this.get(id);
  },

  /* --------------------------------------------------------- items */

  async addItem(productId: string, input: ItemInput) {
    const product = await liveProduct(productId);
    const currency = product.currency;
    const items = await itemsOf(productId);
    if (!product.variant_axes.length) throw conflict('This product has no variant options, so it has exactly one item — add a variant option first');
    if (items.length >= MAX_ITEMS) throw conflict(`At most ${MAX_ITEMS} items per product`);
    const prepared = prepareItem(input, 'item', { axes: product.variant_axes, product, currency, slug: product.slug });
    if (items.some((i) => i.attribute_signature === prepared.doc.attribute_signature)) {
      throw conflict('This product already has an item with that combination');
    }
    limitsService.assertEffective(product.purchase_limits, [{ sku: prepared.doc.sku, purchase_limits: prepared.doc.purchase_limits }], 'item');
    if (prepared.skuGiven) {
      if (await skuInUse([prepared.doc.sku])) throw conflict(`An item with the SKU "${prepared.doc.sku}" already exists`);
    } else {
      prepared.doc.sku = await freeSku(prepared.doc.sku, new Set());
    }
    prepared.doc.sort_order = items.length;

    try {
      await withTransaction(async (tx) => {
        await ProductItemModel.create([{ ...prepared.doc, product_id: productId }], { session: tx.session });
        tx.undo(() => ProductItemModel.collection.deleteOne({ id: prepared.doc.id }));
        if (prepared.initial_stock !== undefined) {
          const stockId = newId();
          await ItemStockModel.create([{ id: stockId, item_id: prepared.doc.id, on_hand: prepared.initial_stock }], { session: tx.session });
          tx.undo(() => ItemStockModel.collection.deleteOne({ id: stockId }));
        }
        await recomputeMinPrice(productId, tx);
      });
    } catch (e) {
      throw duplicateKey(e);
    }
    return this.get(productId);
  },

  async updateItem(productId: string, itemId: string, patch: ItemPatch) {
    const product = await liveProduct(productId);
    const item = await ProductItemModel.findOne({ id: itemId, product_id: productId }).lean<any>();
    if (!item) throw notFound('Item');

    const set: Record<string, unknown> = {};
    if (patch.sku !== undefined && patch.sku.trim() !== item.sku) {
      const sku = patch.sku.trim();
      if (!SKU_PATTERN.test(sku)) throw invalid('SKU: up to 64 letters, digits, ".", "_", "-" or "/", starting with a letter or digit', 'sku');
      if (await skuInUse([sku], [itemId])) throw conflict(`An item with the SKU "${sku}" already exists`);
      set.sku = sku;
    }
    if (patch.price !== undefined) set.price = patch.price === null ? null : checkPrice(patch.price, 'price', product.currency);
    if (patch.compare_at_minor !== undefined) {
      if (patch.compare_at_minor !== null) assertPriceMinor(patch.compare_at_minor, 'compare_at_minor');
      set.compare_at_minor = patch.compare_at_minor;
    }
    if (patch.gst_rate !== undefined) set.gst_rate = checkGst(patch.gst_rate, 'gst_rate') ?? null;
    if (patch.hsn_code !== undefined) set.hsn_code = checkTaxCode(patch.hsn_code, 'hsn_code', 'HSN code') ?? null;
    if (patch.digital_delivery !== undefined) set.digital_delivery = patch.digital_delivery;
    if (patch.media !== undefined) set.media = checkMedia(patch.media, 'media');
    if (patch.track_inventory !== undefined) set.track_inventory = patch.track_inventory;
    if (patch.purchase_limits !== undefined) {
      const limits = limitsService.validate(patch.purchase_limits) ?? null;
      limitsService.assertEffective(product.purchase_limits, [{ sku: item.sku, purchase_limits: limits }], 'item');
      set.purchase_limits = limits;
    }
    if (patch.status !== undefined && patch.status !== item.status) {
      if (patch.status === 'inactive') {
        const others = await ProductItemModel.countDocuments({ product_id: productId, status: 'active', id: { $ne: itemId } });
        if (!others) throw conflict('This is the last active item — a product needs at least one');
      }
      set.status = patch.status;
    }

    const wasTracked = effectiveTrack(item, product);
    const willTrack = patch.track_inventory !== undefined ? (patch.track_inventory ?? product.track_inventory) : wasTracked;

    try {
      await withTransaction(async (tx) => {
        if (wasTracked && !willTrack) await stopTracking([itemId], tx, `The item ${item.sku}`);
        await ProductItemModel.updateOne({ id: itemId }, { $set: set }, { session: tx.session });
        tx.undo(() => ProductItemModel.collection.replaceOne({ id: itemId }, item));
        await recomputeMinPrice(productId, tx);
      });
    } catch (e) {
      throw duplicateKey(e);
    }
    return this.get(productId);
  },

  async deleteItem(productId: string, itemId: string) {
    await liveProduct(productId);
    const item = await ProductItemModel.findOne({ id: itemId, product_id: productId }).lean<any>();
    if (!item) throw notFound('Item');
    const activeOthers = await ProductItemModel.countDocuments({ product_id: productId, status: 'active', id: { $ne: itemId } });
    if (item.status === 'active' && !activeOthers) throw conflict('This is the last active item — a product needs at least one');
    const at = new Date();
    await withTransaction(async (tx) => {
      await ProductItemModel.updateOne({ id: itemId }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
      tx.undo(() => ProductItemModel.collection.updateOne({ id: itemId }, { $set: { is_deleted: false, deleted_at: null } }));
      await ItemStockModel.updateMany({ item_id: itemId }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
      tx.undo(() => ItemStockModel.collection.updateMany({ item_id: itemId, deleted_at: at }, { $set: { is_deleted: false, deleted_at: null } }));
      await recomputeMinPrice(productId, tx);
    });
    return this.get(productId, { includeDeleted: true });
  },

  async restoreItem(productId: string, itemId: string) {
    const product = await liveProduct(productId);
    const item = await ProductItemModel.findOne({ id: itemId, product_id: productId, ...INCLUDE_DELETED }).lean<any>();
    if (!item) throw notFound('Item');
    if (!item.is_deleted) return this.get(productId);
    if (await skuInUse([item.sku], [itemId])) throw conflict(`Another live item now uses the SKU "${item.sku}"`);
    if (await ProductItemModel.exists({ product_id: productId, attribute_signature: item.attribute_signature })) {
      throw conflict('This product already has a live item with that combination');
    }
    for (const a of item.attributes as AttributeValue[]) {
      const axis = product.variant_axes.find((x: VariantAxis) => x.key === a.key);
      if (!axis || !axisValueKeys(axis).includes(String(a.value))) throw conflict(`${a.key} "${a.value}" is no longer one of this product's options`);
    }
    try {
      await withTransaction(async (tx) => {
        await ProductItemModel.updateOne({ id: itemId, is_deleted: true }, { $set: { is_deleted: false, deleted_at: null } }, { session: tx.session });
        tx.undo(() => ProductItemModel.collection.updateOne({ id: itemId }, { $set: { is_deleted: true, deleted_at: item.deleted_at } }));
        await ItemStockModel.updateMany(
          { item_id: itemId, is_deleted: true, deleted_at: item.deleted_at },
          { $set: { is_deleted: false, deleted_at: null } },
          { session: tx.session }
        );
        tx.undo(() => ItemStockModel.collection.updateMany({ item_id: itemId, deleted_at: null, is_deleted: false }, { $set: { is_deleted: true, deleted_at: item.deleted_at } }));
        await recomputeMinPrice(productId, tx);
      });
    } catch (e) {
      throw duplicateKey(e);
    }
    return this.get(productId);
  },

  /* ----------------------------------------------------- lifecycle */

  /** Drafts may be incomplete; publishing needs the required fields and an active item (§10). */
  async publish(id: string) {
    const product = await liveProduct(id);
    const type = plain(await productTypeService.requireActive());
    const cats = await categoryContext(product.category_ids, product.primary_category_id, product.category_ids);
    const problems: Record<string, string> = {};
    for (const f of missingRequired(type, product.attributes, product.variant_axes, cats.visible)) {
      problems[`attributes.${f.key}`] = `${f.label.en} is required`;
    }
    if (!(await ProductItemModel.countDocuments({ product_id: id, status: 'active' }))) problems.items = 'At least one active item is required';
    const reasons = Object.values(problems);
    if (reasons.length) throw new AppError(`Cannot publish yet: ${reasons.join('; ')}`, 422, undefined, problems);
    await ProductV2Model.updateOne({ id }, { $set: { status: 'active' } });
    return this.get(id);
  },

  async archive(id: string) {
    await liveProduct(id);
    await ProductV2Model.updateOne({ id }, { $set: { status: 'archived' } });
    return this.get(id);
  },

  /** Soft delete with its items and stock rows, all stamped with the same moment, so restore brings back exactly those. */
  async remove(id: string) {
    await liveProduct(id);
    const at = new Date();
    const itemIds = (await itemsOf(id)).map((i) => i.id);
    await withTransaction(async (tx) => {
      await ItemStockModel.updateMany({ item_id: { $in: itemIds } }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
      tx.undo(() => ItemStockModel.collection.updateMany({ item_id: { $in: itemIds }, deleted_at: at }, { $set: { is_deleted: false, deleted_at: null } }));
      await ProductItemModel.updateMany({ product_id: id }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
      tx.undo(() => ProductItemModel.collection.updateMany({ product_id: id, deleted_at: at }, { $set: { is_deleted: false, deleted_at: null } }));
      await ProductV2Model.updateOne({ id }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
      tx.undo(() => ProductV2Model.collection.updateOne({ id }, { $set: { is_deleted: false, deleted_at: null } }));
    });
    return { id };
  },

  async restore(id: string) {
    const product = await ProductV2Model.findOne({ id, ...INCLUDE_DELETED }).lean<any>();
    if (!product) throw notFound();
    if (!product.is_deleted) return this.get(id);
    const at = product.deleted_at;
    if (await slugTaken(product.slug, id)) throw conflict(`Another live product now uses the slug "${product.slug}"`);
    const items = await ProductItemModel.find({ product_id: id, is_deleted: true, deleted_at: at }).lean<any[]>();
    const taken = await skuInUse(items.map((i) => i.sku), items.map((i) => i.id));
    if (taken) throw conflict(`Another live item now uses the SKU "${taken}"`);
    const itemIds = items.map((i) => i.id);
    try {
      await withTransaction(async (tx) => {
        await ProductV2Model.updateOne({ id, is_deleted: true }, { $set: { is_deleted: false, deleted_at: null } }, { session: tx.session });
        tx.undo(() => ProductV2Model.collection.updateOne({ id }, { $set: { is_deleted: true, deleted_at: at } }));
        await ProductItemModel.updateMany({ id: { $in: itemIds }, is_deleted: true }, { $set: { is_deleted: false, deleted_at: null } }, { session: tx.session });
        tx.undo(() => ProductItemModel.collection.updateMany({ id: { $in: itemIds } }, { $set: { is_deleted: true, deleted_at: at } }));
        await ItemStockModel.updateMany(
          { item_id: { $in: itemIds }, is_deleted: true, deleted_at: at },
          { $set: { is_deleted: false, deleted_at: null } },
          { session: tx.session }
        );
        tx.undo(() => ItemStockModel.collection.updateMany({ item_id: { $in: itemIds }, is_deleted: false, deleted_at: null }, { $set: { is_deleted: true, deleted_at: at } }));
      });
    } catch (e) {
      throw duplicateKey(e);
    }
    return this.get(id);
  },

  /* ------------------------------------------------------- preview */

  async variantPreview(input: { variant_axes: VariantAxis[]; slug?: string; name?: string; product_id?: string }) {
    const type = plain(await productTypeService.requireActive());
    let existing: VariantAxis[] = [];
    let signatures = new Set<string>();
    let slug = input.slug || slugify(input.name ?? 'item');
    if (input.product_id) {
      const product = await liveProduct(input.product_id);
      existing = product.variant_axes;
      slug = product.slug;
      signatures = new Set((await itemsOf(input.product_id)).map((i) => i.attribute_signature));
    }
    const axes = checkVariantAxes(type, input.variant_axes, existing);
    const combinations = variantService.preview(axes, slug, signatures);
    return { total: combinations.length, new: combinations.filter((c) => !c.exists).length, combinations };
  },
};
