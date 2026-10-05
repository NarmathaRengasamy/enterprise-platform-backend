import mongoose from 'mongoose';
import { AppError } from '../middlewares/errorHandler.js';
import { ProductTypeModel } from '../models/ProductType.model.js';
import { softDelete } from '../utils/soft-delete.util.js';
import { createLogger } from '../utils/logger.js';
import { tenantSettingsService } from './tenantSettings.service.js';
import { KEY_PATTERN, optionValue, templatesService, toFieldDefinition } from './templates.service.js';
import { normaliseUnit, UNITS, UnitFamily, unitsOf } from '../utils/units.util.js';
import {
  BusinessTemplate,
  FieldDefinition,
  FieldOption,
  FieldType,
  Translated,
} from '../types/productType.types.js';

const log = createLogger('ProductType');

/**
 * The tenant's product type: pre-loaded from a business-category template,
 * extended with the admin's own attributes (design §3.1, §7.1–§7.3, R1–R10, K1–K3).
 */

/* Collections that arrive in Phase 3. Until then they do not exist, every count
   is 0, and the "products exist" rules (K1, K3, R5) simply never trigger. */
const PRODUCTS_COLLECTION = 'products_v2';
const ITEMS_COLLECTION = 'product_items';

const liveCount = async (collection: string, filter: Record<string, unknown> = {}): Promise<number> => {
  const db = mongoose.connection.db;
  if (!db) return 0;
  return db.collection(collection).countDocuments({ is_deleted: false, ...filter });
};

export const countLiveProducts = (): Promise<number> => liveCount(PRODUCTS_COLLECTION);

/** True if any live product or item holds a value for this field. */
export const isFieldUsed = async (key: string): Promise<boolean> =>
  (await liveCount(PRODUCTS_COLLECTION, { $or: [{ 'attributes.key': key }, { 'variant_axes.key': key }] })) > 0 ||
  (await liveCount(ITEMS_COLLECTION, { 'attributes.key': key })) > 0;

/** True if a live product builds its variants from this field (R45: its unit family is then fixed). */
export const isVariantAxis = async (key: string): Promise<boolean> =>
  (await liveCount(PRODUCTS_COLLECTION, { 'variant_axes.key': key })) > 0;

/** "Warranty (months)" → "warranty_months". */
export const keyFromLabel = (label: string): string => {
  let key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (/^[0-9]/.test(key)) key = `f_${key}`.slice(0, 60);
  return key;
};

const sorted = (fields: FieldDefinition[]) => [...fields].sort((a, b) => a.sort_order - b.sort_order);
const plain = (doc: any) => (typeof doc?.toJSON === 'function' ? doc.toJSON() : doc);

/** The wire shape: fields in display order, plus whether a newer template exists. */
export const toResponse = (doc: any) => {
  if (!doc) return null;
  const json = plain(doc);
  const latest = templatesService.get(json.template_code);
  return {
    ...json,
    fields: sorted(json.fields ?? []),
    template_update_available: Boolean(latest && latest.version > json.template_version),
  };
};

/* ------------------------------------------------------------ helpers */

const conflict = (message: string) => new AppError(message, 409);
const invalid = (message: string, field?: string) =>
  new AppError(message, 422, undefined, field ? { [field]: message } : undefined);

export interface OptionInput {
  value?: string;
  label: Translated;
  deprecated?: boolean;
}

const cleanTranslated = (t: Translated): Translated => ({
  en: t.en.trim(),
  ...(t.ta?.trim() ? { ta: t.ta.trim() } : {}),
  ...(t.hi?.trim() ? { hi: t.hi.trim() } : {}),
});

const buildOptions = (input: OptionInput[]): FieldOption[] => {
  const out: FieldOption[] = [];
  const seen = new Set<string>();
  for (const [i, o] of input.entries()) {
    const value = o.value?.trim() || optionValue(o.label.en);
    if (!value) throw invalid(`Option ${i + 1} needs a name`, `options.${i}`);
    if (seen.has(value)) throw invalid(`Duplicate option "${o.label.en}"`, `options.${i}`);
    seen.add(value);
    out.push({ value, label: cleanTranslated(o.label), deprecated: Boolean(o.deprecated) });
  }
  return out;
};

/** Shape rules every field must satisfy, template or custom. */
const assertFieldShape = (f: FieldDefinition, isNewCustom: boolean) => {
  if (!f.label.en) throw invalid('An attribute needs a name', 'label.en');
  if (f.unit_family && f.type !== 'number') throw invalid('A unit family is only for number fields', 'unit_family');
  /* R45: a choice list, or a number with a unit family (measured sizes). */
  if (f.variant_forming && f.type !== 'enum' && !(f.type === 'number' && f.unit_family)) {
    throw invalid(
      f.type === 'number' ? 'A number field can form variants only with a unit family (weight, volume, length or count)' : 'Only enum fields, or number fields with a unit family, can form variants',
      'variant_forming'
    );
  }
  /* A unit, when set, must belong to the family: kg on a volume field is refused. */
  if (f.unit_family && f.unit) {
    const u = normaliseUnit(f.unit);
    if (!u || UNITS[u].family !== f.unit_family) {
      throw invalid(`The unit must be one of ${unitsOf(f.unit_family).join(', ')} for a ${f.unit_family} field`, 'unit');
    }
  }
  if (f.type !== 'enum' && f.options.length) throw invalid('Options are only for enum fields', 'options');
  if (f.unit && f.type !== 'number') throw invalid('A unit is only for number fields', 'unit');
  if ((f.min !== undefined || f.max !== undefined) && f.type !== 'number')
    throw invalid('Min / max are only for number fields', 'min');
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) throw invalid('Min cannot be greater than max', 'min');
  /* A template may ship an enum with no options (the tenant adds them, e.g. car
     colours); a new custom enum must start with at least one. */
  if (isNewCustom && f.type === 'enum' && f.options.length === 0)
    throw invalid('An enum needs at least one option', 'options');
};

/**
 * Writes a new field list, guarded by `type_version`.
 *
 * Two admins editing at once would otherwise silently overwrite each other's
 * change (last write wins on the whole array). The update only applies if the
 * version is still the one this change was based on.
 */
const saveFields = async (type: any, fields: FieldDefinition[], extra: Record<string, unknown> = {}) => {
  const updated = await ProductTypeModel.findOneAndUpdate(
    { id: type.id, type_version: type.type_version },
    { $set: { fields, type_version: type.type_version + 1, ...extra } },
    { new: true, runValidators: true }
  );
  if (!updated) {
    throw new AppError('The attributes were changed by someone else — reload and try again', 409, {
      code: VERSION_CONFLICT,
    });
  }
  return updated;
};

const VERSION_CONFLICT = 'type_version_conflict';
const isVersionConflict = (e: unknown) => e instanceof AppError && e.details?.code === VERSION_CONFLICT;

/* ------------------------------------------------ near-duplicate check */

/** Optimal-string-alignment distance: edits, where swapping two neighbours counts as one. */
const editDistance = (a: string, b: string): number => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
};

const squash = (v: string) => v.replace(/_/g, '');

/**
 * The existing option a new value looks like a slip of, if any (§1.5 T2).
 *
 * "red" vs "Red" is an exact match (handled before this). This catches the
 * near misses that would otherwise split one colour into two: "rde" / "red",
 * "reds" / "red", "off_white" / "offwhite".
 */
export const similarOption = (value: string, existing: string[]): string | undefined =>
  existing.find((e) => {
    const [a, b] = [squash(value), squash(e)];
    if (a === b) return true;
    if (a.replace(/s$/, '') === b.replace(/s$/, '')) return true;
    return Math.min(a.length, b.length) >= 3 && editDistance(a, b) <= 1;
  });

/* ----------------------------------------------------- product type */

const createFromTemplate = async (template: BusinessTemplate) => {
  const fields = template.fields.map((f, i) => toFieldDefinition(f, i + 1, 1));
  return ProductTypeModel.create({
    code: template.code,
    name: { ...template.name },
    template_code: template.code,
    template_version: template.version,
    type_version: 1,
    fulfilment: template.default_fulfilment,
    tracking: template.default_tracking,
    fields,
  });
};

/**
 * Adds a template's fields to an existing type — additively (K1, K2).
 *
 * New keys are appended; for keys already present only missing enum options are
 * added. Nothing is removed, retyped or reordered. A key that exists with a
 * different type is left alone and reported.
 */
const mergeTemplate = async (type: any, template: BusinessTemplate) => {
  const fields: FieldDefinition[] = plain(type).fields.map((f: FieldDefinition) => ({ ...f, options: [...f.options] }));
  const nextVersion = type.type_version + 1;
  let order = Math.max(0, ...fields.map((f) => f.sort_order));
  const added: string[] = [];
  const skipped: string[] = [];

  for (const tf of template.fields) {
    const existing = fields.find((f) => f.key === tf.key);
    if (!existing) {
      fields.push(toFieldDefinition(tf, ++order, nextVersion));
      added.push(tf.key);
      continue;
    }
    if (existing.type !== tf.type) {
      skipped.push(tf.key);
      continue;
    }
    for (const label of tf.options ?? []) {
      const value = optionValue(label);
      if (!existing.options.some((o) => o.value === value)) {
        existing.options.push({ value, label: { en: label }, deprecated: false });
        added.push(`${tf.key}:${value}`);
      }
    }
  }

  const updated = await saveFields(type, fields, {
    template_code: template.code,
    template_version: template.version,
  });
  return { updated, added, skipped };
};

export const productTypeService = {
  async getActive(): Promise<any> {
    const settings = await tenantSettingsService.get();
    if (!settings.active_product_type_id) return null;
    return ProductTypeModel.findOne({ id: settings.active_product_type_id });
  },

  async requireActive(): Promise<any> {
    const type = await this.getActive();
    if (!type) throw new AppError('Choose a business category in Site Settings first', 409);
    return type;
  },

  /**
   * Sets the business category (and the other business settings) and makes
   * sure the tenant's product type matches it.
   */
  async setBusinessCategory(input: {
    business_category: string;
    timezone?: string;
    default_currency?: string;
    languages?: string[];
  }) {
    const template = templatesService.get(input.business_category);
    if (!template) {
      throw invalid(
        `Unknown business category. Choose one of: ${templatesService.codes().join(', ')}`,
        'business_category'
      );
    }

    const settings = await tenantSettingsService.get();
    /* Once chosen, the business category is locked (Oct 2026): the other business
       settings can still be saved with it, but never a different category. */
    if (settings.business_category && settings.business_category !== template.code) {
      throw conflict("The business category can't be changed once chosen. Add or retire fields in Attributes instead.");
    }
    const active = await this.getActive();
    let type = active;
    let outcome: 'created' | 'unchanged' | 'replaced' | 'merged';
    let notice: string | undefined;

    if (!active) {
      type = await createFromTemplate(template);
      outcome = 'created';
    } else if (settings.business_category === template.code) {
      outcome = 'unchanged';
    } else if ((await countLiveProducts()) === 0) {
      /* No products yet: nothing depends on the old fields, so the type is
         replaced outright. The old one is soft-deleted, not destroyed. */
      await softDelete(ProductTypeModel, active.id);
      type = await createFromTemplate(template);
      outcome = 'replaced';
    } else {
      /* Products exist (K1): the new category's fields are added; nothing the
         existing products use is removed. */
      const merged = await mergeTemplate(active, template);
      type = merged.updated;
      outcome = 'merged';
      notice =
        `Products already exist, so the ${template.name.en} fields were added to your attributes; ` +
        'nothing was removed.' +
        (merged.skipped.length ? ` Not added (a field with that key already exists): ${merged.skipped.join(', ')}.` : '');
    }

    const updatedSettings = await tenantSettingsService.update({
      business_category: template.code,
      active_product_type_id: type.id,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.default_currency ? { default_currency: input.default_currency } : {}),
      ...(input.languages ? { languages: input.languages } : {}),
    });

    log.log(`Business category "${template.code}" — product type ${outcome}`);
    return { settings: updatedSettings, product_type: type, outcome, notice };
  },

  async addField(input: {
    label: Translated;
    key?: string;
    type: FieldType;
    unit?: string;
    unit_family?: UnitFamily;
    min?: number;
    max?: number;
    options?: OptionInput[];
    variant_forming?: boolean;
    filterable?: boolean;
    required?: boolean;
    group?: string;
  }) {
    const type = await this.requireActive();
    const current: FieldDefinition[] = plain(type).fields;

    const key = input.key ?? keyFromLabel(input.label.en);
    if (!KEY_PATTERN.test(key)) {
      throw invalid('The key must start with a letter and use only a–z, 0–9 and _', input.key ? 'key' : 'label.en');
    }
    if (current.some((f) => f.key === key)) throw conflict(`An attribute with the key "${key}" already exists`);

    let required = Boolean(input.required);
    let notice: string | undefined;
    /* K3: a required field added after products exist would make every one of
       them invalid, so it starts optional until the values are back-filled. */
    if (required && (await countLiveProducts()) > 0) {
      required = false;
      notice = `"${input.label.en}" was added as optional because products already exist. Fill in the value on existing products, then make it required.`;
    }

    const field: FieldDefinition = {
      key,
      label: cleanTranslated(input.label),
      type: input.type,
      ...(input.unit?.trim() ? { unit: input.unit_family ? normaliseUnit(input.unit) ?? input.unit.trim() : input.unit.trim() } : {}),
      ...(input.unit_family ? { unit_family: input.unit_family } : {}),
      ...(input.min !== undefined ? { min: input.min } : {}),
      ...(input.max !== undefined ? { max: input.max } : {}),
      options: buildOptions(input.options ?? []),
      /* Any choice list can be used for variants unless the admin says otherwise
         (R43); which ones a product actually uses is chosen on the product. */
      variant_forming: input.variant_forming ?? input.type === 'enum',
      filterable: Boolean(input.filterable),
      required,
      ...(input.group?.trim() ? { group: input.group.trim() } : {}),
      sort_order: Math.max(0, ...current.map((f) => f.sort_order)) + 1,
      source: 'custom',
      deprecated: false,
      added_in_version: type.type_version + 1,
    };
    assertFieldShape(field, true);

    const updated = await saveFields(type, [...current, field]);
    return { product_type: updated, notice };
  },

  async updateField(
    key: string,
    patch: {
      key?: string;
      type?: FieldType;
      label?: Translated;
      unit?: string | null;
      unit_family?: UnitFamily | null;
      min?: number | null;
      max?: number | null;
      options?: OptionInput[];
      variant_forming?: boolean;
      filterable?: boolean;
      required?: boolean;
      group?: string | null;
      sort_order?: number;
      deprecated?: boolean;
    }
  ) {
    const type = await this.requireActive();
    const fields: FieldDefinition[] = plain(type).fields.map((f: FieldDefinition) => ({ ...f }));
    const index = fields.findIndex((f) => f.key === key);
    if (index === -1) throw new AppError(`No attribute with the key "${key}"`, 404);
    const field = fields[index];

    if (patch.key !== undefined && patch.key !== key) throw conflict('Attribute keys cannot be changed');

    /* Template fields and custom fields already holding values are locked in
       what they MEAN; an unused custom field can still be reshaped (R4, R5). */
    const locked = field.source === 'template' || (await isFieldUsed(key));
    const lockedWhy =
      field.source === 'template' ? 'on a template attribute' : 'once products use this attribute';

    if (patch.type !== undefined && patch.type !== field.type) {
      if (locked) throw conflict(`The type cannot be changed ${lockedWhy}`);
      field.type = patch.type;
      if (field.type !== 'enum') {
        field.options = [];
        field.variant_forming = false;
      }
      if (field.type !== 'number') {
        delete field.unit;
        delete field.unit_family;
        delete field.min;
        delete field.max;
      }
    }

    /* R45: the unit family adds a use (measured sizes) without changing what
       stored values mean, so it may be set on a template or used field — but not
       changed while a product builds its variants from the field. */
    const usedAsAxis = await isVariantAxis(key);
    if (patch.unit_family !== undefined && (patch.unit_family ?? null) !== (field.unit_family ?? null)) {
      if (usedAsAxis) throw conflict('Products build their variants from this attribute, so its unit family cannot be changed');
      if (patch.unit_family === null) {
        delete field.unit_family;
        /* Without a family a number can no longer form variants. */
        if (field.type === 'number') field.variant_forming = false;
      } else {
        field.unit_family = patch.unit_family;
      }
    }

    for (const prop of ['unit', 'min', 'max'] as const) {
      if (patch[prop] === undefined) continue;
      /* null, '' and "not set" all mean the same thing — sending "no unit" for
         a field that has none is not a change. */
      const incoming = patch[prop] === '' ? null : patch[prop];
      const current = (field as any)[prop] ?? null;
      if (incoming === current) continue;
      if (locked) throw conflict(`The ${prop} cannot be changed ${lockedWhy}`);
      if (incoming === null) delete (field as any)[prop];
      else (field as any)[prop] = incoming;
    }

    if (patch.variant_forming !== undefined && patch.variant_forming !== field.variant_forming) {
      /* A measured size may be switched on or off for variants on any number field
         with a unit family, unless products already build variants from it. */
      const measured = field.type === 'number' && Boolean(field.unit_family);
      if (measured ? usedAsAxis : locked) {
        throw conflict(measured ? 'Products build their variants from this attribute, so this cannot be changed' : `Whether it forms variants cannot be changed ${lockedWhy}`);
      }
      field.variant_forming = patch.variant_forming;
    }

    if (patch.options !== undefined) {
      const next = buildOptions(patch.options);
      if (locked) {
        /* Add-only (R7): every existing option must still be there and still mean
           the same thing. Retiring one (deprecated) is allowed. */
        for (const old of field.options) {
          const match = next.find((o) => o.value === old.value);
          if (!match) throw conflict(`Options can only be added or retired, not removed ("${old.label.en}")`);
          if (match.label.en !== old.label.en)
            throw conflict(`An existing option cannot be renamed ("${old.label.en}") — add a new one instead`);
        }
      }
      field.options = next;
    }

    if (patch.label !== undefined) field.label = cleanTranslated(patch.label);
    if (patch.filterable !== undefined) field.filterable = patch.filterable;
    if (patch.group !== undefined) {
      if (patch.group === null || !patch.group.trim()) delete field.group;
      else field.group = patch.group.trim();
    }
    if (patch.sort_order !== undefined) field.sort_order = patch.sort_order;
    if (patch.deprecated !== undefined) field.deprecated = patch.deprecated;

    let notice: string | undefined;
    if (patch.required !== undefined) {
      if (patch.required && !field.required && (await countLiveProducts()) > 0) {
        notice = `"${field.label.en}" stays optional because products already exist. Fill in the value on existing products first.`;
      } else {
        field.required = patch.required;
      }
    }

    assertFieldShape(field, false);
    fields[index] = field;
    const updated = await saveFields(type, fields);
    return { product_type: updated, notice };
  },

  /**
   * Adds options to a choice attribute — from the product form (R44, §7.2b).
   *
   * Editors may call this; only Admins manage attributes themselves. Add-only:
   * nothing is removed or renamed. An option that already exists (after
   * normalising) is returned, not duplicated. A near-duplicate is held back
   * with a warning unless `confirm` is set, so a typo does not quietly become a
   * new colour for every product. Additions never conflict with each other, so
   * a `type_version` clash is retried rather than returned.
   */
  async addOptions(key: string, input: OptionInput[], confirm = false) {
    for (let attempt = 1; ; attempt++) {
      const type = await this.requireActive();
      const fields: FieldDefinition[] = plain(type).fields.map((f: FieldDefinition) => ({ ...f, options: [...f.options] }));
      const field = fields.find((f) => f.key === key);
      if (!field) throw new AppError(`No attribute with the key "${key}"`, 404);
      if (field.type !== 'enum') throw invalid('Options can only be added to a choice-list attribute', 'options');
      if (field.deprecated) throw conflict(`"${field.label.en}" is retired — restore it before adding options`);

      /* The same option typed twice in one request ("red", " RED ") is one option. */
      const seen = new Set<string>();
      const unique = input.filter((o) => {
        const v = o.value?.trim() || optionValue(o.label.en);
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      });
      const wanted = buildOptions(unique);
      const existingValues = field.options.map((o) => o.value);
      const existing: string[] = [];
      const warnings: { value: string; label: string; similar_to: string }[] = [];
      const toAdd: FieldOption[] = [];

      for (const o of wanted) {
        if (existingValues.includes(o.value)) {
          existing.push(o.value);
          continue;
        }
        const similar = similarOption(o.value, existingValues);
        if (similar && !confirm) {
          const match = field.options.find((x) => x.value === similar)!;
          warnings.push({ value: o.value, label: o.label.en, similar_to: match.label.en });
          continue;
        }
        toAdd.push(o);
      }

      /* Held back for confirmation: write nothing, say why. */
      if (warnings.length) return { product_type: type, added: [] as string[], existing, warnings };
      if (!toAdd.length) return { product_type: type, added: [] as string[], existing, warnings };

      field.options.push(...toAdd);
      try {
        const updated = await saveFields(type, fields);
        return { product_type: updated, added: toAdd.map((o) => o.value), existing, warnings };
      } catch (e) {
        if (isVersionConflict(e) && attempt < 3) continue;
        throw e;
      }
    }
  },

  /** Deletes only an unused custom field; everything else is retired instead. */
  async deleteField(key: string) {
    const type = await this.requireActive();
    const fields: FieldDefinition[] = plain(type).fields;
    const field = fields.find((f) => f.key === key);
    if (!field) throw new AppError(`No attribute with the key "${key}"`, 404);
    if (field.source === 'template') throw conflict('Template attributes cannot be deleted — retire it instead');
    if (await isFieldUsed(key)) throw conflict('Products use this attribute, so it cannot be deleted — retire it instead');
    const updated = await saveFields(type, fields.filter((f) => f.key !== key));
    return { product_type: updated };
  },

  /** Sets the display order from a full list of keys. */
  async reorderFields(keys: string[]) {
    const type = await this.requireActive();
    const fields: FieldDefinition[] = plain(type).fields.map((f: FieldDefinition) => ({ ...f }));
    const all = fields.map((f) => f.key).sort();
    if (keys.length !== fields.length || new Set(keys).size !== keys.length || [...keys].sort().join() !== all.join()) {
      throw invalid('Send every attribute key exactly once', 'keys');
    }
    for (const f of fields) f.sort_order = keys.indexOf(f.key) + 1;
    const updated = await saveFields(type, fields);
    return { product_type: updated };
  },

  /** Merges a newer version of the tenant's template, if there is one (K2). */
  async upgradeTemplate() {
    const type = await this.requireActive();
    const template = templatesService.get(type.template_code);
    if (!template || template.version <= type.template_version) {
      return { product_type: type, outcome: 'up_to_date' as const, added: [] as string[] };
    }
    const { updated, added } = await mergeTemplate(type, template);
    return { product_type: updated, outcome: 'upgraded' as const, added };
  },
};
