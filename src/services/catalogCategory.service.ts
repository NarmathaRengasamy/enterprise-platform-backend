import mongoose from 'mongoose';
import { AppError } from '../middlewares/errorHandler.js';
import { CatalogCategoryModel } from '../models/CatalogCategory.model.js';
import { INCLUDE_DELETED } from '../models/plugins/base.plugin.js';
import { restore, softDelete } from '../utils/soft-delete.util.js';
import { createLogger } from '../utils/logger.js';
import { productTypeService } from './productType.service.js';
import { tenantSettingsService } from './tenantSettings.service.js';
import { BusinessTemplate, StarterCategory, Translated } from '../types/productType.types.js';

const log = createLogger('CatalogCategory');

/**
 * Categories (design §3.2, §7.4, R11–R15b).
 *
 * Flat by default. When the Admin switches the category tree on
 * (`tenant_settings.category_mode = tree`), categories can have parents, up to
 * MAX_DEPTH levels. The data model is the same in both modes — flat simply
 * means no category has a parent.
 */

export const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,59}$/;
export const MAX_DEPTH = 5;

export type CategoryMode = 'flat' | 'tree';

export interface ExportFilter {
  search?: string;
  status?: 'all' | 'active' | 'hidden';
  includeDeleted?: boolean;
}

/** The columns of GET /catalog-categories/export, in order. */
export const EXPORT_COLUMNS = [
  'code',
  'name_en',
  'name_ta',
  'name_hi',
  'parent_code',
  'status',
  'sort_order',
  'visible_field_keys',
] as const;

/**
 * One CSV cell: always quoted, `"` doubled, so commas and newlines are safe. A
 * value that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, or a
 * leading tab / CR) is prefixed with `'` so it opens as text.
 */
export const csvCell = (value: unknown): string => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

/** Same match as the screen's search: code or any name, ignoring case. */
export const matchesSearch = (row: { code: string; name: Translated }, search: string) => {
  const q = search.trim().toLowerCase();
  return !q || [row.code, row.name?.en, row.name?.ta, row.name?.hi].some((s) => s?.toLowerCase().includes(q));
};

export const getCategoryMode = async (): Promise<CategoryMode> =>
  ((await tenantSettingsService.get()).category_mode as CategoryMode) ?? 'flat';

/* Products arrive in Phase 3 in `products_v2`; until then no category has any. */
const PRODUCTS_COLLECTION = 'products_v2';

const invalid = (message: string, field?: string) =>
  new AppError(message, 422, undefined, field ? { [field]: message } : undefined);
const conflict = (message: string) => new AppError(message, 409);

export interface CategoryInput {
  code: string;
  name: Translated;
  description?: Translated;
  parent_id?: string | null;
  visible_field_keys?: string[];
  icon?: string;
  color?: string;
  status?: 'active' | 'hidden';
}

export type CategoryPatch = Partial<Omit<CategoryInput, 'code'>> & { code?: string };

const clean = (t?: Translated): Translated | undefined =>
  t
    ? {
        en: t.en.trim(),
        ...(t.ta?.trim() ? { ta: t.ta.trim() } : {}),
        ...(t.hi?.trim() ? { hi: t.hi.trim() } : {}),
      }
    : undefined;

const plain = (d: any) => (typeof d?.toJSON === 'function' ? d.toJSON() : d);

/* ----------------------------------------------------------- helpers */

const liveById = async (id: string) => CatalogCategoryModel.findOne({ id });

const allLive = async () => (await CatalogCategoryModel.find().lean<any[]>()) as any[];

/** Every descendant id of a category (not including itself). */
const descendantsOf = (id: string, rows: { id: string; parent_id: string | null }[]): Set<string> => {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const r of rows) {
      if (r.parent_id === current && !out.has(r.id)) {
        out.add(r.id);
        stack.push(r.id);
      }
    }
  }
  return out;
};

/** Keys must exist in the product type and not be retired (R12). */
const assertVisibleKeys = async (keys: string[] | undefined) => {
  if (!keys?.length) return;
  const type = await productTypeService.getActive();
  if (!type) throw invalid('Choose a business category before limiting visible fields', 'visible_field_keys');
  const live = new Set(plain(type).fields.filter((f: any) => !f.deprecated).map((f: any) => f.key));
  const unknown = keys.filter((k) => !live.has(k));
  if (unknown.length) {
    throw invalid(`Unknown or retired attribute(s): ${unknown.join(', ')}`, 'visible_field_keys');
  }
  if (new Set(keys).size !== keys.length) throw invalid('Each attribute only once', 'visible_field_keys');
};

/** Levels from the root down to this category: a root is 1. */
const depthOf = (id: string, byId: Map<string, any>): number => {
  let depth = 0;
  const seen = new Set<string>();
  for (let c = byId.get(id); c && !seen.has(c.id); c = c.parent_id ? byId.get(c.parent_id) : undefined) {
    seen.add(c.id);
    depth++;
  }
  return depth;
};

/** Levels in a category's own subtree: a leaf is 1. */
const heightOf = (id: string, rows: any[]): number => {
  const children = rows.filter((r) => r.parent_id === id);
  return 1 + (children.length ? Math.max(...children.map((c) => heightOf(c.id, rows))) : 0);
};

const parentNeedsTree = () =>
  invalid('Sub-categories need the category tree — switch it on in Settings → Business & Products', 'parent_id');

const nextSortOrder = async (parent_id: string | null) => {
  const last = await CatalogCategoryModel.findOne({ parent_id }).sort({ sort_order: -1 }).lean<any>();
  return (last?.sort_order ?? 0) + 1;
};

/** Live products per category id (a product in several categories counts in each). */
const productCountsByCategory = async (): Promise<Map<string, number>> => {
  const db = mongoose.connection.db;
  if (!db) return new Map();
  const rows = await db
    .collection(PRODUCTS_COLLECTION)
    .aggregate<{ _id: string; n: number }>([{ $match: { is_deleted: false } }, { $unwind: '$category_ids' }, { $group: { _id: '$category_ids', n: { $sum: 1 } } }])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
};

const liveProductCount = async (categoryId: string) => {
  const db = mongoose.connection.db;
  if (!db) return 0;
  return db.collection(PRODUCTS_COLLECTION).countDocuments({ is_deleted: false, category_ids: categoryId });
};

/* ------------------------------------------------------- resolution */

interface TypeDefaults {
  keys: string[];
}

const typeDefaults = async (): Promise<TypeDefaults> => {
  const type = plain(await productTypeService.getActive());
  return {
    keys: (type?.fields ?? []).filter((f: any) => !f.deprecated).map((f: any) => f.key),
  };
};

/**
 * Walks up from a category to find the fields in force (R12): the nearest
 * non-empty `visible_field_keys`, else every attribute. Retired or deleted
 * attribute keys are dropped rather than failing the read.
 */
const resolve = (row: any, byId: Map<string, any>, defaults: TypeDefaults) => {
  let visible: string[] | null = null;
  const seen = new Set<string>();
  for (let c = row; c && !seen.has(c.id); c = c.parent_id ? byId.get(c.parent_id) : undefined) {
    seen.add(c.id);
    if (visible === null && c.visible_field_keys?.length) visible = c.visible_field_keys;
  }
  const live = new Set(defaults.keys);
  return {
    resolved_visible_field_keys: visible ? visible.filter((k) => live.has(k)) : defaults.keys,
  };
};

const view = (row: any, byId: Map<string, any>, defaults: TypeDefaults) => {
  /* fulfilment / tracking: left over on rows written before Phase 2b and not
     yet cleaned by the start-up migration — never part of a category now. */
  const { _id, fulfilment, tracking, ...rest } = row;
  return { ...rest, ...resolve(row, byId, defaults) };
};

const byOrder = (a: any, b: any) => a.sort_order - b.sort_order || a.name.en.localeCompare(b.name.en);

/* --------------------------------------------------------- service */

export const catalogCategoryService = {
  /**
   * Switches between a flat list and the tree (R11a).
   *
   * Flat → tree is always safe: every category simply starts at the top level.
   * Tree → flat is refused while any category still has a parent, so the
   * structure is never thrown away by accident (K16).
   */
  async assertCanSetMode(mode: CategoryMode) {
    if (mode === 'tree') return;
    const nested = await CatalogCategoryModel.countDocuments({ parent_id: { $ne: null } });
    if (nested) {
      throw conflict(
        `${nested} categor${nested === 1 ? 'y still has' : 'ies still have'} a parent — move them to the top level before switching the category tree off`
      );
    }
  },

  async setCategoryMode(mode: CategoryMode) {
    await this.assertCanSetMode(mode);
    await tenantSettingsService.update({ category_mode: mode });
    return mode;
  },

  /** `{ mode, categories }`. A category whose parent is missing or deleted is shown at the top level, flagged (never lost). */
  async list(includeDeleted = false) {
    return { mode: await getCategoryMode(), categories: await this.tree(includeDeleted) };
  },

  async tree(includeDeleted = false) {
    const rows = (await CatalogCategoryModel.find(includeDeleted ? { ...INCLUDE_DELETED } : {}).lean<any[]>()) as any[];
    const liveRows = rows.filter((r) => !r.is_deleted);
    const byId = new Map(liveRows.map((r) => [r.id, r]));
    const defaults = await typeDefaults();

    const counts = await productCountsByCategory();
    const nodes = new Map(
      rows.map((r) => [r.id, { ...view(r, byId, defaults), product_count: counts.get(r.id) ?? 0, children: [] as any[] }])
    );
    const roots: any[] = [];
    for (const r of rows) {
      const node = nodes.get(r.id)!;
      const parent = r.parent_id ? nodes.get(r.parent_id) : undefined;
      if (!r.parent_id) roots.push(node);
      else if (parent && !(parent.is_deleted && !r.is_deleted)) parent.children.push(node);
      else roots.push({ ...node, orphan: true });
    }
    const sortDeep = (list: any[]) => {
      list.sort(byOrder);
      list.forEach((n) => sortDeep(n.children));
      return list;
    };
    return sortDeep(roots);
  },

  /**
   * The CSV behind GET /catalog-categories/export: only the matching rows, in
   * the order the screen shows them (parents before their children).
   */
  async exportCsv(filter: ExportFilter = {}) {
    const roots = await this.tree(Boolean(filter.includeDeleted));
    const ordered: any[] = [];
    const walk = (nodes: any[]) =>
      nodes.forEach((n) => {
        ordered.push(n);
        walk(n.children);
      });
    walk(roots);

    const codeById = new Map(ordered.map((r) => [r.id, r.code]));
    const rows = ordered.filter(
      (r) =>
        matchesSearch(r, filter.search ?? '') &&
        (!filter.status || filter.status === 'all' || r.status === filter.status)
    );
    const lines = rows.map((r) =>
      [
        r.code,
        r.name?.en,
        r.name?.ta,
        r.name?.hi,
        r.parent_id ? codeById.get(r.parent_id) ?? '' : '',
        r.status,
        r.sort_order,
        (r.visible_field_keys ?? []).join('|'),
      ]
        .map(csvCell)
        .join(',')
    );
    return { csv: [EXPORT_COLUMNS.join(','), ...lines].join('\r\n'), count: rows.length };
  },

  /**
   * The category screen's KPI cards, from the new products (products_v2):
   * live categories; live items of live products filed in any category;
   * the category with the most products (share of categorised products);
   * and products per category on average.
   */
  async stats() {
    const db = mongoose.connection.db;
    const live = await allLive();
    const counts = await productCountsByCategory();
    const liveCounts = live.map((c) => ({ c, n: counts.get(c.id) ?? 0 }));
    const categorised = db
      ? await db.collection(PRODUCTS_COLLECTION).find({ is_deleted: false, 'category_ids.0': { $exists: true } }, { projection: { id: 1 } }).toArray()
      : [];
    const assigned_skus = db && categorised.length
      ? await db.collection('product_items').countDocuments({ is_deleted: false, product_id: { $in: categorised.map((p) => p.id) } })
      : 0;
    const top = liveCounts.sort((a, b) => b.n - a.n)[0];
    const assignments = liveCounts.reduce((sum, x) => sum + x.n, 0);
    return {
      total_categories: live.length,
      assigned_skus,
      categorised_products: categorised.length,
      top_distribution:
        top && top.n
          ? { id: top.c.id, code: top.c.code, name: top.c.name, count: top.n, percentage: Math.round((top.n / categorised.length) * 100) }
          : null,
      average_per_category: live.length ? Math.round((assignments / live.length) * 10) / 10 : 0,
    };
  },

  async get(id: string) {
    const row = await CatalogCategoryModel.findOne({ id, ...INCLUDE_DELETED }).lean<any>();
    if (!row) throw new AppError('Category not found', 404);
    const rows = await allLive();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const defaults = await typeDefaults();

    const ancestors: any[] = [];
    const seen = new Set<string>([row.id]);
    for (let p = row.parent_id ? byId.get(row.parent_id) : undefined; p && !seen.has(p.id); p = p.parent_id ? byId.get(p.parent_id) : undefined) {
      seen.add(p.id);
      ancestors.unshift({ id: p.id, code: p.code, name: p.name });
    }
    const children = rows.filter((r) => r.parent_id === row.id).sort(byOrder).map((r) => ({ id: r.id, code: r.code, name: r.name }));
    return { ...view(row, byId, defaults), ancestors, children };
  },

  async create(input: CategoryInput) {
    const code = input.code.trim().toLowerCase();
    if (!CODE_PATTERN.test(code)) {
      throw invalid('Code: 2–60 characters, lowercase letters, digits, "-" or "_", starting with a letter or digit', 'code');
    }
    if (await CatalogCategoryModel.exists({ code })) throw conflict(`A category with the code "${code}" already exists`);

    const parent_id = input.parent_id || null;
    if (parent_id) {
      if ((await getCategoryMode()) === 'flat') throw parentNeedsTree();
      if (!(await liveById(parent_id))) throw invalid('The parent category does not exist', 'parent_id');
      const rows = await allLive();
      if (depthOf(parent_id, new Map(rows.map((r) => [r.id, r]))) + 1 > MAX_DEPTH) {
        throw invalid(`Categories can be at most ${MAX_DEPTH} levels deep`, 'parent_id');
      }
    }
    await assertVisibleKeys(input.visible_field_keys);

    const doc = await CatalogCategoryModel.create({
      code,
      name: clean(input.name),
      ...(input.description ? { description: clean(input.description) } : {}),
      parent_id,
      visible_field_keys: input.visible_field_keys ?? [],
      sort_order: await nextSortOrder(parent_id),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      status: input.status ?? 'active',
    });
    return this.get(doc.id);
  },

  async update(id: string, patch: CategoryPatch) {
    const current = await liveById(id);
    if (!current) throw new AppError('Category not found', 404);
    if (patch.code !== undefined && patch.code.trim().toLowerCase() !== current.code) {
      throw conflict('A category code cannot be changed — it is how other records refer to it');
    }

    const set: Record<string, unknown> = {};
    if (patch.name) set.name = clean(patch.name);
    if (patch.description !== undefined) set.description = clean(patch.description);
    if (patch.icon !== undefined) set.icon = patch.icon;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.visible_field_keys !== undefined) {
      await assertVisibleKeys(patch.visible_field_keys);
      set.visible_field_keys = patch.visible_field_keys;
    }

    if (patch.parent_id !== undefined && (patch.parent_id || null) !== current.parent_id) {
      const parent_id = patch.parent_id || null;
      if (parent_id) {
        if ((await getCategoryMode()) === 'flat') throw parentNeedsTree();
        if (parent_id === id) throw invalid('A category cannot be its own parent', 'parent_id');
        if (!(await liveById(parent_id))) throw invalid('The parent category does not exist', 'parent_id');
        const rows = await allLive();
        if (descendantsOf(id, rows).has(parent_id)) {
          throw invalid('A category cannot be moved under one of its own sub-categories', 'parent_id');
        }
        const byId = new Map(rows.map((r) => [r.id, r]));
        if (depthOf(parent_id, byId) + heightOf(id, rows) > MAX_DEPTH) {
          throw invalid(`Categories can be at most ${MAX_DEPTH} levels deep`, 'parent_id');
        }
      }
      set.parent_id = parent_id;
      set.sort_order = await nextSortOrder(parent_id);
    }

    if (Object.keys(set).length) await CatalogCategoryModel.updateOne({ id }, { $set: set });
    return this.get(id);
  },

  /** Sets the order of one parent's children from the full list of their ids. */
  async reorder(parent_id: string | null, ids: string[]) {
    const siblings = (await CatalogCategoryModel.find({ parent_id: parent_id || null }).lean<any[]>()) as any[];
    const expected = siblings.map((s) => s.id).sort().join();
    if (ids.length !== siblings.length || new Set(ids).size !== ids.length || [...ids].sort().join() !== expected) {
      throw invalid('Send every sub-category of that parent exactly once', 'ids');
    }
    /* One update per row so the audit hook stamps updated_by on each. */
    for (const [i, id] of ids.entries()) {
      await CatalogCategoryModel.updateOne({ id }, { $set: { sort_order: i + 1 } });
    }
    return this.list();
  },

  async remove(id: string) {
    const current = await liveById(id);
    if (!current) throw new AppError('Category not found', 404);
    const children = await CatalogCategoryModel.find({ parent_id: id }).lean<any[]>();
    if (children.length) {
      throw conflict(`Has live sub-categories (${children.map((c: any) => c.name.en).join(', ')}) — move or delete them first`);
    }
    const products = await liveProductCount(id);
    if (products) throw conflict(`${products} product(s) are in this category — move them first`);
    await softDelete(CatalogCategoryModel, id);
    return { id };
  },

  async restore(id: string) {
    const row = await CatalogCategoryModel.findOne({ id, ...INCLUDE_DELETED }).lean<any>();
    if (!row) throw new AppError('Category not found', 404);
    if (!row.is_deleted) return this.get(id);
    if (row.parent_id) {
      const parent = await CatalogCategoryModel.findOne({ id: row.parent_id, ...INCLUDE_DELETED }).lean<any>();
      if (!parent || parent.is_deleted) {
        throw conflict(`Restore its parent "${parent?.name?.en ?? 'unknown'}" first`);
      }
    }
    if (await CatalogCategoryModel.exists({ code: row.code })) {
      throw conflict(`Another live category now uses the code "${row.code}"`);
    }
    await restore(CatalogCategoryModel, id);
    return this.get(id);
  },

  /**
   * Creates a template's starter categories (the "Create starter categories"
   * option in Settings). Codes that already exist are skipped, so running it
   * twice does nothing new.
   */
  async createStarterCategories(template: BusinessTemplate) {
    const created: string[] = [];
    const skipped: string[] = [];
    const defaults = await typeDefaults();
    const live = new Set(defaults.keys);
    /* Flat mode: the template's tree is created flattened (K17). */
    const flat = (await getCategoryMode()) === 'flat';

    const walk = async (items: StarterCategory[], parent_id: string | null) => {
      for (const c of items) {
        let row = await CatalogCategoryModel.findOne({ code: c.code }).lean<any>();
        if (row) {
          skipped.push(c.code);
        } else {
          const doc = await CatalogCategoryModel.create({
            code: c.code,
            name: c.name,
            parent_id,
            /* Only keys the type actually has — a template may be ahead of the tenant's type. */
            visible_field_keys: (c.visible_field_keys ?? []).filter((k) => live.has(k)),
            sort_order: await nextSortOrder(parent_id),
          });
          row = doc.toJSON();
          created.push(c.code);
        }
        if (c.children?.length) await walk(c.children, flat ? null : row.id);
      }
    };
    await walk(template.starter_categories, null);
    if (created.length) log.log(`Starter categories created: ${created.join(', ')}`);
    return { created, skipped };
  },
};
