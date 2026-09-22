import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { Category } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { generateId, getPageParams, ok, paginated } from '../utils/response.util.js';

const log = createLogger('CategoryController');

export const createCategorySchema = z.object({
  body: z.object({
    id: z.string().optional(),
    name: z.string().min(1, 'Category name is required'),
    description: z.string().optional().default('General category item'),
    icon: z.string().optional().default('category'),
    color: z.string().optional().default('primary'),
  }),
});

export const updateCategorySchema = z.object({
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  }),
});

export const bulkDeleteSchema = z.object({
  body: z.object({
    ids: z.array(z.string()).min(1, 'ids must not be empty'),
  }),
});

/**
 * categoryId -> product count, computed from the products themselves.
 *
 * The stored `productsCount` was seeded at 25/18/18/14 against 8 real products
 * and drifted from there; it drives three of the four metric cards, so it is
 * recomputed on every read rather than trusted.
 */
const liveProductCounts = async (): Promise<Map<string, number>> => {
  const products = await store.getProducts();
  const counts = new Map<string, number>();
  for (const product of products) {
    const key = product.categoryId || product.category;
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const withLiveCount = (category: Category, counts: Map<string, number>): Category => ({
  ...category,
  productsCount: counts.get(category.id) ?? counts.get(category.name) ?? 0,
});

export const getCategories = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { page, limit, skip } = getPageParams(req);
    const { search, hasProducts, sortBy, sortOrder } = req.query;

    const counts = await liveProductCounts();
    let rows = (await store.getCategories(search as string)).map((c) => withLiveCount(c, counts));

    if (hasProducts === 'true') rows = rows.filter((c) => c.productsCount > 0);
    if (hasProducts === 'false') rows = rows.filter((c) => c.productsCount === 0);

    if (sortBy === 'name' || sortBy === 'productsCount') {
      const direction = sortOrder === 'asc' ? 1 : -1;
      rows = [...rows].sort((a: any, b: any) =>
        a[sortBy as string] > b[sortBy as string] ? direction : -direction
      );
    }

    res.status(200).json(paginated(rows.slice(skip, skip + limit), rows.length, page, limit));
  } catch (error) {
    next(toAppError(error, 'Could not load categories', log));
  }
};

export const getCategoryStats = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [categories, counts] = await Promise.all([store.getCategories(), liveProductCounts()]);
    const assignedSkus = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

    res.status(200).json(
      ok({
        totalCategories: categories.length,
        assignedSkus,
        topDistribution: top
          ? {
              name: categories.find((c) => c.id === top[0])?.name ?? top[0],
              percentage: assignedSkus ? Math.round((top[1] / assignedSkus) * 1000) / 10 : 0,
            }
          : null,
        averagePerCategory: categories.length
          ? Math.round((assignedSkus / categories.length) * 100) / 100
          : 0,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not compute category statistics', log));
  }
};

export const getCategoryById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const category = await store.getCategoryById(req.params.id);
    if (!category) throw new AppError('Category not found', 404);
    const counts = await liveProductCounts();
    res.status(200).json(ok(withLiveCount(category, counts)));
  } catch (error) {
    next(toAppError(error, `Could not load category ${req.params.id}`, log));
  }
};

export const createCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    /* Products reference this id, so it must be stable and unique for the life
       of the category. `CAT-${count + 1}` was neither — deleting a category made
       the next create reuse a retired code and silently re-point products. */
    const id = String(req.body.id ?? '').trim() || generateId('cat');

    const clash = await store.getCategoryById(id);
    if (clash) throw new AppError('A category with this code already exists', 409);

    const newCategory: Category = {
      id,
      name: req.body.name,
      description: req.body.description,
      icon: req.body.icon,
      color: req.body.color,
      productsCount: 0,
      updated: 'Just now',
    };

    const created = await store.createCategory(newCategory);
    log.log(`Created category ${created.id} (${created.name})`);
    res.status(201).json(ok(created, 'Category created successfully'));
  } catch (error) {
    next(toAppError(error, 'Could not create the category', log));
  }
};

export const updateCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await store.getCategoryById(id);
    if (!existing) throw new AppError('Category not found', 404);

    const updated = await store.updateCategory(id, { ...req.body, updated: 'Just now' });

    /* Products carry a denormalised copy of the name for display, so a rename
       has to be pushed out or the two views disagree. */
    if (req.body.name && req.body.name !== existing.name) {
      const touched = await store.renameProductCategory(id, req.body.name);
      if (touched) log.log(`Category ${id} renamed — updated ${touched} product(s)`);
    }

    log.log(`Updated category ${id}`, { fields: Object.keys(req.body) });
    res.status(200).json(ok(updated, 'Category updated successfully'));
  } catch (error) {
    next(toAppError(error, `Could not update category ${req.params.id}`, log));
  }
};

/** Refuses to orphan products — the UI offers no reassignment step. */
const removeOne = async (id: string): Promise<void> => {
  const category = await store.getCategoryById(id);
  if (!category) throw new AppError('Category not found', 404);

  const counts = await liveProductCounts();
  const assigned = counts.get(category.id) ?? counts.get(category.name) ?? 0;
  if (assigned > 0) {
    throw new AppError(
      `${assigned} product${assigned === 1 ? ' is' : 's are'} still assigned to this category`,
      409
    );
  }

  await store.deleteCategory(id);
};

export const deleteCategory = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await removeOne(req.params.id);
    log.log(`Deleted category ${req.params.id}`);
    res.status(200).json(ok({ id: req.params.id }, 'Category deleted successfully'));
  } catch (error) {
    next(toAppError(error, `Could not delete category ${req.params.id}`, log));
  }
};

/** Deletes what it can and reports the rest, rather than failing the batch. */
export const bulkDeleteCategories = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = { deleted: 0, skipped: 0, notFound: 0, conflicts: [] as any[] };

    for (const id of req.body.ids as string[]) {
      try {
        await removeOne(id);
        result.deleted += 1;
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) result.notFound += 1;
        else if (error instanceof AppError && error.statusCode === 409) {
          result.skipped += 1;
          result.conflicts.push({ id, reason: error.message });
        } else throw error;
      }
    }

    log.log(`Bulk delete: ${result.deleted} removed, ${result.skipped} skipped`);
    res.status(200).json(ok(result, 'Bulk delete completed'));
  } catch (error) {
    next(toAppError(error, 'Could not complete the bulk delete', log));
  }
};

export const exportCategories = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const counts = await liveProductCounts();
    const rows = (await store.getCategories()).map((c) => withLiveCount(c, counts));

    const header = 'ID,Name,Description,Products';
    const body = rows
      .map((c) =>
        [c.id, c.name, c.description, c.productsCount]
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="omniflow_categories.csv"');
    res.status(200).send(`${header}\n${body}`);
  } catch (error) {
    next(toAppError(error, 'Could not export categories', log));
  }
};
