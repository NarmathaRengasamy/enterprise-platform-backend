import { ProductV2Model } from '../models/ProductV2.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { ItemStockModel } from '../models/ItemStock.model.js';

/**
 * The products list KPIs (Oct 2026): the whole catalogue, not the current
 * page or filter — like the category screen's figures.
 *
 *   products    live products by status (a Viewer: active ones only)
 *   variants    their items: normal ones, active ones, packs
 *   stock       active, tracked, normal items (not packs, not bundle items):
 *               out of stock = available ≤ 0; low = at or below the reorder point
 *   not_priced  active items (packs included) with no price
 */

export interface ProductStats {
  products: { total: number; active: number; draft: number; archived: number };
  variants: { total: number; active: number; packs: number };
  stock: { tracked: number; low: number; out: number };
  not_priced: number;
}

export const productStatsService = {
  async stats(opts: { viewer: boolean }): Promise<ProductStats> {
    const scope: Record<string, unknown> = opts.viewer ? { status: 'active' } : {};
    const products = await ProductV2Model.find(scope, { _id: 0, id: 1, status: 1, track_inventory: 1, is_bundle: 1 }).lean<any[]>();
    const byStatus = (s: string) => products.filter((p) => p.status === s).length;
    const productById = new Map(products.map((p) => [p.id, p]));

    const items = products.length
      ? await ProductItemModel.find(
          { product_id: { $in: products.map((p) => p.id) } },
          { _id: 0, id: 1, product_id: 1, status: 1, pack_of: 1, price: 1, track_inventory: 1 }
        ).lean<any[]>()
      : [];
    const normal = items.filter((i) => !i.pack_of);
    const active = items.filter((i) => i.status === 'active');

    /* Stock: active, tracked items that hold stock of their own. */
    const holders = active.filter((i) => {
      if (i.pack_of) return false;
      const p = productById.get(i.product_id);
      return p && !p.is_bundle && Boolean(i.track_inventory ?? p.track_inventory);
    });
    const rows = holders.length
      ? await ItemStockModel.aggregate([
          { $match: { item_id: { $in: holders.map((i) => i.id) }, is_deleted: false } },
          { $group: { _id: '$item_id', on_hand: { $sum: '$on_hand' }, reserved: { $sum: '$reserved' }, reorder_point: { $sum: '$reorder_point' } } },
        ])
      : [];
    const stockOf = new Map(rows.map((r: any) => [r._id, r]));
    let low = 0;
    let out = 0;
    for (const i of holders) {
      const r: any = stockOf.get(i.id);
      const available = (r?.on_hand ?? 0) - (r?.reserved ?? 0);
      if (available <= 0) out++;
      else if ((r?.reorder_point ?? 0) > 0 && available <= r.reorder_point) low++;
    }

    return {
      products: { total: products.length, active: byStatus('active'), draft: byStatus('draft'), archived: byStatus('archived') },
      variants: { total: normal.length, active: normal.filter((i) => i.status === 'active').length, packs: items.length - normal.length },
      stock: { tracked: holders.length, low, out },
      not_priced: active.filter((i) => typeof i.price?.amount_minor !== 'number').length,
    };
  },
};
