import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { Product } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { buildSort, getPageParams, ok, paginated } from '../utils/response.util.js';

const log = createLogger('ProductController');

const SORTABLE = ['name', 'price', 'stock', 'createdAt', 'sku'];

/* More than this many axes is unusable in a picker and usually a modelling
   mistake: Colour x Size x Material x Pack is already four. */
const MAX_VARIANT_AXES = 6;

const variantAttributeSchema = z.object({
  name: z.string().trim().min(1, 'An attribute needs a name').max(60),
  value: z.string().trim().min(1, 'An attribute needs a value').max(120),
});

const variantSchema = z.object({
  variantId: z.string().trim().optional(),
  /* The real definition of a combination. `option`/`value` are derived from it
     when it is present, so a caller sends one or the other, not both. */
  attributes: z.array(variantAttributeSchema).max(MAX_VARIANT_AXES).optional(),
  option: z.string().optional(),
  value: z.string().optional(),
  title: z.string().optional(),
  sku: z.string().trim().optional(),
  description: z.string().trim().max(1000, 'A variant description cannot exceed 1000 characters').optional(),
  image: z.string().trim().optional(),
  price: z.number().min(0).optional(),
  stock: z.union([z.string(), z.number()]).optional(),
  capacity: z.number().optional(),
  capacityUnit: z.string().optional(),
  status: z.string().optional(),
  images: z.array(z.any()).optional(),
  videos: z.array(z.any()).optional(),
});

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Product name is required'),
    shortName: z.string().optional(),
    sku: z.string().min(1, 'SKU is required'),
    /* The only classification a client may send. The server resolves it and
       derives the display name, so the two can never disagree. */
    categoryId: z.string().min(1, 'categoryId is required'),
    /* Optional: an offering that prices per variant carries no base price. The
       old schema demanded price.positive() and rejected those outright. */
    price: z.number().min(0).optional(),
    originalPrice: z.number().optional(),
    stock: z.number().min(0).optional(),
    stockStatus: z.enum(['In Stock', 'Low Stock', 'Out of Stock']).optional(),
    committed: z.number().optional().default(0),
    reorderPoint: z.number().optional().default(10),
    margin: z.string().optional().default('50.0%'),
    discount: z.string().optional(),
    image: z.string().optional(),
    gallery: z
      .array(z.object({ id: z.number(), label: z.string(), src: z.string() }))
      .optional()
      .default([]),
    description: z.string().optional().default(''),
    variants: z.array(variantSchema).optional().default([]),
    videos: z.array(z.any()).optional().default([]),
  }),
});

export const updateProductSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    shortName: z.string().optional(),
    sku: z.string().optional(),
    categoryId: z.string().optional(),
    price: z.number().min(0).optional(),
    originalPrice: z.number().optional(),
    stock: z.number().min(0).optional(),
    stockStatus: z.enum(['In Stock', 'Low Stock', 'Out of Stock']).optional(),
    committed: z.number().optional(),
    reorderPoint: z.number().optional(),
    margin: z.string().optional(),
    discount: z.string().optional(),
    image: z.string().optional(),
    gallery: z.array(z.object({ id: z.number(), label: z.string(), src: z.string() })).optional(),
    description: z.string().optional(),
    variants: z.array(variantSchema).optional(),
    videos: z.array(z.any()).optional(),
  }),
});

/**
 * Unknown stock is `Unspecified`, not `Out of Stock`.
 *
 * Sold out is a claim about the shelf; an empty field is a claim about nobody
 * having filled it in. Reporting the second as the first is how a product that
 * simply has not been set up yet ends up hidden from customers.
 */
const deriveStockStatus = (
  stock: number | undefined,
  reorderPoint = 10
): Product['stockStatus'] => {
  if (stock === undefined || stock === null || Number.isNaN(stock)) return 'Unspecified';
  if (stock <= 0) return 'Out of Stock';
  if (stock <= reorderPoint) return 'Low Stock';
  return 'In Stock';
};

/**
 * Looks up the referenced category and refuses the write if it does not exist.
 * A 400 rather than a 404 — the request body is malformed; the product itself
 * is not the missing resource.
 */
const resolveCategory = async (categoryId: string) => {
  const category = await store.getCategoryById(categoryId);
  if (!category) {
    log.warn(`Rejected a product write: no category "${categoryId}"`);
    throw new AppError(
      `categoryId "${categoryId}" does not match any category — create it on the Categories tab first`,
      400
    );
  }
  return category;
};

/* A value safe inside an id: lowercase, alphanumerics and dashes. */
const slug = (text: string): string =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

/**
 * Turns whatever a caller sent into a complete, self-consistent variant.
 *
 * `attributes` is the truth. `option` and `value` are a DISPLAY LABEL derived
 * from it — stored, because every existing reader expects them, but never the
 * source: a label that is also the data cannot be filtered on, and splitting it
 * back apart breaks the moment a value contains the separator.
 *
 * A caller that sends only `option`/`value` (the old shape) still works: those
 * become a single-axis attribute, so old and new callers converge on one model.
 */
const normaliseVariants = (variants: any[], productSku: string): any[] => {
  const seenSkus = new Set<string>();
  const seenIds = new Set<string>();

  return variants.map((raw: any, index: number) => {
    const attributes: { name: string; value: string }[] = Array.isArray(raw?.attributes)
      && raw.attributes.length
      ? raw.attributes.map((a: any) => ({
          name: String(a?.name ?? '').trim(),
          value: String(a?.value ?? '').trim(),
        }))
      : /* Old shape, or a bare title: keep it as one axis so nothing is lost. */
        [
          {
            name: String(raw?.option ?? 'Option').trim() || 'Option',
            value: String(raw?.value ?? raw?.title ?? 'Standard').trim() || 'Standard',
          },
        ];

    /* Derived, every time. Re-deriving on update is deliberate: an attribute
       edited without the label being rewritten would otherwise leave the two
       disagreeing, and the label is what a person reads. */
    const option = attributes.map((a) => a.name).join(' / ');
    const value = attributes.map((a) => a.value).join(' · ');

    const sku = String(raw?.sku ?? '').trim() || `${productSku}-${index + 1}`;
    if (seenSkus.has(sku)) {
      throw new AppError(`Duplicate variant SKU "${sku}" — they must be unique within a product`, 400);
    }
    seenSkus.add(sku);

    /* Stable: the same combination keeps its id across re-saves, so a link or a
       basket line does not break when the product is edited. */
    let variantId = String(raw?.variantId ?? '').trim();
    if (!variantId) {
      const fromAttributes = attributes.map((a) => slug(a.value)).filter(Boolean).join('-');
      variantId = `${productSku}-${fromAttributes || index + 1}`;
    }
    if (seenIds.has(variantId)) variantId = `${variantId}-${index + 1}`;
    seenIds.add(variantId);

    const out: Record<string, unknown> = {
      variantId,
      sku,
      attributes,
      option,
      value,
      ...(raw?.price === undefined || raw?.price === null ? {} : { price: raw.price }),
      ...(raw?.stock === undefined || raw?.stock === null || raw?.stock === ''
        ? {}
        : { stock: String(raw.stock) }),
      ...(raw?.status ? { status: raw.status } : {}),
    };

    /* Empty strings are not stored: an absent description is absent, not "". */
    const description = String(raw?.description ?? '').trim();
    if (description) out.description = description;
    const image = String(raw?.image ?? '').trim();
    if (image) out.image = image;

    return out;
  });
};

/**
 * Variant rules that survive a partly-filled offering.
 *
 * Price is deliberately NOT checked. A product can be created before anyone has
 * decided what it costs; the listing marks it incomplete rather than refusing
 * the write. Duplicate SKUs are a different matter — they break identity, so
 * they are still refused.
 */
const assertPricing = (body: any): void => {
  const variants = body.variants ?? [];
  if (variants.length === 0) return;

  const skus = variants.map((v: any) => v.sku).filter(Boolean);
  if (new Set(skus).size !== skus.length) {
    throw new AppError('variant SKUs must be unique within a product', 400);
  }
};

export const getProducts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, skip } = getPageParams(req);
    const { categoryId, category, status, search, sortBy, sortOrder, priceMin, priceMax } =
      req.query;

    /* Parsed rather than cast: `Number('')` is 0, which would silently become a
       real lower bound of zero. */
    const toBound = (raw: unknown): number | undefined => {
      const text = String(raw ?? '').trim();
      if (!text) return undefined;
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    };

    const all = await store.getProducts({
      categoryId: categoryId as string,
      category: category as string,
      status: status as string,
      search: search as string,
      priceMin: toBound(priceMin),
      priceMax: toBound(priceMax),
      sort: buildSort(sortBy, sortOrder, SORTABLE, { createdAt: -1 }),
    });

    log.debug(`getProducts -> ${all.length} match(es)`, { page, search, categoryId });
    res.status(200).json(paginated(all.slice(skip, skip + limit), all.length, page, limit));
  } catch (error) {
    next(toAppError(error, 'Could not load products', log));
  }
};

export const getProductsByIdsSchema = z.object({
  body: z.object({
    ids: z
      .array(z.string().trim().min(1))
      .min(1, 'At least one id is required')
      .max(100, 'At most 100 ids per request'),
  }),
});

/**
 * POST /products/batch
 *
 * Several products in one request. A POST rather than a GET because a list of
 * ids belongs in a body: a URL has a length limit, and ids can contain
 * characters that would have to be escaped into it.
 *
 * Unknown ids are reported in `missing` rather than failing the call — a caller
 * asking for ten products should get the nine that exist, and be told which one
 * did not.
 */
export const getProductsByIds = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const ids: string[] = [
      ...new Set<string>(req.body.ids.map((id: unknown) => String(id).trim())),
    ];

    const found = await Promise.all(ids.map((id) => store.getProductById(id)));
    const products = found.filter(Boolean) as Product[];
    const missing = ids.filter((id, index) => !found[index]);

    if (missing.length) {
      log.debug(`getProductsByIds -> ${missing.length} unknown id(s)`, { missing });
    }

    res.status(200).json(
      ok({
        requested: ids.length,
        returned: products.length,
        missing,
        products,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not load the requested products', log));
  }
};

/** Catalog-wide counts for the metric cards — never page-scoped. */
export const getProductStats = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const products = await store.getProducts();
    const inStock = products.filter((p) => p.stockStatus === 'In Stock').length;
    const lowStock = products.filter((p) => p.stockStatus === 'Low Stock').length;
    const outOfStock = products.filter((p) => p.stockStatus === 'Out of Stock').length;
    /* Reported rather than folded into one of the three: a product nobody has
       given a stock figure is not in stock, not low and not out. Without this
       the three counts silently fail to sum to the total. */
    const stockNotSet = products.filter(
      (p) => !p.stockStatus || p.stockStatus === 'Unspecified'
    ).length;

    res.status(200).json(
      ok({
        total: products.length,
        inStock,
        lowStock,
        outOfStock,
        stockNotSet,
        categoriesCount: new Set(products.map((p) => p.categoryId || p.category)).size,
        inStockPercentage: products.length ? Math.round((inStock / products.length) * 100) : 0,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not compute product statistics', log));
  }
};

/** CSV of the filtered set, not just the visible page. */
export const exportProducts = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { categoryId, category, status, search } = req.query;
    const rows = await store.getProducts({
      categoryId: categoryId as string,
      category: category as string,
      status: status as string,
      search: search as string,
    });

    const header = 'ID,Product Name,SKU,Category,Price,Stock Status,Stock';
    const body = rows
      .map((p) =>
        [p.id, p.name, p.sku, p.category, p.price, p.stockStatus, p.stock]
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');

    log.log(`Exported ${rows.length} product row(s) as CSV`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="omniflow_products.csv"');
    res.status(200).send(`${header}\n${body}`);
  } catch (error) {
    next(toAppError(error, 'Could not export products', log));
  }
};

export const getProductById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const product = await store.getProductById(req.params.id);
    if (!product) throw new AppError('Product not found', 404);
    res.status(200).json(ok(product));
  } catch (error) {
    next(toAppError(error, `Could not load product ${req.params.id}`, log));
  }
};

export const createProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const body = req.body;
    assertPricing(body);

    const category = await resolveCategory(body.categoryId);
    const variants = normaliseVariants(body.variants ?? [], String(body.sku ?? ''));

    /* No base price means the offering prices per variant — the listing still
       needs a figure, so the cheapest priced variant becomes it.
       `Math.min()` of an empty list is Infinity, so the empty case is handled
       before it is called: with nothing priced there is no figure at all. */
    const pricedVariants = variants
      .map((v: any) => Number(v.price))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    const price =
      body.price && body.price > 0
        ? body.price
        : pricedVariants.length
          ? Math.min(...pricedVariants)
          : undefined;

    /* Not defaulted to 0: a stock nobody entered is UNKNOWN, and zero would be
       read as sold out. Variants still roll up — that sum is a real figure. */
    /* Only counts variants that actually carry a capacity. Summing with
       `|| 0` turned a matrix of blanks into a confident 0, which then derived
       as Out of Stock. */
    /* A variant's stock arrives as a NUMBER from the form (`capacity`) and as a
       STRING from the API (`stock: "24 units"`), which is the shape the schema
       declares. `Number("24 units")` is NaN, so an API-created product silently
       lost its roll-up entirely. */
    const capacityOf = (v: any): number | undefined => {
      const raw = v?.capacity ?? v?.stock;
      if (raw === undefined || raw === null || raw === '') return undefined;
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
      const digits = String(raw).match(/-?\d+(\.\d+)?/);
      if (!digits) return undefined;
      const value = Number(digits[0]);
      return Number.isFinite(value) ? value : undefined;
    };

    const countedCapacities = variants
      .map(capacityOf)
      .filter((n: number | undefined): n is number => n !== undefined);
    const stock =
      body.stock ??
      (countedCapacities.length
        ? countedCapacities.reduce((sum: number, n: number) => sum + n, 0)
        : undefined);

    const now = new Date().toISOString();
    const newProduct: Product = {
      ...body,
      variants,
      id: body.sku,
      categoryId: category.id,
      category: category.name,
      categoryCode: category.id,
      price,
      stock,
      stockStatus: body.stockStatus || deriveStockStatus(stock, body.reorderPoint),
      createdAt: now,
      updatedAt: now,
    };

    const created = await store.createProduct(newProduct);
    log.log(`Created product ${created.id} (${created.name}) in ${category.name} [${category.id}]`);
    res.status(201).json(ok(created, 'Product created successfully'));
  } catch (error) {
    next(toAppError(error, 'Could not create the product', log));
  }
};

export const updateProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates: Record<string, unknown> = { ...req.body, updatedAt: new Date().toISOString() };

    const existing = await store.getProductById(id);
    if (!existing) throw new AppError('Product not found', 404);

    /* Re-normalised on update too, so an edited attribute and its display label
       can never drift apart. */
    if (Array.isArray(req.body.variants)) {
      updates.variants = normaliseVariants(
        req.body.variants,
        String(req.body.sku ?? existing.sku ?? id)
      );
    }

    /* Re-pointing at another category carries its name across. */
    if (req.body.categoryId) {
      const category = await resolveCategory(req.body.categoryId);
      updates.categoryId = category.id;
      updates.category = category.name;
      updates.categoryCode = category.id;
    }

    if (req.body.stock !== undefined && req.body.stockStatus === undefined) {
      updates.stockStatus = deriveStockStatus(
        req.body.stock,
        req.body.reorderPoint ?? existing.reorderPoint
      );
    }

    const updated = await store.updateProduct(id, updates as Partial<Product>);
    log.log(`Updated product ${id}`, { fields: Object.keys(req.body) });
    res.status(200).json(ok(updated, 'Product updated successfully'));
  } catch (error) {
    next(toAppError(error, `Could not update product ${req.params.id}`, log));
  }
};

export const deleteProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const success = await store.deleteProduct(req.params.id);
    if (!success) throw new AppError('Product not found', 404);
    log.log(`Deleted product ${req.params.id}`);
    res.status(200).json(ok({ id: req.params.id }, 'Product deleted successfully'));
  } catch (error) {
    next(toAppError(error, `Could not delete product ${req.params.id}`, log));
  }
};
