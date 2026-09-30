import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { catalogCategoryService } from '../services/catalogCategory.service.js';
import { ok } from '../utils/response.util.js';
import { toAppError } from '../utils/error.util.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CatalogCategoryController');

/**
 * Phase 2 — the category tree (design §9.2), under /catalog-categories while
 * the old flat /categories still serves the current product screens.
 *
 *   GET    /catalog-categories?tree=true&include_deleted=   any signed-in user
 *   GET    /catalog-categories/export?search=&status=&include_deleted=  Admin, Editor (CSV)
 *   GET    /catalog-categories/:id                          any signed-in user
 *   POST   /catalog-categories                              Admin, Editor
 *   PATCH  /catalog-categories/:id                          Admin, Editor
 *   POST   /catalog-categories/reorder                      Admin, Editor
 *   DELETE /catalog-categories/:id                          Admin (soft)
 *   POST   /catalog-categories/:id/restore                  Admin
 */

const translated = z.object({
  en: z.string().trim().min(1, 'A name is required').max(120),
  ta: z.string().trim().max(120).optional(),
  hi: z.string().trim().max(120).optional(),
});

/* No fulfilment / tracking (R13): undeclared keys are stripped by
   validateRequest, so a client that still sends them stores nothing. */
const common = {
  name: translated,
  description: translated.optional(),
  parent_id: z.string().trim().min(1).nullable().optional(),
  visible_field_keys: z.array(z.string().trim().min(1)).max(200).optional(),
  icon: z.string().trim().max(60).optional(),
  color: z.string().trim().max(30).optional(),
  status: z.enum(['active', 'hidden']).optional(),
};

export const createCategorySchema = z.object({
  body: z.object({ code: z.string().trim().min(1, 'A code is required').max(60), ...common }),
});

export const updateCategorySchema = z.object({
  body: z.object({
    /* Declared so a change can be refused clearly rather than silently dropped. */
    code: z.string().trim().optional(),
    ...common,
    name: translated.optional(),
  }),
});

export const exportSchema = z.object({
  query: z.object({
    search: z.string().trim().max(120).optional(),
    status: z.enum(['all', 'active', 'hidden']).optional(),
    include_deleted: z.enum(['true', 'false']).optional(),
  }),
});

export const reorderSchema = z.object({
  body: z.object({
    parent_id: z.string().trim().min(1).nullable().optional(),
    ids: z.array(z.string().min(1)).min(1),
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

export const listCategories = handle('Could not load the categories', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(await catalogCategoryService.list(String(req.query.include_deleted) === 'true')));
});

export const exportCategories = handle('Could not export the categories', async (req, res) => {
  const { search, status, include_deleted } = req.query as Record<string, string | undefined>;
  const { csv } = await catalogCategoryService.exportCsv({
    search,
    status: status as 'all' | 'active' | 'hidden' | undefined,
    includeDeleted: include_deleted === 'true',
  });
  res.set('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="categories.csv"');
  /* BOM so Excel reads the Tamil / Hindi names as UTF-8. */
  res.status(200).send(`\uFEFF${csv}`);
});

export const getCategory = handle('Could not load the category', async (req, res) => {
  res.json(ok(await catalogCategoryService.get(req.params.id)));
});

export const createCategory = handle('Could not create the category', async (req, res) => {
  res.status(201).json(ok(await catalogCategoryService.create(req.body), 'Category created'));
});

export const updateCategory = handle('Could not update the category', async (req, res) => {
  res.json(ok(await catalogCategoryService.update(req.params.id, req.body), 'Category updated'));
});

export const reorderCategories = handle('Could not reorder the categories', async (req, res) => {
  res.json(ok(await catalogCategoryService.reorder(req.body.parent_id ?? null, req.body.ids), 'Order saved'));
});

export const deleteCategory = handle('Could not delete the category', async (req, res) => {
  res.json(ok(await catalogCategoryService.remove(req.params.id), 'Category deleted — it can be restored'));
});

export const restoreCategory = handle('Could not restore the category', async (req, res) => {
  res.json(ok(await catalogCategoryService.restore(req.params.id), 'Category restored'));
});
