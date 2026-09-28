import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../middlewares/errorHandler.js';
import { toAppError } from '../../utils/error.util.js';
import { createLogger } from '../../utils/logger.js';
import { ok } from '../../utils/response.util.js';
import { CatalogCategoryModel, CatalogProductModel, ProductTypeModel } from '../models.js';
import { newId, restoreOne, softDeleteOne } from '../softDelete.js';
import {
  ancestorChain,
  assertNoCycle,
  buildTree,
  descendantIds,
  loadAllCategories,
  resolveCommerce,
  resolveTypeId,
} from '../services/categoryTree.js';

const log = createLogger('V2CategoryController');

const PRICING = ['fixed', 'per_unit', 'per_time', 'per_variant', 'tiered', 'on_request', 'free'] as const;
const AVAILABILITY = ['quantity', 'time_slot', 'capacity_per_date', 'unlimited', 'lead_time', 'none'] as const;

const commerceSchema = z.object({
  pricing: z.object({
    model: z.enum(PRICING),
    label: z.string().optional(),
    unit: z.string().optional(),
    currency: z.string().optional().default('INR'),
  }),
  availability: z.object({
    model: z.enum(AVAILABILITY),
    label: z.string().optional(),
    slotMinutes: z.number().int().positive().optional(),
    openingHours: z.record(z.string()).optional(),
    requiresIncharge: z.boolean().optional(),
  }),
});

export const createCategorySchema = z.object({
  body: z.object({
    /* Server-minted UUID only — see the type controller for why. */
    name: z.string().min(1, 'Category name is required'),
    description: z.string().optional().default(''),
    parentId: z.string().nullable().optional(),
    typeId: z.string().optional(),
    commerce: commerceSchema.optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  }),
});

export const updateCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    parentId: z.string().nullable().optional(),
    typeId: z.string().optional(),
    commerce: commerceSchema.optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  }),
});

/** A slot-based category with no slot length produces zero bookable slots. */
const assertCommerceCoherent = (commerce?: z.infer<typeof commerceSchema>): void => {
  if (!commerce) return;
  const { availability, pricing } = commerce;

  if (availability.model === 'time_slot' && !availability.slotMinutes) {
    throw new AppError('A time_slot category needs slotMinutes', 422);
  }
  if (pricing.model === 'per_time' && !pricing.unit) {
    throw new AppError('A per_time category needs a unit, e.g. "hour" or "night"', 422);
  }
  if (pricing.model === 'per_unit' && !pricing.unit) {
    throw new AppError('A per_unit category needs a unit, e.g. "kg" or "seat"', 422);
  }
};

export const listCategories = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const seeDeleted = String(req.query.includeDeleted) === 'true';

    /* Deleted rows are opt-in, so a restore screen can find them without any
       ordinary listing ever showing a tombstone by accident. */
    const all = seeDeleted
      ? ((await CatalogCategoryModel.find().setOptions({ withDeleted: true }).lean()) as any[])
      : await loadAllCategories();

    /* Flat by default; `?tree=true` for a picker, which needs the nesting and
       would otherwise rebuild it client-side in every consumer. */
    if (String(req.query.tree) === 'true') {
      res.json(ok(buildTree(all)));
      return;
    }

    const counts = await CatalogProductModel.aggregate([
      { $unwind: '$categoryIds' },
      { $group: { _id: '$categoryIds', count: { $sum: 1 } } },
    ]);
    const countBy = new Map<string, number>(counts.map((c: any) => [c._id, c.count]));

    const rows = all.map((c) => ({
      ...c,
      productsCount: countBy.get(c.id) ?? 0,
      /* The effective config, not just the declared one — a child that inherits
         its parent's commerce should not render as unconfigured. */
      effectiveCommerce: resolveCommerce([c.id], all),
      effectiveTypeId: resolveTypeId([c.id], all) ?? null,
      depth: ancestorChain(c.id, all).length - 1,
    }));

    res.json(ok(rows.sort((a, b) => a.name.localeCompare(b.name))));
  } catch (error) {
    next(toAppError(error, 'Could not list categories', log));
  }
};

export const getCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const all = await loadAllCategories();
    const category = all.find((c) => c.id === req.params.id);
    if (!category) throw new AppError(`Category '${req.params.id}' not found`, 404);

    const subtree = descendantIds(category.id, all);
    const productsCount = await CatalogProductModel.countDocuments({ categoryIds: { $in: subtree } });
    const typeId = resolveTypeId([category.id], all);
    const type = typeId ? await ProductTypeModel.findOne({ id: typeId }).lean() : null;

    res.json(
      ok({
        ...category,
        ancestors: ancestorChain(category.id, all).slice(1).reverse(),
        children: all.filter((c) => c.parentId === category.id),
        productsCount,
        effectiveCommerce: resolveCommerce([category.id], all),
        effectiveTypeId: typeId ?? null,
        /* The field definitions travel with the category so an editor can build
           its form from one call instead of two. */
        fields: (type as any)?.fields ?? [],
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not load the category', log));
  }
};

export const createCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { parentId, typeId, commerce } = req.body;
    assertCommerceCoherent(commerce);

    if (parentId) {
      const parent = await CatalogCategoryModel.findOne({ id: parentId }).lean();
      if (!parent) throw new AppError(`Parent category '${parentId}' not found`, 404);
    }
    if (typeId) {
      const type = await ProductTypeModel.findOne({ id: typeId }).lean();
      if (!type) throw new AppError(`Product type '${typeId}' not found`, 404);
    }

    const created = await CatalogCategoryModel.create({
      ...req.body,
      id: newId(),
      parentId: parentId ?? null,
    });

    log.log(`Created category ${created.id}`);
    res.status(201).json(ok(created.toJSON(), 'Category created'));
  } catch (error) {
    next(toAppError(error, 'Could not create the category', log));
  }
};

export const updateCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertCommerceCoherent(req.body.commerce);

    const all = await loadAllCategories();
    if (!all.some((c) => c.id === req.params.id)) {
      throw new AppError(`Category '${req.params.id}' not found`, 404);
    }
    if (req.body.parentId !== undefined) {
      assertNoCycle(req.params.id, req.body.parentId, all);
    }

    const updated = await CatalogCategoryModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    res.json(ok(updated!.toJSON(), 'Category updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the category', log));
  }
};

/**
 * Deletes a category only when nothing depends on it.
 *
 * Children and products both block it, and the message says which — a bare
 * "cannot delete" leaves the user guessing what to clear first.
 */
export const deleteCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const all = await loadAllCategories();
    if (!all.some((c) => c.id === req.params.id)) {
      throw new AppError(`Category '${req.params.id}' not found`, 404);
    }

    const children = all.filter((c) => c.parentId === req.params.id);
    if (children.length) {
      throw new AppError(
        `Cannot delete: ${children.length} subcategor${children.length === 1 ? 'y' : 'ies'} sit beneath it`,
        409
      );
    }

    const products = await CatalogProductModel.countDocuments({ categoryIds: req.params.id });
    if (products > 0) {
      throw new AppError(`Cannot delete: ${products} product(s) are still in this category`, 409);
    }

    const deleted = await softDeleteOne(CatalogCategoryModel, req.params.id, 'Category');
    log.log(`Soft-deleted category ${req.params.id}`);
    res.json(ok(deleted, 'Category deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the category', log));
  }
};

export const restoreCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const all = await loadAllCategories();
    const restored = await restoreOne(CatalogCategoryModel, req.params.id, 'Category');

    /* A category whose parent is still deleted would come back detached from
       the tree — visible nowhere, and impossible to find in the UI. */
    const parentId = (restored as any).parentId;
    if (parentId && !all.some((c) => c.id === parentId)) {
      log.warn(`Restored category ${req.params.id} has a deleted parent (${parentId})`);
      res.json(ok(restored, 'Category restored — its parent is still deleted, so restore that too'));
      return;
    }

    res.json(ok(restored, 'Category restored'));
  } catch (error) {
    next(toAppError(error, 'Could not restore the category', log));
  }
};
