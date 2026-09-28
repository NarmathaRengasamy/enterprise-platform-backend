import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../middlewares/errorHandler.js';
import { toAppError } from '../../utils/error.util.js';
import { createLogger } from '../../utils/logger.js';
import { generateId, ok } from '../../utils/response.util.js';
import {
  CatalogChargeModel,
  CatalogItemModel,
  CatalogPriceModel,
  CatalogProductModel,
} from '../models.js';
import { loadAllCategories, resolveCommerce } from '../services/categoryTree.js';
import { newId, restoreOne, softDeleteOne } from '../softDelete.js';
import {
  collectCharges,
  computeCharges,
  DEFAULT_PRICE_LIST,
  resolvePrice,
} from '../services/pricing.js';

const log = createLogger('V2CommerceController');

/* =============================================================== prices */

export const createPriceSchema = z.object({
  body: z.object({
    itemId: z.string().min(1, 'itemId is required'),
    amount: z.number().nonnegative('A price cannot be negative'),
    currency: z.string().optional().default('INR'),
    priceListId: z.string().optional().default(DEFAULT_PRICE_LIST),
    validFrom: z.string().datetime().nullable().optional(),
    validTo: z.string().datetime().nullable().optional(),
    minQuantity: z.number().int().positive().optional().default(1),
  }),
});

export const updatePriceSchema = z.object({
  body: z.object({
    amount: z.number().nonnegative().optional(),
    currency: z.string().optional(),
    validFrom: z.string().datetime().nullable().optional(),
    validTo: z.string().datetime().nullable().optional(),
    minQuantity: z.number().int().positive().optional(),
  }),
});

/** An inverted window silently matches nothing — better to refuse it on write. */
const assertWindow = (from?: string | null, to?: string | null): void => {
  if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
    throw new AppError('validFrom is after validTo', 422);
  }
};

export const listPrices = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.itemId) filter.itemId = req.query.itemId;
    if (req.query.priceListId) filter.priceListId = req.query.priceListId;

    const query = CatalogPriceModel.find(filter).sort({ itemId: 1, minQuantity: 1 });
    if (String(req.query.includeDeleted) === 'true') query.setOptions({ withDeleted: true });

    res.json(ok(await query.lean()));
  } catch (error) {
    next(toAppError(error, 'Could not list prices', log));
  }
};

export const createPrice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertWindow(req.body.validFrom, req.body.validTo);

    const item = await CatalogItemModel.findOne({ id: req.body.itemId }).lean();
    if (!item) throw new AppError(`Item '${req.body.itemId}' not found`, 404);

    const created = await CatalogPriceModel.create({
      ...req.body,
      id: newId(),
    });

    res.status(201).json(ok(created.toJSON(), 'Price created'));
  } catch (error) {
    next(toAppError(error, 'Could not create the price', log));
  }
};

export const updatePrice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertWindow(req.body.validFrom, req.body.validTo);

    const updated = await CatalogPriceModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!updated) throw new AppError(`Price '${req.params.id}' not found`, 404);

    res.json(ok(updated.toJSON(), 'Price updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the price', log));
  }
};

export const deletePrice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deleted = await softDeleteOne(CatalogPriceModel, req.params.id, 'Price');
    res.json(ok(deleted, 'Price deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the price', log));
  }
};

export const restorePrice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(ok(await restoreOne(CatalogPriceModel, req.params.id, 'Price'), 'Price restored'));
  } catch (error) {
    next(toAppError(error, 'Could not restore the price', log));
  }
};

/* ============================================================== charges */

export const createChargeSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'A charge needs a name'),
      label: z.string().optional(),
      scope: z.object({
        level: z.enum(['category', 'product', 'item']),
        refId: z.string().min(1),
      }),
      basis: z.enum(['fixed', 'percent', 'per_unit', 'per_time']),
      amount: z.number().nonnegative().optional(),
      percent: z.number().nonnegative().max(100).optional(),
      percentOf: z.enum(['base', 'base_plus_charges']).optional().default('base'),
      required: z.boolean().optional().default(true),
      selectable: z.boolean().optional(),
      maxQuantity: z.number().int().positive().optional().default(1),
      currency: z.string().optional().default('INR'),
      priceListId: z.string().nullable().optional(),
      validFrom: z.string().datetime().nullable().optional(),
      validTo: z.string().datetime().nullable().optional(),
      showInListing: z.boolean().optional().default(false),
    })
    /* A percentage charge with no percent, or a fixed one with no amount, would
       resolve to zero and quietly disappear from every total. */
    .refine((c) => (c.basis === 'percent' ? c.percent !== undefined : c.amount !== undefined), {
      message: 'A percent charge needs `percent`; every other basis needs `amount`',
    }),
});

export const updateChargeSchema = z.object({
  body: z.object({
    label: z.string().optional(),
    amount: z.number().nonnegative().optional(),
    percent: z.number().nonnegative().max(100).optional(),
    percentOf: z.enum(['base', 'base_plus_charges']).optional(),
    required: z.boolean().optional(),
    selectable: z.boolean().optional(),
    maxQuantity: z.number().int().positive().optional(),
    validFrom: z.string().datetime().nullable().optional(),
    validTo: z.string().datetime().nullable().optional(),
    showInListing: z.boolean().optional(),
  }),
});

export const listCharges = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.scope) filter['scope.level'] = req.query.scope;
    if (req.query.refId) filter['scope.refId'] = req.query.refId;

    const query = CatalogChargeModel.find(filter).sort({ name: 1 });
    if (String(req.query.includeDeleted) === 'true') query.setOptions({ withDeleted: true });

    res.json(ok(await query.lean()));
  } catch (error) {
    next(toAppError(error, 'Could not list charges', log));
  }
};

export const createCharge = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertWindow(req.body.validFrom, req.body.validTo);

    const created = await CatalogChargeModel.create({
      ...req.body,
      id: newId(),
      selectable: req.body.selectable ?? !req.body.required,
    });

    log.log(`Created charge ${created.id} on ${req.body.scope.level} ${req.body.scope.refId}`);
    res.status(201).json(ok(created.toJSON(), 'Charge created'));
  } catch (error) {
    next(toAppError(error, 'Could not create the charge', log));
  }
};

export const updateCharge = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    assertWindow(req.body.validFrom, req.body.validTo);

    const updated = await CatalogChargeModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!updated) throw new AppError(`Charge '${req.params.id}' not found`, 404);

    res.json(ok(updated.toJSON(), 'Charge updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the charge', log));
  }
};

export const deleteCharge = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    /* A deleted charge simply stops being collected on the next resolve — no
       total is rewritten retrospectively, because an order already quoted at
       the old figure must keep it. */
    const deleted = await softDeleteOne(CatalogChargeModel, req.params.id, 'Charge');
    res.json(ok(deleted, 'Charge deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the charge', log));
  }
};

export const restoreCharge = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(ok(await restoreOne(CatalogChargeModel, req.params.id, 'Charge'), 'Charge restored'));
  } catch (error) {
    next(toAppError(error, 'Could not restore the charge', log));
  }
};

/**
 * The full money picture for one item: base, required charges, optional ones.
 *
 * `base` may legitimately be null. The required charges are still returned and
 * totalled separately, so a dealership can show "Price on request" beside the
 * registration fee rather than hiding both.
 */
export const resolveItemCharges = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const item = await CatalogItemModel.findOne({ id: req.params.itemId }).lean();
    if (!item) throw new AppError(`Item '${req.params.itemId}' not found`, 404);

    const product = await CatalogProductModel.findOne({ id: (item as any).productId }).lean();
    if (!product) throw new AppError('The parent product is missing', 404);

    const priceListId = (req.query.priceListId as string) || DEFAULT_PRICE_LIST;
    const at = req.query.at ? new Date(req.query.at as string) : new Date();
    if (Number.isNaN(at.getTime())) throw new AppError('`at` is not a valid date', 400);

    const quantity = Math.max(1, Number(req.query.quantity ?? 1) || 1);
    const units = Math.max(1, Number(req.query.units ?? quantity) || 1);

    const all = await loadAllCategories();
    const commerce = resolveCommerce((product as any).categoryIds ?? [], all);

    const price = await resolvePrice((item as any).id, { priceListId, at, quantity });
    const charges = await collectCharges(
      {
        itemId: (item as any).id,
        productId: (product as any).id,
        categoryIds: (product as any).categoryIds ?? [],
      },
      all,
      { priceListId, at }
    );

    const breakdown = computeCharges(charges, price?.amount ?? null, {
      units,
      currency: price?.currency ?? commerce.pricing.currency ?? 'INR',
    });

    res.json(
      ok({
        itemId: (item as any).id,
        sku: (item as any).sku,
        pricingModel: commerce.pricing.model,
        priceLabel: commerce.pricing.label ?? null,
        ...breakdown,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not resolve charges', log));
  }
};
