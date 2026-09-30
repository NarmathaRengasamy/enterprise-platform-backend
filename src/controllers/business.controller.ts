import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { templatesService } from '../services/templates.service.js';
import { tenantSettingsService } from '../services/tenantSettings.service.js';
import { productTypeService, toResponse } from '../services/productType.service.js';
import { catalogCategoryService } from '../services/catalogCategory.service.js';
import { FIELD_TYPES, LANGUAGES } from '../types/productType.types.js';
import { ok } from '../utils/response.util.js';
import { toAppError } from '../utils/error.util.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Business');

/**
 * Phase 1 — Business Category & Product Type (design §9.1).
 *
 *   GET  /business-templates            any signed-in user
 *   GET  /settings/business             any signed-in user
 *   PUT  /settings/business             Admin
 *   GET  /product-type                  any signed-in user
 *   POST /product-type/fields           Admin
 *   PATCH /product-type/fields/:key     Admin
 *   DELETE /product-type/fields/:key    Admin (unused custom fields only)
 *   POST /product-type/fields/reorder   Admin
 *   POST /product-type/upgrade          Admin
 */

/* ----------------------------------------------------------- schemas */

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const CURRENCIES = new Set((Intl as any).supportedValuesOf?.('currency') ?? ['INR', 'USD', 'EUR', 'GBP']);

const translated = z.object({
  en: z.string().trim().min(1, 'A name is required').max(120),
  ta: z.string().trim().max(120).optional(),
  hi: z.string().trim().max(120).optional(),
});

const optionInput = z.union([
  z.string().trim().min(1).max(120).transform((en) => ({ label: { en } })),
  z.object({
    value: z.string().trim().max(60).optional(),
    label: translated,
    deprecated: z.boolean().optional(),
  }),
]);

export const updateBusinessSchema = z.object({
  body: z.object({
    business_category: z.string().trim().min(1, 'Choose a business category'),
    timezone: z.string().trim().refine(isTimeZone, 'Not a valid time zone (e.g. Asia/Kolkata)').optional(),
    default_currency: z
      .string()
      .trim()
      .toUpperCase()
      .refine((c) => CURRENCIES.has(c), 'Not a valid ISO 4217 currency code (e.g. INR)')
      .optional(),
    languages: z
      .array(z.enum(LANGUAGES))
      .min(1)
      .refine((l) => l.includes('en'), 'English (en) is always required')
      .refine((l) => new Set(l).size === l.length, 'Each language only once')
      .optional(),
    /* Creates the template's starter categories (flattened in flat mode). */
    create_starter_categories: z.boolean().optional(),
    /* Flat by default; "tree" switches the category tree on (R11, R11a). */
    category_mode: z.enum(['flat', 'tree']).optional(),
  }),
});

export const addFieldSchema = z.object({
  body: z.object({
    label: translated,
    key: z.string().trim().max(60).optional(),
    type: z.enum(FIELD_TYPES),
    unit: z.string().trim().max(20).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z.array(optionInput).max(500).optional(),
    variant_forming: z.boolean().optional(),
    filterable: z.boolean().optional(),
    required: z.boolean().optional(),
    group: z.string().trim().max(60).optional(),
  }),
});

export const updateFieldSchema = z.object({
  body: z.object({
    /* Declared so an attempt to change them can be refused clearly, rather
       than silently stripped. */
    key: z.string().optional(),
    type: z.enum(FIELD_TYPES).optional(),
    label: translated.optional(),
    unit: z.string().trim().max(20).nullable().optional(),
    min: z.number().finite().nullable().optional(),
    max: z.number().finite().nullable().optional(),
    options: z.array(optionInput).max(500).optional(),
    variant_forming: z.boolean().optional(),
    filterable: z.boolean().optional(),
    required: z.boolean().optional(),
    group: z.string().trim().max(60).nullable().optional(),
    sort_order: z.number().int().min(0).optional(),
    deprecated: z.boolean().optional(),
  }),
});

export const addOptionsSchema = z.object({
  body: z.object({
    options: z.array(optionInput).min(1, 'Send at least one option').max(100),
    /* Set after the user has seen a near-duplicate warning and still wants it. */
    confirm: z.boolean().optional(),
  }),
});

export const reorderFieldsSchema = z.object({
  body: z.object({ keys: z.array(z.string().min(1)).min(1) }),
});

/* ------------------------------------------------------------ helpers */

const businessView = (doc: any) => {
  const j = doc.toJSON();
  return {
    business_category: j.business_category ?? null,
    category_mode: j.category_mode ?? 'flat',
    active_product_type_id: j.active_product_type_id ?? null,
    timezone: j.timezone,
    default_currency: j.default_currency,
    languages: j.languages,
  };
};

const templateView = (t: ReturnType<typeof templatesService.list>[number]) => ({
  code: t.code,
  version: t.version,
  name: t.name,
  default_fulfilment: t.default_fulfilment,
  default_tracking: t.default_tracking,
  field_count: t.fields.length,
  fields: t.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.unit ? { unit: f.unit } : {}),
    variant_forming: Boolean(f.variant_forming),
  })),
  starter_category_count: t.starter_categories.length,
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

/* ---------------------------------------------------------- handlers */

export const listBusinessTemplates = handle('Could not list business templates', async (_req, res) => {
  res.json(ok(templatesService.list().map(templateView)));
});

export const getBusinessSettings = handle('Could not read the business settings', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(businessView(await tenantSettingsService.get())));
});

export const updateBusinessSettings = handle('Could not save the business settings', async (req, res) => {
  /* Check the mode switch before saving anything, so a refused switch
     (tree → flat with sub-categories) leaves every setting unchanged. */
  if (req.body.category_mode) await catalogCategoryService.assertCanSetMode(req.body.category_mode);

  let { settings, product_type, outcome, notice } = await productTypeService.setBusinessCategory(req.body);
  if (req.body.category_mode && req.body.category_mode !== settings.category_mode) {
    await catalogCategoryService.setCategoryMode(req.body.category_mode);
    settings = await tenantSettingsService.get();
  }

  /* Phase 2: the "Create starter categories" option. Codes that already exist
     are skipped, so saving again never duplicates them. */
  let starter_categories: { created: string[]; skipped: string[] } | undefined;
  if (req.body.create_starter_categories) {
    const template = templatesService.get(req.body.business_category);
    if (template) starter_categories = await catalogCategoryService.createStarterCategories(template);
  }

  res.json(
    ok(
      {
        settings: businessView(settings),
        product_type: toResponse(product_type),
        outcome,
        ...(notice ? { notice } : {}),
        ...(starter_categories ? { starter_categories } : {}),
      },
      notice ?? 'Business settings saved'
    )
  );
});

export const getProductType = handle('Could not read the product type', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  /* No category chosen yet is a normal state, not an error. */
  res.json(ok(toResponse(await productTypeService.getActive())));
});

export const addField = handle('Could not add the attribute', async (req, res) => {
  const { product_type, notice } = await productTypeService.addField(req.body);
  res.status(201).json(ok({ product_type: toResponse(product_type), ...(notice ? { notice } : {}) }, notice ?? 'Attribute added'));
});

export const updateField = handle('Could not update the attribute', async (req, res) => {
  const { product_type, notice } = await productTypeService.updateField(req.params.key, req.body);
  res.json(ok({ product_type: toResponse(product_type), ...(notice ? { notice } : {}) }, notice ?? 'Attribute updated'));
});

export const addOptions = handle('Could not add the options', async (req, res) => {
  const { product_type, added, existing, warnings } = await productTypeService.addOptions(
    req.params.key,
    req.body.options,
    Boolean(req.body.confirm)
  );
  const message = warnings.length
    ? `Check ${warnings.map((w) => `"${w.label}" (looks like "${w.similar_to}")`).join(', ')} — send again with confirm to add anyway`
    : added.length
      ? `${added.length} option(s) added`
      : 'Those options already exist';
  res.json(ok({ product_type: toResponse(product_type), added, existing, warnings }, message));
});

export const deleteField = handle('Could not delete the attribute', async (req, res) => {
  const { product_type } = await productTypeService.deleteField(req.params.key);
  res.json(ok({ product_type: toResponse(product_type) }, 'Attribute deleted'));
});

export const reorderFields = handle('Could not reorder the attributes', async (req, res) => {
  const { product_type } = await productTypeService.reorderFields(req.body.keys);
  res.json(ok({ product_type: toResponse(product_type) }, 'Order saved'));
});

export const upgradeTemplate = handle('Could not upgrade the template', async (_req, res) => {
  const { product_type, outcome, added } = await productTypeService.upgradeTemplate();
  res.json(
    ok(
      { product_type: toResponse(product_type), outcome, added },
      outcome === 'up_to_date' ? 'Already on the latest template' : `Template updated — ${added.length} addition(s)`
    )
  );
});
