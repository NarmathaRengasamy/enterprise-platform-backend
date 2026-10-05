import { ItemStockModel } from '../models/ItemStock.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { ProductV2Model } from '../models/ProductV2.model.js';
import { BundleComponentModel } from '../models/BundleComponent.model.js';

/**
 * Availability — the one place it is worked out (design §3.5, R29, R31, R48).
 *
 *   normal item, Track inventory off → "not tracked" (always available, never "out of stock")
 *   normal item, on                  → Σ (on_hand − reserved) over its stock rows; low_stock vs reorder_point
 *   pack (R48)                       → per location ⌊base available ÷ quantity⌋, summed; follows the base's Track inventory
 *   bundle item                      → min over components of ⌊component available ÷ quantity⌋;
 *                                       "not tracked" if any component is (or it has no components yet)
 *
 * Packs and bundles share `derivedAvailable`.
 */

export type Availability =
  | { status: 'not_tracked' }
  | {
      status: 'tracked';
      on_hand: number;
      reserved: number;
      available: number;
      reorder_point?: number;
      low_stock?: boolean;
      /** Worked out from another item's stock: a pack's base, or a bundle's components. */
      from?: 'pack' | 'bundle';
    };

export const NOT_TRACKED: Availability = Object.freeze({ status: 'not_tracked' }) as Availability;

interface StockRow {
  item_id: string;
  location_id?: string;
  on_hand?: number;
  reserved?: number;
  reorder_point?: number;
}

/** A tracked normal item: its rows added up (no rows yet = 0). */
export const rowsAvailability = (rows: StockRow[]): Availability => {
  const on_hand = rows.reduce((n, r) => n + (r.on_hand ?? 0), 0);
  const reserved = rows.reduce((n, r) => n + (r.reserved ?? 0), 0);
  const reorder_point = rows.reduce((n, r) => n + (r.reorder_point ?? 0), 0);
  const available = on_hand - reserved;
  return { status: 'tracked', on_hand, reserved, available, reorder_point, low_stock: reorder_point > 0 && available <= reorder_point };
};

/**
 * Shared by packs and bundles: each part can make ⌊available ÷ quantity⌋ and
 * the smallest wins. `null` available = a part that is not tracked → null.
 */
export const derivedAvailable = (parts: { available: number | null; quantity: number }[]): number | null => {
  if (!parts.length || parts.some((p) => p.available === null)) return null;
  return Math.min(...parts.map((p) => Math.floor(Math.max(0, p.available as number) / p.quantity)));
};

const derived = (available: number, from: 'pack' | 'bundle'): Availability => ({ status: 'tracked', on_hand: available, reserved: 0, available, from });

/** A pack (R48): per location, then added up — a box of 4 never borrows across locations. */
export const packAvailability = (baseTracked: boolean, baseRows: StockRow[], quantity: number): Availability => {
  if (!baseTracked) return NOT_TRACKED;
  const available = baseRows.reduce((n, r) => n + (derivedAvailable([{ available: (r.on_hand ?? 0) - (r.reserved ?? 0), quantity }]) ?? 0), 0);
  return derived(available, 'pack');
};

const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));

/**
 * Availability for many items at once (a product's items, a search page, a
 * bundle's components) in a handful of queries. Unknown or deleted ids are
 * left out of the map.
 */
export const availabilityFor = async (itemIds: string[]): Promise<Map<string, Availability>> => {
  const out = new Map<string, Availability>();
  if (!itemIds.length) return out;
  const items = await ProductItemModel.find({ id: { $in: [...new Set(itemIds)] } }).lean<any[]>();

  /* Bases of packs, and the components of bundle items. */
  const baseIds = items.filter((i) => i.pack_of).map((i) => i.pack_of.base_item_id);
  const productIds = new Set(items.map((i) => i.product_id));
  const products0 = await ProductV2Model.find({ id: { $in: [...productIds] } }).lean<any[]>();
  const bundleProductIds = new Set(products0.filter((p) => p.is_bundle).map((p) => p.id));
  const bundleItemIds = items.filter((i) => !i.pack_of && bundleProductIds.has(i.product_id)).map((i) => i.id);
  const components = bundleItemIds.length ? await BundleComponentModel.find({ bundle_item_id: { $in: bundleItemIds } }).lean<any[]>() : [];

  const extraIds = [...baseIds, ...components.map((c) => c.component_item_id)].filter((x) => !items.some((i) => i.id === x));
  const extra = extraIds.length ? await ProductItemModel.find({ id: { $in: [...new Set(extraIds)] } }).lean<any[]>() : [];
  const allItems = byId([...items, ...extra]);
  const moreProductIds = extra.map((i) => i.product_id).filter((id) => !productIds.has(id));
  const products = byId([...products0, ...(moreProductIds.length ? await ProductV2Model.find({ id: { $in: [...new Set(moreProductIds)] } }).lean<any[]>() : [])]);

  /* Only normal items carry stock rows. */
  const stockIds = [...allItems.values()].filter((i) => !i.pack_of).map((i) => i.id);
  const rows = await ItemStockModel.find({ item_id: { $in: stockIds } }).lean<any[]>();
  const rowsOf = new Map<string, StockRow[]>();
  for (const r of rows) rowsOf.set(r.item_id, [...(rowsOf.get(r.item_id) ?? []), r]);

  const tracked = (item: any) => {
    const p = products.get(item.product_id);
    return Boolean(item.track_inventory ?? p?.track_inventory);
  };
  const normal = (item: any): Availability => (tracked(item) ? rowsAvailability(rowsOf.get(item.id) ?? []) : NOT_TRACKED);

  const componentsOf = new Map<string, any[]>();
  for (const c of components) componentsOf.set(c.bundle_item_id, [...(componentsOf.get(c.bundle_item_id) ?? []), c]);

  for (const item of items) {
    if (item.pack_of) {
      const base = allItems.get(item.pack_of.base_item_id);
      out.set(item.id, base ? packAvailability(tracked(base), rowsOf.get(base.id) ?? [], item.pack_of.quantity) : derived(0, 'pack'));
    } else if (bundleProductIds.has(item.product_id)) {
      const parts = (componentsOf.get(item.id) ?? []).map((c) => {
        const comp = allItems.get(c.component_item_id);
        /* A component that no longer exists makes nothing. */
        if (!comp) return { available: 0, quantity: c.quantity };
        const a = normal(comp);
        return { available: a.status === 'tracked' ? a.available : null, quantity: c.quantity };
      });
      const available = derivedAvailable(parts);
      out.set(item.id, available === null ? NOT_TRACKED : derived(available, 'bundle'));
    } else {
      out.set(item.id, normal(item));
    }
  }
  return out;
};

/**
 * A product's total (list card, details header): its active items that hold or
 * make stock — packs are left out, so a box of 4 is never counted on top of its
 * singles. None tracked → "not tracked".
 */
export type ProductAvailability = { status: 'not_tracked' } | { status: 'tracked'; available: number };

export const productAvailability = (items: { id: string; status: string; pack_of?: unknown }[], byItem: Map<string, Availability>): ProductAvailability => {
  const counted = items
    .filter((i) => i.status === 'active' && !i.pack_of)
    .map((i) => byItem.get(i.id))
    .filter((a): a is Extract<Availability, { status: 'tracked' }> => a?.status === 'tracked');
  if (!counted.length) return { status: 'not_tracked' };
  return { status: 'tracked', available: counted.reduce((n, a) => n + a.available, 0) };
};
