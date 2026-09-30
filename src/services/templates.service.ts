import ecommerce from '../data/templates/ecommerce.json' with { type: 'json' };
import carDealership from '../data/templates/car_dealership.json' with { type: 'json' };
import general from '../data/templates/general.json' with { type: 'json' };
import {
  BusinessTemplate,
  FIELD_TYPES,
  FieldDefinition,
  FieldOption,
  FULFILMENTS,
  StarterCategory,
  TemplateField,
  TRACKINGS,
} from '../types/productType.types.js';

/**
 * Business-category templates (design §5).
 *
 * Seed data, one JSON file per business category, versioned in the repo.
 * Adding a business category means adding a file here — no other code.
 * Every template is checked when this module loads, so a broken file stops
 * the server at start-up instead of producing a half-working product type.
 */

export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,59}$/;

/** Turns an option label into its stable stored value: "Free size" → "free_size". */
export const optionValue = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export const validateTemplate = (t: BusinessTemplate): void => {
  const where = `template "${t.code}"`;
  if (!KEY_PATTERN.test(t.code)) throw new Error(`${where}: invalid code`);
  if (!Number.isInteger(t.version) || t.version < 1) throw new Error(`${where}: version must be an integer ≥ 1`);
  if (!t.name?.en) throw new Error(`${where}: name.en is required`);
  if (!FULFILMENTS.includes(t.default_fulfilment)) throw new Error(`${where}: invalid default_fulfilment`);
  if (!TRACKINGS.includes(t.default_tracking)) throw new Error(`${where}: invalid default_tracking`);

  const keys = new Set<string>();
  for (const f of t.fields) {
    const at = `${where}, field "${f.key}"`;
    if (!KEY_PATTERN.test(f.key)) throw new Error(`${at}: invalid key`);
    if (keys.has(f.key)) throw new Error(`${at}: duplicate key`);
    keys.add(f.key);
    if (!f.label?.en) throw new Error(`${at}: label.en is required`);
    if (!FIELD_TYPES.includes(f.type)) throw new Error(`${at}: invalid type "${f.type}"`);
    /* R41: templates pre-load only basic, descriptive fields. Variants are built
       on each product from the library's choice attributes. */
    if (f.variant_forming) throw new Error(`${at}: templates must not pre-load variant fields`);
    if (f.options && f.type !== 'enum') throw new Error(`${at}: options are only for enum fields`);
    if (f.unit && f.type !== 'number') throw new Error(`${at}: a unit is only for number fields`);
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) throw new Error(`${at}: min is greater than max`);
    const values = (f.options ?? []).map(optionValue);
    if (new Set(values).size !== values.length) throw new Error(`${at}: duplicate options`);
  }

  /* R13: categories no longer set fulfilment or tracking — those belong to the
     product (Phase 3), pre-filled from the type's defaults above. */
  const walk = (cats: StarterCategory[]): void =>
    cats.forEach((c) => {
      const extra = c as StarterCategory & { fulfilment?: unknown; tracking?: unknown };
      if (extra.fulfilment !== undefined || extra.tracking !== undefined) {
        throw new Error(`${where}, starter category "${c.code}": categories do not set fulfilment or tracking`);
      }
      walk(c.children ?? []);
    });
  walk(t.starter_categories ?? []);
};

const ALL = [ecommerce, carDealership, general] as unknown as BusinessTemplate[];
ALL.forEach(validateTemplate);

const BY_CODE = new Map(ALL.map((t) => [t.code, t]));
if (BY_CODE.size !== ALL.length) throw new Error('Two business templates share a code');

export const templatesService = {
  list: (): BusinessTemplate[] => ALL,
  get: (code: string): BusinessTemplate | undefined => BY_CODE.get(code),
  codes: (): string[] => [...BY_CODE.keys()],
};

/** A template field as a stored field definition. */
export const toFieldDefinition = (f: TemplateField, sortOrder: number, version: number): FieldDefinition => ({
  key: f.key,
  label: { ...f.label },
  type: f.type,
  ...(f.unit !== undefined ? { unit: f.unit } : {}),
  ...(f.min !== undefined ? { min: f.min } : {}),
  ...(f.max !== undefined ? { max: f.max } : {}),
  options: (f.options ?? []).map<FieldOption>((label) => ({
    value: optionValue(label),
    label: { en: label },
    deprecated: false,
  })),
  variant_forming: Boolean(f.variant_forming),
  filterable: Boolean(f.filterable),
  required: Boolean(f.required),
  ...(f.group ? { group: f.group } : {}),
  sort_order: sortOrder,
  source: 'template',
  deprecated: false,
  added_in_version: version,
});
