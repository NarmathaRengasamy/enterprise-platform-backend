import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../middlewares/errorHandler.js';
import { toAppError } from '../../utils/error.util.js';
import { createLogger } from '../../utils/logger.js';
import { generateId, getPageParams, ok, paginated } from '../../utils/response.util.js';
import {
  CatalogAvailabilityModel,
  CatalogCategoryModel,
  CatalogItemModel,
  CatalogPriceModel,
  CatalogProductModel,
} from '../models.js';
import { buildFacets, enrichProducts, queryCatalog } from '../services/catalogQuery.js';
import {
  assertMediaAllowed,
  normaliseMedia,
  orphanedFiles,
  remove as removeFile,
  thumbnailUrl,
} from '../services/media.js';
import { distinctAttributeValues } from '../services/vocabulary.js';
import { newId, restoreCascade, restoreOne, softDeleteMany, softDeleteOne } from '../softDelete.js';
import { loadAllCategories, resolveCommerce, resolveTypeId } from '../services/categoryTree.js';
import {
  attributeSignature,
  attributeSlug,
  buildMatrix,
  deriveLabels,
  fieldsOf,
  loadType,
  openChoiceKeys,
  primeVocabulary,
  validateAttributes,
  variantFormingFields,
} from '../services/typeRegistry.js';
import type { AttributeValue, CatalogItem, ProductType } from '../types.js';

const log = createLogger('V2ProductController');

/* ---------------------------------------------------------------- schemas */

const attributeSchema = z.object({ key: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) });

/** One picture or video, as the form sends it back after uploading. */
const mediaAssetSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['image', 'video']),
  url: z.string().min(1),
  source: z.enum(['upload', 'link']).optional().default('upload'),
  sort: z.number().int().nonnegative().optional().default(0),
  isThumbnail: z.boolean().optional(),
  alt: z.string().max(300).optional(),
  filename: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
});

const itemInputSchema = z.object({
  /* `id` is accepted only so an UPDATE can address an existing item. On a
     create it is ignored and a UUID is minted. */
  id: z.string().optional(),
  sku: z.string().optional(),
  attributes: z.array(attributeSchema).optional().default([]),
  description: z.string().max(1000).optional(),
  media: z.array(mediaAssetSchema).max(30).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  /* Price and stock are accepted here as a convenience and written to their own
     collections. The form should not have to make three calls to save one row. */
  price: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  stock: z.number().int().nonnegative().optional(),
  locationId: z.string().optional(),
  leadDays: z.number().int().nonnegative().optional(),
});

export const createProductSchema = z.object({
  body: z.object({
    sku: z.string().min(1, 'SKU is required'),
    name: z.string().min(1, 'Product name is required'),
    description: z.string().optional(),
    brand: z.string().optional(),
    typeId: z.string().optional(),
    categoryIds: z.array(z.string()).optional().default([]),
    attributes: z.array(attributeSchema).optional().default([]),
    status: z.enum(['draft', 'active', 'archived']).optional().default('draft'),
    media: z.array(mediaAssetSchema).max(30).optional(),
    items: z.array(itemInputSchema).optional().default([]),
  }),
});

export const updateProductSchema = z.object({
  body: z.object({
    sku: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    brand: z.string().optional(),
    categoryIds: z.array(z.string()).optional(),
    attributes: z.array(attributeSchema).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    media: z.array(mediaAssetSchema).max(30).optional(),
  }),
});

export const matrixSchema = z.object({
  body: z.object({
    typeId: z.string().min(1),
    /** { colour: ['Blue','Green'], storage: ['128GB','256GB'] } */
    selection: z.record(z.array(z.string().min(1))),
    sku: z.string().optional(),
  }),
});

export const itemSchema = z.object({ body: itemInputSchema });

export const searchSchema = z.object({
  body: z.object({
    search: z.string().optional(),
    categoryId: z.string().optional(),
    categoryIds: z.array(z.string()).optional(),
    typeId: z.string().optional(),
    brand: z.string().optional(),
    status: z.string().optional(),
    attributes: z.record(z.array(z.string())).optional(),
    priceMin: z.number().optional(),
    priceMax: z.number().optional(),
    inStockOnly: z.boolean().optional(),
    priceListId: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    facets: z.boolean().optional(),
    includeDeleted: z.boolean().optional(),
  }),
});

/* -------------------------------------------------------------- helpers */

const normaliseAttrs = (raw: { key: string; value: unknown }[] | undefined): AttributeValue[] =>
  (raw ?? []).map((a) => ({ key: a.key, value: String(a.value) }));

/**
 * Primes the casing vocabulary for a type's open-choice fields.
 *
 * Called before anything is validated. A type with no open fields does no
 * work at all — fixed lists are their own vocabulary.
 */
const primeOpenChoices = async (type: ProductType): Promise<void> => {
  const keys = openChoiceKeys(type);
  if (!keys.length) return;

  await primeVocabulary(keys, distinctAttributeValues);
};

/**
 * Resolves which type a product is built from.
 *
 * An explicit `typeId` wins; otherwise it is inherited from the category, which
 * is how the create form can omit it entirely once a category is picked.
 */
const resolveType = async (body: { typeId?: string; categoryIds?: string[] }): Promise<ProductType> => {
  if (body.typeId) return loadType(body.typeId);

  const all = await loadAllCategories();
  const inherited = resolveTypeId(body.categoryIds ?? [], all);
  if (!inherited) {
    throw new AppError(
      'No product type: pass typeId, or put the product in a category that declares one',
      422
    );
  }
  return loadType(inherited);
};

/**
 * Builds the item rows for a product, rejecting duplicate combinations.
 *
 * Two items with the same variant-forming values are the same item, however
 * their attribute arrays happen to be ordered — which is why the check is on a
 * sorted signature rather than on the SKU alone.
 */
const buildItems = (
  type: ProductType,
  productId: string,
  productSku: string,
  inputs: z.infer<typeof itemInputSchema>[]
): { items: Partial<CatalogItem>[]; sidecars: z.infer<typeof itemInputSchema>[] } => {
  const axes = variantFormingFields(type);
  const signatures = new Set<string>();
  const skus = new Set<string>();

  const items: Partial<CatalogItem>[] = [];
  const sidecars: z.infer<typeof itemInputSchema>[] = [];

  /* A product with no variant axes still needs exactly one item: that is what
     a price and a stock level hang off. v1 had no such row, so a simple product
     and a varianted one took two different code paths everywhere. */
  const rows = inputs.length
    ? inputs
    : [{ attributes: [] as { key: string; value: unknown }[] } as z.infer<typeof itemInputSchema>];

  for (const input of rows) {
    const attributes = axes.length
      ? validateAttributes(type, normaliseAttrs(input.attributes), { scope: 'item' })
      : [];

    const signature = attributeSignature(attributes);
    if (signatures.has(signature)) {
      throw new AppError(
        attributes.length
          ? `Duplicate combination: ${attributes.map((a) => a.value).join(' / ')}`
          : 'A product without variants can only have one item',
        422
      );
    }
    signatures.add(signature);

    const slug = attributeSlug(attributes);
    const sku = (input.sku?.trim() || (slug ? `${productSku}-${slug.toUpperCase()}` : productSku)).trim();
    if (skus.has(sku)) throw new AppError(`Duplicate item SKU '${sku}'`, 422);
    skus.add(sku);

    const labels = deriveLabels(type, attributes);
    const id = newId();

    items.push({
      id,
      productId,
      sku,
      attributes,
      optionLabel: labels.optionLabel || undefined,
      valueLabel: labels.valueLabel || undefined,
      description: input.description,
      media: normaliseMedia(input.media as any),
      image: thumbnailUrl(normaliseMedia(input.media as any)),
      status: input.status ?? 'active',
    });
    sidecars.push({ ...input, id });
  }

  return { items, sidecars };
};

/**
 * Writes the price and availability rows that came in on an item payload.
 *
 * Absent means absent: no price key writes no price row, which is what keeps
 * "not priced yet" distinct from "priced at zero". The same is true of stock —
 * v1 defaulted it and every unstocked product read as sold out.
 */
const writeSidecars = async (
  sidecars: z.infer<typeof itemInputSchema>[],
  commerceCurrency: string,
  availabilityModel: string
): Promise<void> => {
  const priceOps = sidecars
    .filter((s) => typeof s.price === 'number')
    .map((s) => ({
      updateOne: {
        filter: { itemId: s.id, priceListId: 'default', minQuantity: 1 },
        update: {
          $set: { amount: s.price, currency: s.currency ?? commerceCurrency },
          $setOnInsert: { id: newId(), itemId: s.id, priceListId: 'default', minQuantity: 1 },
        },
        upsert: true,
      },
    }));

  const availOps = sidecars
    .filter((s) => typeof s.stock === 'number' || typeof s.leadDays === 'number')
    .map((s) => {
      const locationId = s.locationId ?? 'default';
      const set: Record<string, unknown> = { strategy: availabilityModel };
      if (typeof s.stock === 'number') set.onHand = s.stock;
      if (typeof s.leadDays === 'number') set.leadDays = s.leadDays;

      return {
        updateOne: {
          filter: { itemId: s.id, locationId, date: { $in: [null, undefined] } },
          update: {
            $set: set,
            $setOnInsert: { id: newId(), itemId: s.id, locationId },
          },
          upsert: true,
        },
      };
    });

  if (priceOps.length) await CatalogPriceModel.bulkWrite(priceOps as any);
  if (availOps.length) await CatalogAvailabilityModel.bulkWrite(availOps as any);
};

/* ------------------------------------------------------------ endpoints */

export const listProducts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, skip } = getPageParams(req);

    const attributes: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(req.query)) {
      /* attr.colour=Blue,Green — namespaced so a field called "status" cannot
         collide with the built-in status filter. */
      if (key.startsWith('attr.')) {
        attributes[key.slice(5)] = String(value).split(',').map((v) => v.trim()).filter(Boolean);
      }
    }

    const { products, total } = await queryCatalog({
      search: req.query.search as string | undefined,
      categoryId: req.query.categoryId as string | undefined,
      typeId: req.query.typeId as string | undefined,
      brand: req.query.brand as string | undefined,
      status: req.query.status as string | undefined,
      attributes,
      priceMin: numeric(req.query.priceMin),
      priceMax: numeric(req.query.priceMax),
      inStockOnly: String(req.query.inStockOnly) === 'true',
      priceListId: req.query.priceListId as string | undefined,
      sortBy: req.query.sortBy as string | undefined,
      sortOrder: req.query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip,
      limit,
    });

    res.json(paginated(products, total, page, limit));
  } catch (error) {
    next(toAppError(error, 'Could not list products', log));
  }
};

/** POST search: the same filters, but nestable — arrays and maps do not fit a query string cleanly. */
export const searchProducts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as z.infer<typeof searchSchema>['body'];
    const page = body.page ?? 1;
    const limit = body.limit ?? 20;

    const { products, total } = await queryCatalog({ ...body, skip: (page - 1) * limit, limit });

    if (!body.facets) {
      res.json(paginated(products, total, page, limit));
      return;
    }

    const labels = new Map<string, string>();
    if (body.typeId) {
      const type = await loadType(body.typeId).catch(() => null);
      if (type) for (const f of fieldsOf(type)) labels.set(f.key, f.label);
    }

    const facets = await buildFacets(body, labels);
    res.json({ ...paginated(products, total, page, limit), facets });
  } catch (error) {
    next(toAppError(error, 'Could not search products', log));
  }
};

export const getProduct = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await CatalogProductModel.findOne({ id: req.params.id }).lean();
    if (!product) throw new AppError(`Product '${req.params.id}' not found`, 404);

    const all = await loadAllCategories();
    const [enriched] = await enrichProducts([product as any], all, {
      priceListId: req.query.priceListId as string | undefined,
    });

    const type = await loadType((product as any).typeId).catch(() => null);
    res.json(ok({ ...enriched, fields: type ? fieldsOf(type) : [], typeName: type?.name ?? null }));
  } catch (error) {
    next(toAppError(error, 'Could not load the product', log));
  }
};

export const createProduct = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as z.infer<typeof createProductSchema>['body'];
    const type = await resolveType(body);
    await primeOpenChoices(type);

    if (body.categoryIds?.length) {
      const found = await CatalogCategoryModel.countDocuments({ id: { $in: body.categoryIds } });
      if (found !== body.categoryIds.length) {
        throw new AppError('One or more categoryIds do not exist', 422);
      }
    }

    const attributes = validateAttributes(type, normaliseAttrs(body.attributes), { scope: 'product' });

    /* Media is checked against the TYPE, the same way attributes are — a
       product cannot carry pictures its type does not offer. */
    const media = normaliseMedia(body.media as any);
    assertMediaAllowed(type, media);
    const id = newId();
    const { items, sidecars } = buildItems(type, id, body.sku.trim(), body.items ?? []);

    const created = await CatalogProductModel.create({
      id,
      sku: body.sku.trim(),
      name: body.name.trim(),
      description: body.description ?? '',
      brand: body.brand,
      typeId: type.id,
      categoryIds: body.categoryIds ?? [],
      attributes,
      status: body.status ?? 'draft',
      media,
      image: thumbnailUrl(media),
    });

    try {
      await CatalogItemModel.insertMany(items);

      const all = await loadAllCategories();
      const commerce = resolveCommerce(body.categoryIds ?? [], all);
      await writeSidecars(sidecars, commerce.pricing.currency ?? 'INR', commerce.availability.model);
    } catch (itemError) {
      /* No transaction here (the deployment is not guaranteed to be a replica
         set), so a failed item insert is undone by hand. A product with half
         its items is worse than no product.

         This one rollback stays a HARD delete: the rows never existed as far
         as any caller is concerned, and soft-deleting them would leave the
         freed SKU permanently unusable behind a tombstone. */
      await CatalogItemModel.deleteMany({ productId: id });
      await CatalogProductModel.deleteOne({ id });
      throw itemError;
    }

    log.log(`Created product ${id} with ${items.length} item(s)`);

    const all = await loadAllCategories();
    const [enriched] = await enrichProducts([created.toJSON()], all);
    res.status(201).json(ok(enriched, 'Product created'));
  } catch (error) {
    next(toAppError(error, 'Could not create the product', log));
  }
};

export const updateProduct = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const existing = await CatalogProductModel.findOne({ id: req.params.id });
    if (!existing) throw new AppError(`Product '${req.params.id}' not found`, 404);

    const patch: Record<string, unknown> = { ...req.body };

    if (req.body.media) {
      const type = await loadType(existing.typeId);
      const media = normaliseMedia(req.body.media);
      assertMediaAllowed(type, media);

      patch.media = media;
      /* Derived, never taken from the request. */
      patch.image = thumbnailUrl(media);

      /* Files the edit dropped are deleted once the write succeeds. */
      (patch as any).__orphans = orphanedFiles(existing.media as any, media);
    }

    if (req.body.attributes) {
      const type = await loadType(existing.typeId);
      patch.attributes = validateAttributes(type, normaliseAttrs(req.body.attributes), {
        scope: 'product',
        /* A PATCH sends only what changed, so a missing required field here is
           not an error — it is simply untouched. */
        partial: true,
      });
    }

    if (req.body.categoryIds?.length) {
      const found = await CatalogCategoryModel.countDocuments({ id: { $in: req.body.categoryIds } });
      if (found !== req.body.categoryIds.length) {
        throw new AppError('One or more categoryIds do not exist', 422);
      }
    }

    const orphans = (patch as any).__orphans as string[] | undefined;
    delete (patch as any).__orphans;

    const updated = await CatalogProductModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: patch },
      { new: true, runValidators: true }
    );

    /* After the write, so a failed save never deletes a live file. */
    for (const filename of orphans ?? []) await removeFile(filename);

    const all = await loadAllCategories();
    const [enriched] = await enrichProducts([updated!.toJSON()], all);
    res.json(ok(enriched, 'Product updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the product', log));
  }
};

/** Deletes the product and everything hanging off its items, in dependency order. */
export const deleteProduct = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await CatalogProductModel.findOne({ id: req.params.id }).lean();
    if (!product) throw new AppError(`Product '${req.params.id}' not found`, 404);

    const itemIds = (await CatalogItemModel.find({ productId: req.params.id }).select('id').lean()).map(
      (i: any) => i.id
    );

    /* The cascade is soft too. Leaving the items live under a deleted product
       would strand them: nothing lists them, but every price and availability
       row still resolves against them.

       One timestamp for the whole cascade, so the restore can identify exactly
       which rows went down with this product and leave the rest alone. */
    const at = new Date();
    await Promise.all([
      softDeleteMany(CatalogPriceModel, { itemId: { $in: itemIds } }, at),
      softDeleteMany(CatalogAvailabilityModel, { itemId: { $in: itemIds } }, at),
    ]);
    await softDeleteMany(CatalogItemModel, { productId: req.params.id }, at);
    const deleted = await softDeleteOne(CatalogProductModel, req.params.id, 'Product', at);

    log.log(`Soft-deleted product ${req.params.id} and ${itemIds.length} item(s)`);
    res.json(ok({ ...deleted, itemsDeleted: itemIds.length }, 'Product deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the product', log));
  }
};

/**
 * Restores a product and everything that went down with it.
 *
 * The cascade is reversed as a set, because a product whose items stayed
 * deleted would come back unsellable — it would have no price and no stock,
 * which looks like data loss rather than a restore.
 */
export const restoreProduct = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    /* Read the deletion timestamp BEFORE restoring: the restore clears it, and
       it is the only thing that identifies this cascade. */
    const tombstone = await CatalogProductModel.findOne({ id: req.params.id })
      .setOptions({ withDeleted: true })
      .select('deletedAt')
      .lean();

    const at = (tombstone as any)?.deletedAt as Date | undefined;
    const restored = await restoreOne(CatalogProductModel, req.params.id, 'Product');

    let items = 0;
    if (at) {
      const itemIds = (
        await CatalogItemModel.find({ productId: req.params.id, deletedAt: at })
          .setOptions({ withDeleted: true })
          .select('id')
          .lean()
      ).map((i: any) => i.id);

      items = await restoreCascade(CatalogItemModel, { productId: req.params.id }, at);
      await Promise.all([
        restoreCascade(CatalogPriceModel, { itemId: { $in: itemIds } }, at),
        restoreCascade(CatalogAvailabilityModel, { itemId: { $in: itemIds } }, at),
      ]);
    }

    log.log(`Restored product ${req.params.id} and ${items} item(s)`);

    const all = await loadAllCategories();
    const [enriched] = await enrichProducts([restored as any], all);
    res.json(ok(enriched, 'Product restored'));
  } catch (error) {
    next(toAppError(error, 'Could not restore the product', log));
  }
};

/**
 * Previews the combination matrix without saving anything.
 *
 * Offered rather than imposed: a dealership does not stock every trim in every
 * colour, so the UI generates the grid and the user deletes the rows that do
 * not exist before posting.
 */
export const previewMatrix = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { typeId, selection, sku } = req.body;
    const type = await loadType(typeId);
    await primeOpenChoices(type);
    const combos = buildMatrix(type, selection);

    const base = (sku ?? 'SKU').trim().toUpperCase();
    res.json(
      ok({
        count: combos.length,
        axes: variantFormingFields(type).map((f) => ({ key: f.key, label: f.label, options: f.options ?? [] })),
        items: combos.map((attributes) => {
          const labels = deriveLabels(type, attributes);
          const slug = attributeSlug(attributes);
          return {
            attributes,
            sku: slug ? `${base}-${slug.toUpperCase()}` : base,
            optionLabel: labels.optionLabel,
            valueLabel: labels.valueLabel,
          };
        }),
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not build the matrix', log));
  }
};

/* ---------------------------------------------------------------- items */

export const listItems = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await CatalogProductModel.findOne({ id: req.params.id }).lean();
    if (!product) throw new AppError(`Product '${req.params.id}' not found`, 404);

    const all = await loadAllCategories();
    const [enriched] = await enrichProducts([product as any], all, {
      priceListId: req.query.priceListId as string | undefined,
    });
    res.json(ok(enriched.items));
  } catch (error) {
    next(toAppError(error, 'Could not list items', log));
  }
};

export const addItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await CatalogProductModel.findOne({ id: req.params.id }).lean();
    if (!product) throw new AppError(`Product '${req.params.id}' not found`, 404);

    const type = await loadType((product as any).typeId);
    await primeOpenChoices(type);
    const existing = (await CatalogItemModel.find({ productId: (product as any).id })
      .select('attributes')
      .lean()) as unknown as CatalogItem[];

    const attributes = validateAttributes(type, normaliseAttrs(req.body.attributes), { scope: 'item' });
    const signature = attributeSignature(attributes);
    if (existing.some((i) => attributeSignature(i.attributes ?? []) === signature)) {
      throw new AppError(
        `That combination already exists: ${attributes.map((a) => a.value).join(' / ')}`,
        409
      );
    }

    const { items, sidecars } = buildItems(type, (product as any).id, (product as any).sku, [req.body]);
    const created = await CatalogItemModel.create(items[0]);

    const all = await loadAllCategories();
    const commerce = resolveCommerce((product as any).categoryIds ?? [], all);
    await writeSidecars(sidecars, commerce.pricing.currency ?? 'INR', commerce.availability.model);

    res.status(201).json(ok(created.toJSON(), 'Item added'));
  } catch (error) {
    next(toAppError(error, 'Could not add the item', log));
  }
};

export const updateItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const item = await CatalogItemModel.findOne({ id: req.params.itemId });
    if (!item) throw new AppError(`Item '${req.params.itemId}' not found`, 404);

    const product = await CatalogProductModel.findOne({ id: item.productId }).lean();
    const type = await loadType((product as any).typeId);
    await primeOpenChoices(type);

    const patch: Record<string, unknown> = {};
    for (const key of ['description', 'status', 'sku'] as const) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }

    if (req.body.media) {
      const media = normaliseMedia(req.body.media);
      assertMediaAllowed(type, media);
      patch.media = media;
      patch.image = thumbnailUrl(media);
      for (const filename of orphanedFiles(item.media as any, media)) await removeFile(filename);
    }

    if (req.body.attributes) {
      const attributes = validateAttributes(type, normaliseAttrs(req.body.attributes), { scope: 'item' });
      const signature = attributeSignature(attributes);

      const clash = (await CatalogItemModel.find({
        productId: item.productId,
        id: { $ne: item.id },
      })
        .select('attributes')
        .lean()) as unknown as CatalogItem[];

      if (clash.some((i) => attributeSignature(i.attributes ?? []) === signature)) {
        throw new AppError('Another item already has that combination', 409);
      }

      const labels = deriveLabels(type, attributes);
      patch.attributes = attributes;
      patch.optionLabel = labels.optionLabel || undefined;
      patch.valueLabel = labels.valueLabel || undefined;
    }

    const updated = await CatalogItemModel.findOneAndUpdate(
      { id: req.params.itemId },
      { $set: patch },
      { new: true, runValidators: true }
    );

    const all = await loadAllCategories();
    const commerce = resolveCommerce((product as any).categoryIds ?? [], all);
    await writeSidecars([{ ...req.body, id: req.params.itemId }], commerce.pricing.currency ?? 'INR', commerce.availability.model);

    res.json(ok(updated!.toJSON(), 'Item updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the item', log));
  }
};

export const deleteItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const item = await CatalogItemModel.findOne({ id: req.params.itemId }).lean();
    if (!item) throw new AppError(`Item '${req.params.itemId}' not found`, 404);

    const siblings = await CatalogItemModel.countDocuments({ productId: (item as any).productId });
    if (siblings <= 1) {
      /* Every product keeps at least one item: it is where price and stock
         live, and a product with none is unsellable rather than simple. */
      throw new AppError(
        'A product must keep at least one item — delete the product instead',
        409
      );
    }

    const at = new Date();
    await Promise.all([
      softDeleteMany(CatalogPriceModel, { itemId: req.params.itemId }, at),
      softDeleteMany(CatalogAvailabilityModel, { itemId: req.params.itemId }, at),
    ]);
    const deleted = await softDeleteOne(CatalogItemModel, req.params.itemId, 'Item', at);

    res.json(ok(deleted, 'Item deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the item', log));
  }
};

const numeric = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
