import { AppError } from '../../middlewares/errorHandler.js';
import { CatalogCategoryModel } from '../models.js';
import type { CatalogCategory, CommerceConfig } from '../types.js';

/**
 * The category tree, and the commerce config a product inherits from it.
 *
 * Commerce lives on a category rather than a product because it describes how
 * a business sells a whole class of thing: "cars are quoted on request with a
 * lead time" is true of every car, and repeating it per product guarantees it
 * will eventually disagree with itself.
 */

export const DEFAULT_COMMERCE: CommerceConfig = {
  pricing: { model: 'fixed', currency: 'INR' },
  availability: { model: 'quantity' },
};

export const loadAllCategories = async (): Promise<CatalogCategory[]> =>
  (await CatalogCategoryModel.find().lean()) as unknown as CatalogCategory[];

/**
 * A category and every ancestor, nearest first.
 *
 * Cycle-guarded: a parent reassignment can otherwise produce a loop that hangs
 * the request rather than returning an error.
 */
export const ancestorChain = (
  categoryId: string,
  all: CatalogCategory[]
): CatalogCategory[] => {
  const byId = new Map(all.map((c) => [c.id, c]));
  const chain: CatalogCategory[] = [];
  const seen = new Set<string>();

  let cursor: string | null | undefined = categoryId;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    chain.push(node);
    cursor = node.parentId ?? null;
  }
  return chain;
};

/** A category and all of its descendants — what "filter by Electronics" means. */
export const descendantIds = (categoryId: string, all: CatalogCategory[]): string[] => {
  const children = new Map<string, string[]>();
  for (const c of all) {
    const parent = c.parentId ?? '__root__';
    children.set(parent, [...(children.get(parent) ?? []), c.id]);
  }

  const out: string[] = [];
  const queue = [categoryId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
};

/**
 * The nearest declared commerce config walking up the tree.
 *
 * Inheritance means a tenant configures "Vehicles" once and every subcategory
 * beneath it behaves the same until one deliberately overrides it.
 */
export const resolveCommerce = (
  categoryIds: string[],
  all: CatalogCategory[]
): CommerceConfig => {
  for (const id of categoryIds) {
    for (const node of ancestorChain(id, all)) {
      if (node.commerce?.pricing?.model) return node.commerce;
    }
  }
  return DEFAULT_COMMERCE;
};

/** The nearest declared type id, same walk. */
export const resolveTypeId = (
  categoryIds: string[],
  all: CatalogCategory[]
): string | undefined => {
  for (const id of categoryIds) {
    for (const node of ancestorChain(id, all)) {
      if (node.typeId) return node.typeId;
    }
  }
  return undefined;
};

export interface CategoryNode extends CatalogCategory {
  children: CategoryNode[];
}

/** Flat rows to a nested tree. Orphans are surfaced at the root, never dropped. */
export const buildTree = (all: CatalogCategory[]): CategoryNode[] => {
  const nodes = new Map<string, CategoryNode>(
    all.map((c) => [c.id, { ...c, children: [] as CategoryNode[] }])
  );
  const roots: CategoryNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (list: CategoryNode[]): CategoryNode[] => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((n) => sortRec(n.children));
    return list;
  };
  return sortRec(roots);
};

/**
 * Refuses a parent change that would create a cycle.
 *
 * Without this, setting A's parent to its own child detaches the pair from the
 * root: they vanish from the tree and every walk over them loops.
 */
export const assertNoCycle = (
  categoryId: string,
  newParentId: string | null | undefined,
  all: CatalogCategory[]
): void => {
  if (!newParentId) return;
  if (newParentId === categoryId) {
    throw new AppError('A category cannot be its own parent', 422);
  }
  if (descendantIds(categoryId, all).includes(newParentId)) {
    throw new AppError('That parent sits beneath this category — the move would create a loop', 422);
  }
};
