import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validate.js';
import { queryCatalog, queryCategories } from '../services/publicCatalog.js';
import { aiCatalogService, LANGUAGES, MAX_AVAILABILITY_IDS, MAX_DETAIL_IDS } from '../services/aiCatalog.service.js';
import { getPublicSiteSettings } from '../controllers/settings.controller.js';
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

/* ---------------------------------------------- v2: new product module */

/*
 * The storefront on the new product module (design §9.5). Same shapes the AI
 * agent gets over MCP (aiCatalogService): active products and items only,
 * prices and availability as ready-made text plus the paise figure, exact
 * stock only when low. The v1 routes above stay until the Phase 5 data move.
 */

const language = z.enum(LANGUAGES).optional();
const attributeValue = z.union([z.string().max(200), z.number(), z.boolean()]);

export const publicV2SearchSchema = z.object({
  body: z.object({
    search: z.string().trim().max(200).optional(),
    category_id: z.string().trim().max(100).optional(),
    filters: z.record(z.array(attributeValue).max(50)).optional(),
    price_min: z.number().nonnegative().optional(),
    price_max: z.number().nonnegative().optional(),
    in_stock_only: z.boolean().optional(),
    sort: z.enum(['relevance', 'price_asc', 'price_desc', 'newest', 'name', 'size_asc', 'size_desc']).optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    language,
  }),
});

export const publicV2DetailsSchema = z.object({
  body: z.object({ ids: z.array(z.string().trim().min(1)).min(1).max(MAX_DETAIL_IDS), language }),
});

export const publicV2FiltersSchema = z.object({
  body: z.object({ category_id: z.string().trim().max(100).optional(), language }),
});

export const publicV2CategoriesSchema = z.object({
  body: z.object({ search: z.string().trim().max(200).optional(), language }),
});

export const publicV2AvailabilitySchema = z.object({
  body: z.object({ item_ids: z.array(z.string().trim().min(1)).min(1).max(MAX_AVAILABILITY_IDS) }),
});

const v2 = (schema: z.AnyZodObject, run: (body: any) => Promise<unknown>, failure: string) => [
  validateRequest(schema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(ok(await run(req.body)));
    } catch (error) {
      next(toAppError(error, failure, log));
    }
  },
];

/** POST /public/v2/products — search: compact cards with up to 3 matching items each. */
router.post('/v2/products', ...v2(publicV2SearchSchema, (b) => aiCatalogService.search(b), 'Could not load the catalogue'));

/** POST /public/v2/products/details — full details for up to 20 products. */
router.post('/v2/products/details', ...v2(publicV2DetailsSchema, (b) => aiCatalogService.details(b.ids, b.language), 'Could not load the products'));

/** POST /public/v2/filters — filterable attributes, their options and the sorts. */
router.post('/v2/filters', ...v2(publicV2FiltersSchema, (b) => aiCatalogService.filters(b.category_id, b.language), 'Could not load the filters'));

/** POST /public/v2/categories — visible categories with paths and product counts. */
router.post('/v2/categories', ...v2(publicV2CategoriesSchema, (b) => aiCatalogService.categories(b.search, b.language), 'Could not load the categories'));

/** POST /public/v2/availability — live availability for up to 50 items. */
router.post('/v2/availability', ...v2(publicV2AvailabilitySchema, (b) => aiCatalogService.availability(b.item_ids), 'Could not load availability'));

/* ------------------------------------------------------------- settings */

/**
 * GET /public/settings
 *
 * The workspace's own name, tagline, logo and section names, for screens that
 * render before anyone has signed in. Branding only - the controller holds
 * back the legal name, the business category and who last saved.
 */
router.get('/settings', getPublicSiteSettings);

export default router;
