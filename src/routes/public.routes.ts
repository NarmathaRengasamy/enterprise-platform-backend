import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validate.js';
import { queryCatalog, queryCategories } from '../services/publicCatalog.js';
import { toAppError } from '../utils/error.util.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { ok } from '../utils/response.util.js';

/**
 * PUBLIC CATALOGUE — unauthenticated, for a customer-facing site.
 *
 * Mounted outside `/api/v1`, so it never touches the JWT router. Two rules hold
 * everywhere below:
 *
 *  1. Nothing internal leaves. Margin, committed stock and reorder points are
 *     stripped in one shared place (`publicCatalog`), not per route.
 *  2. Reads only. There is no public write, so nothing here can change data.
 *
 * POST rather than GET because a storefront filter set is a structure — several
 * categories, a price range, a sort — and that belongs in a body rather than a
 * query string that has to be escaped and length-limited.
 */

const log = createLogger('PublicAPI');
const router = Router();

/*
 * A small fixed-window limiter.
 *
 * An unauthenticated endpoint has no account to throttle, so it is throttled by
 * address. In-memory on purpose: this is a floor against a crawler or a runaway
 * client, not a defence against a distributed attack, and pretending otherwise
 * would be worse than being clear about it. Behind a load balancer, put the
 * real limit there too.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.PUBLIC_API_RATE_LIMIT ?? 120);

const hits = new Map<string, { count: number; resetAt: number }>();

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
    log.warn(`Public API rate limit hit by ${key}`);
    return next(
      new AppError(`Too many requests. Try again in ${retryAfter} seconds.`, 429)
    );
  }
  return next();
};

/* Swept so a long-running process does not accumulate an entry per address
   seen. Unref'd so it never holds the process open. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now > entry.resetAt) hits.delete(key);
}, WINDOW_MS).unref();

router.use(rateLimit);

/* ------------------------------------------------------------- products */

export const publicProductsSchema = z.object({
  body: z.object({
    search: z.string().trim().max(200).optional(),
    categoryId: z.string().trim().optional(),
    categoryIds: z.array(z.string().trim()).max(50).optional(),
    priceMin: z.number().nonnegative().optional(),
    priceMax: z.number().nonnegative().optional(),
    status: z.enum(['In Stock', 'Low Stock', 'Out of Stock', 'Unspecified']).optional(),
    sortBy: z.enum(['createdAt', 'price', 'name', 'stock']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
});

/**
 * POST /public/products
 *
 * The catalogue for a storefront: filter by category (one or many), price
 * range, stock status and free text, which also matches variant values such as
 * a colour. **Newest first** unless `sortBy` says otherwise.
 */
router.post(
  '/products',
  validateRequest(publicProductsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await queryCatalog(req.body);
      log.debug(`public products -> ${result.total} match(es)`, { search: req.body.search });
      res.status(200).json(ok(result));
    } catch (error) {
      next(toAppError(error, 'Could not load the catalogue', log));
    }
  }
);

/* ----------------------------------------------------------- categories */

export const publicCategoriesSchema = z.object({
  body: z.object({
    search: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
});

/**
 * POST /public/categories
 *
 * The categories a storefront navigates by. A POST for symmetry with the
 * products call, so a client has one shape to learn.
 */
router.post(
  '/categories',
  validateRequest(publicCategoriesSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await queryCategories(req.body);
      res.status(200).json(ok(result));
    } catch (error) {
      next(toAppError(error, 'Could not load the categories', log));
    }
  }
);

export default router;
