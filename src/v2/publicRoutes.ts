import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middlewares/errorHandler.js';
import { validateRequest } from '../middlewares/validate.js';
import { toAppError } from '../utils/error.util.js';
import { createLogger } from '../utils/logger.js';
import { ok } from '../utils/response.util.js';
import {
  publicCategories,
  publicItemCharges,
  publicProduct,
  publicProducts,
} from './services/publicCatalogV2.js';

/**
 * PUBLIC CATALOGUE V2 — for a customer-facing website.
 *
 * Mounted at `/public/v2`, outside `/api/v1`, so it never reaches the JWT
 * router. Deliberately a separate file and a separate path from the v1
 * `/public` API: that one is in use, its response shape is fixed, and nothing
 * here should be able to change it.
 *
 * Three rules hold everywhere below:
 *
 *  1. **Read only.** There is no public write, so nothing here can alter data.
 *  2. **Published only.** `status: 'active'` is applied in the service, not
 *     per route, so a new endpoint cannot forget it.
 *  3. **Allow-listed output.** Every field is copied deliberately in
 *     `publicCatalogV2`; internal fields are absent by construction.
 */

const log = createLogger('PublicV2');
const router = Router();

/* ------------------------------------------------------------ throttle */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.PUBLIC_API_RATE_LIMIT ?? 120);
const hits = new Map<string, { count: number; resetAt: number }>();

/**
 * A small fixed-window limiter, by address.
 *
 * In-memory on purpose: a floor against a crawler or a runaway client, not a
 * defence against a distributed attack. Behind a load balancer, set the real
 * limit there as well.
 */
const rateLimit = (req: Request, res: Response, next: NextFunction) => {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  entry.count += 1;
  if (entry.count > MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    log.warn(`Public v2 rate limit hit by ${key}`);
    return next(new AppError(`Too many requests. Try again in ${retryAfter} seconds.`, 429));
  }
  return next();
};

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now > entry.resetAt) hits.delete(key);
}, WINDOW_MS).unref();

router.use(rateLimit);

/* ------------------------------------------------------------- schemas */

export const publicV2ProductsSchema = z.object({
  body: z.object({
    search: z.string().trim().max(200).optional(),
    categoryId: z.string().trim().optional(),
    categoryIds: z.array(z.string().trim()).max(50).optional(),
    brand: z.string().trim().max(120).optional(),
    /** { colour: ['Black'], storage: ['64GB'] } */
    attributes: z.record(z.array(z.string().max(120)).max(30)).optional(),
    priceMin: z.number().nonnegative().optional(),
    priceMax: z.number().nonnegative().optional(),
    inStockOnly: z.boolean().optional(),
    sortBy: z.enum(['createdAt', 'name', 'sku', 'brand']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    facets: z.boolean().optional(),
  }),
});

/* ------------------------------------------------------------ products */

/**
 * POST /public/v2/products
 *
 * The storefront listing. POST rather than GET because a filter set is a
 * structure — several categories, a map of attribute values, a price range —
 * and that belongs in a body rather than an escaped query string.
 *
 * Newest first unless `sortBy` says otherwise. `facets: true` adds the filter
 * sidebar, restricted to fields the tenant marked filterable.
 */
router.post(
  '/products',
  validateRequest(publicV2ProductsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await publicProducts(req.body);
      res.json({
        success: true,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        data: result.products,
        ...(result.facets ? { facets: result.facets } : {}),
      });
    } catch (error) {
      next(toAppError(error, 'Could not load the catalogue', log));
    }
  }
);

/** GET /public/v2/products/:id — one product with its variants. */
router.get('/products/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await publicProduct(req.params.id);
    /* Same 404 for "does not exist" and "not published" — a storefront has no
       business being able to tell those apart. */
    if (!product) throw new AppError('Product not found', 404);
    res.json(ok(product));
  } catch (error) {
    next(toAppError(error, 'Could not load the product', log));
  }
});

/* ---------------------------------------------------------- categories */

/** GET /public/v2/categories?tree=true — with a live product count per node. */
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nested = String(req.query.tree) === 'true';
    res.json(ok(await publicCategories(nested)));
  } catch (error) {
    next(toAppError(error, 'Could not load categories', log));
  }
});

/* --------------------------------------------------------------- money */

/**
 * GET /public/v2/items/:itemId/charges
 *
 * The full price breakdown for one variant: base, required charges, optional
 * add-ons. `base` may legitimately be null — a quoted-on-request item still
 * publishes its fixed fees, and a storefront has to render that.
 */
router.get('/items/:itemId/charges', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const breakdown = await publicItemCharges(req.params.itemId);
    if (!breakdown) throw new AppError('Item not found', 404);
    res.json(ok(breakdown));
  } catch (error) {
    next(toAppError(error, 'Could not resolve the price', log));
  }
});

export default router;
