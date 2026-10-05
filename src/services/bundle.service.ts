import { AppError } from '../middlewares/errorHandler.js';
import { BundleComponentModel } from '../models/BundleComponent.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { ProductV2Model } from '../models/ProductV2.model.js';
import { newId } from '../utils/id.util.js';
import { withTransaction } from '../utils/transaction.util.js';
import { availabilityFor } from './availability.service.js';

/**
 * Bundle components (design §3.5, §6.2 `bundle_components`; plan 4.2).
 *
 * Only items of products marked `is_bundle` take components. A component is a
 * normal item of any product: not the bundle itself, not another bundle (no
 * nesting) and not a pack (use its base item × quantity). Quantity is a whole
 * number ≥ 1. The list is replaced as a whole, atomically.
 */

const invalid = (message: string, field?: string) => new AppError(message, 422, undefined, field ? { [field]: message } : undefined);
const MAX_COMPONENTS = 50;

const bundleItem = async (itemId: string) => {
  const item = await ProductItemModel.findOne({ id: itemId }).lean<any>();
  if (!item) throw new AppError('Item not found', 404);
  const product = await ProductV2Model.findOne({ id: item.product_id }).lean<any>();
  if (!product) throw new AppError('Product not found', 404);
  return { item, product };
};

export const bundleService = {
  async list(bundleItemId: string) {
    const { item, product } = await bundleItem(bundleItemId);
    const rows = await BundleComponentModel.find({ bundle_item_id: bundleItemId }).sort({ created_at: 1 }).lean<any[]>();
    const comps = await ProductItemModel.find({ id: { $in: rows.map((r) => r.component_item_id) } }).lean<any[]>();
    const products = await ProductV2Model.find({ id: { $in: [...new Set(comps.map((c) => c.product_id))] } }).lean<any[]>();
    const availability = await availabilityFor([bundleItemId, ...comps.map((c) => c.id)]);
    return {
      bundle_item_id: bundleItemId,
      sku: item.sku,
      is_bundle: Boolean(product.is_bundle),
      components: rows.map((r) => {
        const c = comps.find((x) => x.id === r.component_item_id);
        const p = c && products.find((x) => x.id === c.product_id);
        return {
          component_item_id: r.component_item_id,
          quantity: r.quantity,
          sku: c?.sku ?? null,
          product_id: c?.product_id ?? null,
          product_name: p?.name?.en ?? null,
          availability: c ? availability.get(c.id) ?? null : null,
        };
      }),
      availability: availability.get(bundleItemId) ?? null,
    };
  },

  /** Replaces the whole list (an empty list clears it). */
  async replace(bundleItemId: string, components: { component_item_id: string; quantity: number }[]) {
    const { item, product } = await bundleItem(bundleItemId);
    if (!product.is_bundle) throw invalid(`${product.name?.en ?? 'This product'} is not a bundle — mark it as a bundle first`, 'is_bundle');
    if (item.pack_of) throw invalid('A pack cannot be a bundle', 'bundle_item_id');
    if (components.length > MAX_COMPONENTS) throw invalid(`At most ${MAX_COMPONENTS} components`, 'components');

    const ids = components.map((c) => c.component_item_id);
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice) throw invalid('An item is listed twice — set its quantity instead', 'components');
    const comps = await ProductItemModel.find({ id: { $in: ids } }).lean<any[]>();
    const compProducts = await ProductV2Model.find({ id: { $in: [...new Set(comps.map((c) => c.product_id))] } }).lean<any[]>();
    components.forEach((c, i) => {
      const at = `components.${i}`;
      if (!Number.isInteger(c.quantity) || c.quantity < 1) throw invalid('Quantity must be a whole number of 1 or more', `${at}.quantity`);
      if (c.component_item_id === bundleItemId) throw invalid('A bundle cannot contain itself', at);
      const comp = comps.find((x) => x.id === c.component_item_id);
      if (!comp) throw invalid('That item does not exist (or is deleted)', at);
      if (comp.pack_of) throw invalid(`${comp.sku} is a pack — add its base item × ${comp.pack_of.quantity} instead`, at);
      if (compProducts.find((p) => p.id === comp.product_id)?.is_bundle) throw invalid(`${comp.sku} is itself a bundle — bundles cannot be nested`, at);
    });

    const at = new Date();
    const before = await BundleComponentModel.find({ bundle_item_id: bundleItemId }).lean<any[]>();
    await withTransaction(async (tx) => {
      await BundleComponentModel.updateMany({ bundle_item_id: bundleItemId }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
      tx.undo(() => BundleComponentModel.collection.updateMany({ id: { $in: before.map((b) => b.id) } }, { $set: { is_deleted: false, deleted_at: null } }));
      for (const c of components) {
        const id = newId();
        await BundleComponentModel.create([{ id, bundle_item_id: bundleItemId, component_item_id: c.component_item_id, quantity: c.quantity }], { session: tx.session });
        tx.undo(() => BundleComponentModel.collection.deleteOne({ id }));
      }
    });
    return this.list(bundleItemId);
  },
};

/** Live bundles that use any of these items as a component (delete guards). */
export const bundlesUsing = async (itemIds: string[]) => {
  if (!itemIds.length) return [];
  const rows = await BundleComponentModel.find({ component_item_id: { $in: itemIds } }).lean<any[]>();
  if (!rows.length) return [];
  const bundles = await ProductItemModel.find({ id: { $in: [...new Set(rows.map((r) => r.bundle_item_id))] } }).lean<any[]>();
  return bundles;
};
