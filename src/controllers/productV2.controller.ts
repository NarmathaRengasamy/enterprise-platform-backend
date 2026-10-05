import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { productV2Service } from '../services/productV2.service.js';
import { productSearchService, SORTS, MAX_LIMIT } from '../services/productSearch.service.js';
import { productStatsService } from '../services/productStats.service.js';
import { productExportService } from '../services/productExport.service.js';
import { PRICE_UNITS, DIGITAL_DELIVERIES } from '../models/ProductItem.model.js';
import { FULFILMENTS, TRACKINGS } from '../types/productType.types.js';
import { ok } from '../utils/response.util.js';
import { toAppError } from '../utils/error.util.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ProductV2Controller');

/**
 * Phase 3 — products and items (design §9.3), at /api/v2/products beside the
 * old /api/v1/products until the Phase 5 cut-over.
 *
 *   POST   /search                              any signed-in user (Viewer: active only)
 *   GET    /stats                               any signed-in user (Viewer: active only)
 *   POST   /export                              Admin, Editor (the list's filters → CSV)
 *   POST   /variant-preview                     Admin, Editor
 *   GET    /:id                                 any signed-in user (Viewer: active only)
 *   POST   /                                    Admin, Editor
 *   PATCH  /:id                                 Admin, Editor
 *   POST   /:id/publish · /:id/archive          Admin, Editor
 *   DELETE /:id · POST /:id/restore             Admin
 *   POST   /:id/items                           Admin, Editor
 *   PATCH  /:id/items/:item_id                  Admin, Editor
 *   DELETE /:id/items/:item_id · …/restore      Admin
 *
 * Money is sent in paise (`amount_minor`); the service refuses a decimal or a
 * negative amount with 422.
 */

const translated = z.object({
  en: z.string().trim().min(1, 'A name is required').max(200),
  ta: z.string().trim().max(200).optional(),
  hi: z.string().trim().max(200).optional(),
});

/* A measured size (R45): an amount with a unit, e.g. { amount: 500, unit: "ml" }.
   The unit's family and the amount are checked by the service (422). */
const measured = z.object({ amount: z.number(), unit: z.string().trim().min(1).max(10).optional() });

const attributeValue = z.object({
  key: z.string().trim().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), measured, z.record(z.string(), z.string())]),
});

const axis = z.object({ key: z.string().trim().min(1), values: z.array(z.union([z.string().trim().min(1), measured])).max(200) });

/* R50: every value optional; whole numbers ≥ 1 and their order are checked by
   the limits service (422 with field errors). On PATCH the object replaces the
   stored one; null clears it. */
const limitValue = z.number().nullable().optional();
const purchaseLimits = z.object({
  min_per_order: limitValue,
  max_per_order: limitValue,
  per_customer: z
    .object({ day: limitValue, week: limitValue, month: limitValue, year: limitValue, lifetime: limitValue })
    .nullable()
    .optional(),
});

const media = z.object({
  url: z.string().trim().min(1).max(2000),
  kind: z.enum(['image', 'video']).optional(),
  alt: z.string().max(200).optional(),
  sort_order: z.number().int().optional(),
});

const price = z.object({
  /* A number here; whole-paise and ≥ 0 are business rules (422 from the service). */
  amount_minor: z.number(),
  currency: z.string().trim().length(3).optional(),
  tax_inclusive: z.boolean().optional(),
  price_unit: z.enum(PRICE_UNITS).optional(),
});

const itemFields = {
  sku: z.string().trim().max(64).optional(),
  price: price.nullable().optional(),
  compare_at_minor: z.number().nullable().optional(),
  gst_rate: z.number().nullable().optional(),
  hsn_code: z.string().trim().max(8).nullable().optional(),
  track_inventory: z.boolean().nullable().optional(),
  digital_delivery: z.enum(DIGITAL_DELIVERIES).nullable().optional(),
  media: z.array(media).max(50).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  purchase_limits: purchaseLimits.nullable().optional(),
};

/* A pack (R47): quantity × a base item of the same product — by SKU on create, by id or SKU when adding. */
const packOf = z.object({
  base_item_id: z.string().trim().min(1).optional(),
  base_sku: z.string().trim().min(1).max(64).optional(),
  /* A number here; whole and ≥ 2 is a business rule (422 from the service). */
  quantity: z.number(),
});

const itemInput = z.object({
  ...itemFields,
  attributes: z.array(attributeValue).max(20).optional(),
  initial_stock: z.number().optional(),
  pack_of: packOf.optional(),
});

/* Stock only ever changes through the stock endpoints (Phase 4). */
const noStock = {
  initial_stock: z.undefined({ invalid_type_error: 'Stock is not changed here — use the stock adjustment (Phase 4)' }).optional(),
  on_hand: z.undefined({ invalid_type_error: 'Stock is not changed here — use the stock adjustment (Phase 4)' }).optional(),
  stock: z.undefined({ invalid_type_error: 'Stock is not changed here — use the stock adjustment (Phase 4)' }).optional(),
};

const productFields = {
  name: translated,
  description: translated.optional(),
  slug: z.string().trim().min(1).max(120).optional(),
  brand: z.string().trim().max(120).optional(),
  category_ids: z.array(z.string().trim().min(1)).max(20).optional(),
  primary_category_id: z.string().trim().min(1).nullable().optional(),
  attributes: z.array(attributeValue).max(200).optional(),
  variant_axes: z.array(axis).max(10).optional(),
  track_inventory: z.boolean().optional(),
  tracking: z.enum(TRACKINGS).nullable().optional(),
  fulfilment: z.enum(FULFILMENTS).nullable().optional(),
  hsn_code: z.string().trim().max(8).nullable().optional(),
  sac_code: z.string().trim().max(8).nullable().optional(),
  gst_rate: z.number().nullable().optional(),
  media: z.array(media).max(50).optional(),
  option_media: z
    .array(z.object({ attribute_key: z.string().trim().min(1), value: z.string().trim().min(1), media: z.array(media).max(20) }))
    .max(200)
    .optional(),
  is_bundle: z.boolean().optional(),
  purchase_limits: purchaseLimits.nullable().optional(),
};

export const createProductSchema = z.object({
  body: z.object({ ...productFields, items: z.array(itemInput).max(500).optional() }),
});

export const updateProductSchema = z.object({
  body: z.object({
    ...productFields,
    name: translated.optional(),
    /* Declared so a body that tries is refused (400) rather than silently stripped. */
    items: z.undefined({ invalid_type_error: 'Items are changed through /v2/products/:id/items' }).optional(),
    ...noStock,
  }),
});

export const addItemSchema = z.object({ body: itemInput });

export const updateItemSchema = z.object({
  body: z.object({
    ...itemFields,
    attributes: z.undefined({ invalid_type_error: "An item's combination cannot change — add a new item instead" }).optional(),
    pack_of: z.undefined({ invalid_type_error: 'What a pack holds cannot change — add a new pack instead' }).optional(),
    ...noStock,
  }),
});

export const variantPreviewSchema = z.object({
  body: z.object({
    variant_axes: z.array(axis).min(1).max(10),
    slug: z.string().trim().max(120).optional(),
    name: z.string().trim().max(200).optional(),
    product_id: z.string().trim().min(1).optional(),
  }),
});

export const searchSchema = z.object({
  body: z.object({
    search: z.string().trim().max(200).optional(),
    category_id: z.string().trim().min(1).optional(),
    /* "deleted" = only deleted products (Admin / Editor; a Viewer always gets active ones). */
    status: z.enum(['draft', 'active', 'archived', 'all', 'deleted']).optional(),
    brand: z.string().trim().max(120).optional(),
    price_min_minor: z.number().int().nonnegative().optional(),
    price_max_minor: z.number().int().nonnegative().optional(),
    attributes: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()])).max(50)).optional(),
    /* Size range (R46) on a measured-size attribute, in its family's base unit (g · ml · cm · piece). */
    measure_key: z.string().trim().min(1).optional(),
    measure_min: z.number().nonnegative().optional(),
    measure_max: z.number().nonnegative().optional(),
    include_deleted: z.boolean().optional(),
    sort: z.enum(SORTS).optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  }),
});

const handle =
  (message: string, fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(toAppError(error, message, log));
    }
  };

const isViewer = (req: Request) => ((req as any).user?.role ?? 'Viewer') === 'Viewer';

/** The products list KPIs: the whole catalogue (a Viewer: active products only). */
export const productStats = handle('Could not load the product figures', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(await productStatsService.stats({ viewer: isViewer(req) })));
});

/** What the list matches (its filters, every page) as CSV, one row per variant. Admin / Editor. */
export const exportProducts = handle('Could not export the products', async (req, res) => {
  const csv = await productExportService.csv(req.body);
  res.set('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`);
  /* BOM so Excel reads Tamil / Hindi names as UTF-8. */
  res.status(200).send(`\uFEFF${csv}`);
});

export const searchProducts = handle('Could not search the products', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(await productSearchService.search(req.body, { viewer: isViewer(req) })));
});

export const variantPreview = handle('Could not preview the variants', async (req, res) => {
  res.json(ok(await productV2Service.variantPreview(req.body)));
});

export const getProduct = handle('Could not load the product', async (req, res) => {
  const viewer = isViewer(req);
  res.set('Cache-Control', 'no-store');
  res.json(
    ok(
      await productV2Service.get(req.params.id, {
        includeDeleted: !viewer && String(req.query.include_deleted) === 'true',
        activeOnly: viewer,
      })
    )
  );
});

export const createProduct = handle('Could not create the product', async (req, res) => {
  res.status(201).json(ok(await productV2Service.create(req.body), 'Product saved as a draft'));
});

export const updateProduct = handle('Could not update the product', async (req, res) => {
  res.json(ok(await productV2Service.update(req.params.id, req.body), 'Product updated'));
});

export const publishProduct = handle('Could not publish the product', async (req, res) => {
  res.json(ok(await productV2Service.publish(req.params.id), 'Product published'));
});

export const archiveProduct = handle('Could not archive the product', async (req, res) => {
  res.json(ok(await productV2Service.archive(req.params.id), 'Product archived'));
});

export const deleteProduct = handle('Could not delete the product', async (req, res) => {
  res.json(ok(await productV2Service.remove(req.params.id), 'Product deleted — it can be restored'));
});

export const restoreProduct = handle('Could not restore the product', async (req, res) => {
  res.json(ok(await productV2Service.restore(req.params.id), 'Product restored'));
});

export const addItem = handle('Could not add the item', async (req, res) => {
  res.status(201).json(ok(await productV2Service.addItem(req.params.id, req.body), 'Item added'));
});

export const updateItem = handle('Could not update the item', async (req, res) => {
  res.json(ok(await productV2Service.updateItem(req.params.id, req.params.item_id, req.body), 'Item updated'));
});

export const deleteItem = handle('Could not delete the item', async (req, res) => {
  res.json(ok(await productV2Service.deleteItem(req.params.id, req.params.item_id), 'Item deleted — it can be restored'));
});

export const restoreItem = handle('Could not restore the item', async (req, res) => {
  res.json(ok(await productV2Service.restoreItem(req.params.id, req.params.item_id), 'Item restored'));
});
