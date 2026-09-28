import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../middlewares/errorHandler.js';
import { toAppError } from '../../utils/error.util.js';
import { createLogger } from '../../utils/logger.js';
import { getPageParams, ok, paginated } from '../../utils/response.util.js';
import { CatalogItemModel, CatalogProductModel, ProductTypeModel } from '../models.js';
import { newId, restoreOne, softDeleteOne, wantsDeleted, withDeleted } from '../softDelete.js';
import { invalidateTypeCache } from '../services/typeRegistry.js';
import { attributeVocabulary, type VocabularyEntry } from '../services/vocabulary.js';
import type { FieldDefinition } from '../types.js';

const log = createLogger('V2TypeController');

/** `Fuel type` -> `fuel_type`. Stable, URL-safe, and never shown to a user. */
const toKey = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const fieldSchema = z.object({
  key: z.string().min(1).optional(),
  label: z.string().min(1, 'Every field needs a label'),
  type: z.enum(['text', 'number', 'choice', 'boolean']),
  options: z.array(z.string().min(1)).optional(),
  variantForming: z.boolean().optional().default(false),
  filterable: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),
});

/** Which kinds of media a type offers, and whether an image is compulsory. */
const mediaConfigSchema = z.object({
  images: z.object({
    enabled: z.boolean(),
    required: z.boolean().optional().default(false),
  }),
  videos: z.object({ enabled: z.boolean() }),
});

export const createTypeSchema = z.object({
  body: z.object({
    /* No `id` here on purpose: it is always a server-minted UUID, so a client
       cannot mint one that collides with a soft-deleted row. */
    name: z.string().min(1, 'Type name is required'),
    description: z.string().optional().default(''),
    media: mediaConfigSchema.optional(),
    fields: z.array(fieldSchema).optional().default([]),
  }),
});

export const updateTypeSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    media: mediaConfigSchema.optional(),
  }),
});

export const addFieldSchema = z.object({ body: fieldSchema });

export const updateFieldSchema = z.object({
  body: z.object({
    label: z.string().min(1).optional(),
    options: z.array(z.string().min(1)).optional(),
    variantForming: z.boolean().optional(),
    filterable: z.boolean().optional(),
    required: z.boolean().optional(),
    deprecated: z.boolean().optional(),
  }),
});

/**
 * Normalises a field definition.
 *
 * A `choice` field may be declared with **no options**. That makes it an
 * *open choice*: the list is not fixed on the type, and whoever creates a
 * product supplies the values for that product.
 *
 * Both styles are deliberate. A fixed list keeps one shared vocabulary
 * (Colour, the same across every phone). An open one suits a field whose
 * values genuinely differ per product — Flavour, Finish, Fabric — where
 * forcing a global list would mean every product carrying every other
 * product's values.
 */
const normaliseField = (raw: z.infer<typeof fieldSchema>): FieldDefinition => {
  const key = raw.key?.trim() || toKey(raw.label);
  if (!key) throw new AppError(`Cannot derive a field key from "${raw.label}"`, 422);

  if (raw.variantForming && raw.type !== 'choice') {
    /* Variants are a finite matrix. A free-text axis would make the combination
       count unbounded and the filter sidebar meaningless. */
    throw new AppError(`'${raw.label}' cannot form variants unless it is a choice field`, 422);
  }

  return {
    key,
    label: raw.label.trim(),
    type: raw.type,
    ...(raw.options?.length ? { options: dedupe(raw.options) } : {}),
    variantForming: raw.variantForming ?? false,
    filterable: raw.filterable ?? false,
    required: raw.required ?? false,
    deprecated: false,
  };
};

const dedupe = (values: string[]): string[] => {
  const seen = new Map<string, string>();
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (k && !seen.has(k)) seen.set(k, v.trim());
  }
  return [...seen.values()];
};

export const listTypes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, skip } = getPageParams(req);
    const seeDeleted = wantsDeleted(req.query);

    const [rows, total] = await Promise.all([
      withDeleted(ProductTypeModel.find().sort({ name: 1 }).skip(skip).limit(limit), seeDeleted).lean(),
      withDeleted(ProductTypeModel.countDocuments(), seeDeleted),
    ]);
    res.json(paginated(rows, total, page, limit));
  } catch (error) {
    next(toAppError(error, 'Could not list product types', log));
  }
};

export const getType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const row = await ProductTypeModel.findOne({ id: req.params.id }).lean();
    if (!row) throw new AppError(`Product type '${req.params.id}' not found`, 404);

    /* Usage is shown in the UI before anyone tries to delete a field, because
       "this is used by 240 products" is the only thing that makes the deprecate
       rule feel reasonable rather than obstructive. */
    const productCount = await CatalogProductModel.countDocuments({ typeId: row.id });
    res.json(ok({ ...row, productCount }));
  } catch (error) {
    next(toAppError(error, 'Could not load the product type', log));
  }
};

export const createType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, description, fields } = req.body;

    const normalised = (fields ?? []).map(normaliseField);
    const keys = new Set<string>();
    for (const f of normalised) {
      if (keys.has(f.key)) throw new AppError(`Two fields resolve to the same key '${f.key}'`, 422);
      keys.add(f.key);
    }

    const created = await ProductTypeModel.create({
      id: newId(),
      name: name.trim(),
      description: description ?? '',
      media: req.body.media,
      fields: normalised,
    });

    invalidateTypeCache();
    log.log(`Created product type ${created.id} with ${normalised.length} field(s)`);
    res.status(201).json(ok(created.toJSON(), 'Product type created'));
  } catch (error) {
    next(toAppError(error, 'Could not create the product type', log));
  }
};

export const updateType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const updated = await ProductTypeModel.findOneAndUpdate(
      { id: req.params.id },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!updated) throw new AppError(`Product type '${req.params.id}' not found`, 404);

    invalidateTypeCache(req.params.id);
    res.json(ok(updated.toJSON(), 'Product type updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the product type', log));
  }
};

export const addField = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const type = await ProductTypeModel.findOne({ id: req.params.id });
    if (!type) throw new AppError(`Product type '${req.params.id}' not found`, 404);

    const field = normaliseField(req.body);
    if ((type.fields ?? []).some((f: FieldDefinition) => f.key === field.key)) {
      throw new AppError(`'${field.key}' already exists on this type`, 409);
    }

    /* A new required field would invalidate every product already saved, so it
       is accepted as optional and the UI asks for a backfill instead. */
    if (field.required && (await CatalogProductModel.countDocuments({ typeId: type.id })) > 0) {
      field.required = false;
      log.warn(`'${field.key}' added as optional: products already exist on type ${type.id}`);
    }

    type.fields = [...(type.fields ?? []), field];
    await type.save();

    invalidateTypeCache(type.id);
    res.status(201).json(ok(type.toJSON(), 'Field added'));
  } catch (error) {
    next(toAppError(error, 'Could not add the field', log));
  }
};

export const updateField = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const type = await ProductTypeModel.findOne({ id: req.params.id });
    if (!type) throw new AppError(`Product type '${req.params.id}' not found`, 404);

    const index = (type.fields ?? []).findIndex((f: FieldDefinition) => f.key === req.params.key);
    if (index < 0) throw new AppError(`Field '${req.params.key}' not found on this type`, 404);

    /* `toObject()` is essential. `type.fields[index]` is a Mongoose
       subdocument, and spreading one copies its INTERNALS rather than its
       values — so `{...subdoc, ...patch}` silently dropped `options`,
       `variantForming`, `filterable` and `required` on every edit, and left a
       deprecate-only patch with no `label` at all, which then failed
       validation. */
    const raw = type.fields[index];
    const current = (typeof raw?.toObject === 'function' ? raw.toObject() : raw) as FieldDefinition;
    const patch = req.body as Partial<FieldDefinition>;

    /* The key never changes. Renaming a label is cosmetic; renaming a key would
       orphan every stored value pointing at the old one. */
    if (patch.options) {
      const next = dedupe(patch.options);
      const removed = (current.options ?? []).filter(
        (o) => !next.some((n) => n.toLowerCase() === o.toLowerCase())
      );

      if (removed.length) {
        const inUse = await CatalogItemModel.countDocuments({
          attributes: { $elemMatch: { key: current.key, value: { $in: removed } } },
        });
        if (inUse > 0) {
          throw new AppError(
            `Cannot remove ${removed.join(', ')} from '${current.label}': ${inUse} item(s) still use ` +
              `${removed.length === 1 ? 'it' : 'them'}`,
            409
          );
        }
      }
      patch.options = next;
    }

    type.fields[index] = { ...current, ...patch, key: current.key, type: current.type };
    type.markModified('fields');
    await type.save();

    invalidateTypeCache(type.id);
    res.json(ok(type.toJSON(), 'Field updated'));
  } catch (error) {
    next(toAppError(error, 'Could not update the field', log));
  }
};

/**
 * Deprecates a field. It is never hard-deleted.
 *
 * Products keep their stored values, so turning a field back on restores the
 * data rather than losing it. The only exception is a field nothing has used.
 */
export const deprecateField = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const type = await ProductTypeModel.findOne({ id: req.params.id });
    if (!type) throw new AppError(`Product type '${req.params.id}' not found`, 404);

    const index = (type.fields ?? []).findIndex((f: FieldDefinition) => f.key === req.params.key);
    if (index < 0) throw new AppError(`Field '${req.params.key}' not found on this type`, 404);

    const key = type.fields[index].key;
    const [productUses, itemUses] = await Promise.all([
      CatalogProductModel.countDocuments({ 'attributes.key': key }),
      CatalogItemModel.countDocuments({ 'attributes.key': key }),
    ]);

    if (productUses + itemUses === 0) {
      type.fields.splice(index, 1);
      await type.save();
      invalidateTypeCache(type.id);
      res.json(ok(type.toJSON(), 'Field removed — nothing was using it'));
      return;
    }

    type.fields[index].deprecated = true;
    type.markModified('fields');
    await type.save();

    invalidateTypeCache(type.id);
    res.json(
      ok(
        type.toJSON(),
        `Field deprecated: ${productUses + itemUses} record(s) still hold a value for it`
      )
    );
  } catch (error) {
    next(toAppError(error, 'Could not remove the field', log));
  }
};

export const deleteType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const inUse = await CatalogProductModel.countDocuments({ typeId: req.params.id });
    if (inUse > 0) {
      throw new AppError(
        `Cannot delete this type: ${inUse} product(s) are built from it`,
        409
      );
    }

    const deleted = await softDeleteOne(ProductTypeModel, req.params.id, 'Product type');

    invalidateTypeCache(req.params.id);
    log.log(`Soft-deleted product type ${req.params.id}`);
    res.json(ok(deleted, 'Product type deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the product type', log));
  }
};

export const restoreType = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const restored = await restoreOne(ProductTypeModel, req.params.id, 'Product type');
    invalidateTypeCache(req.params.id);
    res.json(ok(restored, 'Product type restored'));
  } catch (error) {
    next(toAppError(error, 'Could not restore the product type', log));
  }
};

/**
 * GET /v2/types/:id/vocabulary
 *
 * The values already in use for each of this type's **open** choice fields —
 * the ones with no fixed list, where every product invents its own.
 *
 * It exists so the form can offer what other products already typed. Without
 * it an open field is a blank box, and a blank box is how one shop ends up
 * with Color, Colour and COLOUR as three unrelated filters. The server already
 * snaps casing on save; this is the same idea one step earlier, where the user
 * can still see it happening.
 *
 * Suggestions only. Anything may be typed, and a fixed-list field is absent
 * from the response entirely — its options are already the vocabulary.
 */
export const getVocabulary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const type = await ProductTypeModel.findOne({ id: req.params.id }).lean();
    if (!type) throw new AppError('Product type not found', 404);

    const open = (type.fields ?? []).filter(
      (f: FieldDefinition) => f.type === 'choice' && !(f.options ?? []).length
    );

    const result: Record<string, VocabularyEntry[]> = {};
    for (const field of open) {
      result[field.key] = await attributeVocabulary(field.key);
    }

    res.json(ok(result));
  } catch (error) {
    next(toAppError(error, 'Could not read the vocabulary', log));
  }
};
