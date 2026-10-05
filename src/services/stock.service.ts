import { AppError } from '../middlewares/errorHandler.js';
import { ItemStockModel } from '../models/ItemStock.model.js';
import { StockMovementModel, MovementSource } from '../models/StockMovement.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { ProductV2Model } from '../models/ProductV2.model.js';
import { newId } from '../utils/id.util.js';
import { Tx, withTransaction } from '../utils/transaction.util.js';
import { createLogger } from '../utils/logger.js';
import { productTypeService } from './productType.service.js';
import { availabilityFor, Availability } from './availability.service.js';

const log = createLogger('Stock');

/**
 * Stock (design §3.5, R28–R31a; plan Phase 4).
 *
 * Stock only changes by atomic +/− adjustments that can never take `on_hand`
 * below 0 (R30): a guarded `$inc` either applies or matches nothing, so two
 * people taking the last units at once cannot both succeed. Every change writes
 * a `stock_movements` row in the same transaction (real on a replica set;
 * ordered writes with clean-up on standalone — utils/transaction.util).
 *
 * Who holds stock: a normal item whose Track inventory is on. Not a pack (its
 * base does, R48), not a bundle item (its components do), and for serial
 * tracking the units drive it (adding / selling units, not manual adjusts).
 */

export const DEFAULT_LOCATION = 'default';

const conflict = (message: string) => new AppError(message, 409);
const notFound = (what = 'Item') => new AppError(`${what} not found`, 404);

export interface StockContext {
  item: any;
  product: any;
  /** The item's Track inventory (item → product). For a pack: its base's. */
  tracked: boolean;
  /** The product's tracking when tracked (product → type default), else 'none'. */
  tracking: 'none' | 'batch' | 'serial';
  base?: any;
}

/** The item with what decides its stock: product, Track inventory, tracking. */
export const stockContext = async (itemId: string): Promise<StockContext> => {
  const item = await ProductItemModel.findOne({ id: itemId }).lean<any>();
  if (!item) throw notFound();
  const product = await ProductV2Model.findOne({ id: item.product_id }).lean<any>();
  if (!product) throw notFound('Product');
  const type: any = await productTypeService.getActive();
  const base = item.pack_of ? await ProductItemModel.findOne({ id: item.pack_of.base_item_id }).lean<any>() : undefined;
  const holder = base ?? item;
  const tracked = Boolean(holder.track_inventory ?? product.track_inventory);
  const tracking = tracked ? (product.tracking ?? type?.tracking ?? 'none') : 'none';
  return { item, product, tracked, tracking, base: base ?? undefined };
};

/**
 * One +/− change to one stock row, and its movement, inside `tx`.
 * Negative deltas are guarded (`on_hand ≥ −delta`); the first positive change
 * creates the row. Refused → 409 with the real count.
 */
export const applyDelta = async (
  tx: Tx,
  m: { item_id: string; location_id?: string; delta: number; reason: string; source: MovementSource; label?: string }
): Promise<any> => {
  const location_id = m.location_id ?? DEFAULT_LOCATION;
  const { item_id, delta } = m;
  const guard = delta < 0 ? { on_hand: { $gte: -delta } } : {};
  let row = await ItemStockModel.findOneAndUpdate({ item_id, location_id, ...guard }, { $inc: { on_hand: delta } }, { new: true, session: tx.session }).lean<any>();
  if (row) {
    const id = row.id;
    tx.undo(() => ItemStockModel.collection.updateOne({ id }, { $inc: { on_hand: -delta } }));
  } else if (delta < 0) {
    const current = await ItemStockModel.findOne({ item_id, location_id }).session(tx.session ?? null).lean<any>();
    throw conflict(`Only ${current?.on_hand ?? 0} in stock${m.label ? ` for ${m.label}` : ''} — cannot take out ${-delta}`);
  } else {
    const id = newId();
    try {
      const [doc] = await ItemStockModel.create([{ id, item_id, location_id, on_hand: delta }], { session: tx.session });
      row = doc.toJSON();
      tx.undo(() => ItemStockModel.collection.deleteOne({ id }));
    } catch (e: any) {
      /* Someone created the row at the same moment. In a transaction the attempt is spent — ask to retry. */
      if (e?.code !== 11000 || tx.session) throw e?.code === 11000 ? conflict('The stock changed at the same moment — try again') : e;
      row = await ItemStockModel.findOneAndUpdate({ item_id, location_id }, { $inc: { on_hand: delta } }, { new: true }).lean<any>();
      const rowId = row.id;
      tx.undo(() => ItemStockModel.collection.updateOne({ id: rowId }, { $inc: { on_hand: -delta } }));
    }
  }
  const movementId = newId();
  await StockMovementModel.create(
    [{ id: movementId, item_id, location_id, delta, reason: m.reason, on_hand_after: row.on_hand, source: m.source }],
    { session: tx.session }
  );
  tx.undo(() => StockMovementModel.collection.deleteOne({ id: movementId }));
  return row;
};

/** Why this item takes no manual adjustment (409), or null when it may. */
const adjustRefusal = (ctx: StockContext): string | null => {
  const sku = ctx.item.sku;
  if (ctx.item.pack_of) return `${sku} is a pack of ${ctx.item.pack_of.quantity} — adjust the base item${ctx.base ? ` (${ctx.base.sku})` : ''} instead`;
  if (ctx.product.is_bundle) return `${sku} is a bundle — it has no stock of its own; adjust its components instead`;
  if (!ctx.tracked) return `Not tracked: ${sku} has Track inventory off, so it has no stock to adjust`;
  if (ctx.tracking === 'serial') return `${sku} is tracked by serial number — add or sell units instead`;
  return null;
};

export const stockService = {
  /** Rows, availability and what kind of item this is. Any signed-in role. */
  async get(itemId: string) {
    const ctx = await stockContext(itemId);
    const availability = (await availabilityFor([itemId])).get(itemId) as Availability;
    const holds = !ctx.item.pack_of && !ctx.product.is_bundle && ctx.tracked;
    const rows = holds ? await ItemStockModel.find({ item_id: itemId }).sort({ location_id: 1 }).lean<any[]>() : [];
    return {
      item_id: itemId,
      sku: ctx.item.sku,
      product_id: ctx.product.id,
      kind: ctx.item.pack_of ? 'pack' : ctx.product.is_bundle ? 'bundle' : 'item',
      track_inventory: ctx.tracked,
      tracking: ctx.tracking,
      /** Whether a manual adjustment is allowed here, and if not, why. */
      can_adjust: adjustRefusal(ctx) === null,
      adjust_note: adjustRefusal(ctx),
      ...(ctx.item.pack_of ? { pack_of: { ...ctx.item.pack_of, base_sku: ctx.base?.sku ?? null } } : {}),
      rows: rows.map(({ _id, ...r }) => ({
        location_id: r.location_id,
        on_hand: r.on_hand,
        reserved: r.reserved,
        available: r.on_hand - r.reserved,
        reorder_point: r.reorder_point,
      })),
      availability,
    };
  },

  /** A manual +/− with a reason (Admin / Editor). */
  async adjust(itemId: string, input: { delta: number; reason: string; location_id?: string }) {
    const ctx = await stockContext(itemId);
    const refusal = adjustRefusal(ctx);
    if (refusal) throw conflict(refusal);
    await withTransaction((tx) =>
      applyDelta(tx, { item_id: itemId, location_id: input.location_id, delta: input.delta, reason: input.reason.trim(), source: 'adjust', label: ctx.item.sku })
    );
    log.log(`Stock ${input.delta > 0 ? '+' : ''}${input.delta} on ${ctx.item.sku}: ${input.reason.trim()}`);
    return this.get(itemId);
  },

  /** Low-stock threshold for one location (0 = no warning). */
  async setReorderPoint(itemId: string, input: { reorder_point: number; location_id?: string }) {
    const ctx = await stockContext(itemId);
    if (ctx.item.pack_of || ctx.product.is_bundle || !ctx.tracked) {
      throw conflict(`${ctx.item.sku} has no stock of its own${ctx.item.pack_of ? ' (a pack — set it on the base item)' : ctx.product.is_bundle ? ' (a bundle)' : ' (Track inventory is off)'}`);
    }
    const location_id = input.location_id ?? DEFAULT_LOCATION;
    const row = await ItemStockModel.findOneAndUpdate({ item_id: itemId, location_id }, { $set: { reorder_point: input.reorder_point } }, { new: true }).lean();
    if (!row) await ItemStockModel.create({ id: newId(), item_id: itemId, location_id, on_hand: 0, reorder_point: input.reorder_point });
    return this.get(itemId);
  },

  /** The history, newest first. */
  async movements(itemId: string, opts: { page?: number; limit?: number } = {}) {
    const item = await ProductItemModel.findOne({ id: itemId }).lean<any>();
    if (!item) throw notFound();
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
    const [rows, total] = await Promise.all([
      StockMovementModel.find({ item_id: itemId }).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean<any[]>(),
      StockMovementModel.countDocuments({ item_id: itemId }),
    ]);
    return {
      items: rows.map(({ _id, is_deleted, deleted_at, ...m }) => m),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  },

  /**
   * For orders later (R48, design §12.4): selling `count` packs takes
   * count × quantity from the base in ONE guarded step — refused (409) when
   * there is not enough, never partly applied. Untracked base: nothing to take.
   */
  async sellPack(packItemId: string, count = 1, location_id = DEFAULT_LOCATION) {
    const ctx = await stockContext(packItemId);
    if (!ctx.item.pack_of || !ctx.base) throw new AppError(`${ctx.item.sku} is not a pack`, 422);
    if (!Number.isInteger(count) || count < 1) throw new AppError('Sell a whole number of packs, 1 or more', 422);
    if (!ctx.tracked) return { taken: 0, base_item_id: ctx.base.id };
    const take = count * ctx.item.pack_of.quantity;
    const row = await withTransaction((tx) =>
      applyDelta(tx, {
        item_id: ctx.base.id,
        location_id,
        delta: -take,
        reason: `Sold ${count} × pack of ${ctx.item.pack_of.quantity} (${ctx.item.sku})`,
        source: 'sale',
        label: ctx.base.sku,
      })
    );
    return { taken: take, base_item_id: ctx.base.id, on_hand_after: row.on_hand };
  },

  /**
   * Initial stock for a new item (Phase 3 create / add item), with its
   * movement, inside the caller's transaction.
   */
  async initial(tx: Tx, itemId: string, quantity: number) {
    const id = newId();
    await ItemStockModel.create([{ id, item_id: itemId, location_id: DEFAULT_LOCATION, on_hand: quantity }], { session: tx.session });
    tx.undo(() => ItemStockModel.collection.deleteOne({ id }));
    if (quantity === 0) return;
    const movementId = newId();
    await StockMovementModel.create(
      [{ id: movementId, item_id: itemId, location_id: DEFAULT_LOCATION, delta: quantity, reason: 'Initial stock', on_hand_after: quantity, source: 'initial' }],
      { session: tx.session }
    );
    tx.undo(() => StockMovementModel.collection.deleteOne({ id: movementId }));
  },
};

/**
 * One-time, idempotent (start-up): a stock row with stock but no movements
 * gets an "Opening balance" movement, so the movements always add up to
 * `on_hand`. Rows that already have movements are left alone.
 */
export const writeOpeningBalances = async (): Promise<number> => {
  const rows = await ItemStockModel.find({ on_hand: { $ne: 0 } }).lean<any[]>();
  let written = 0;
  for (const r of rows) {
    const location_id = r.location_id ?? DEFAULT_LOCATION;
    if (await StockMovementModel.exists({ item_id: r.item_id, location_id })) continue;
    await StockMovementModel.create({
      id: newId(),
      item_id: r.item_id,
      location_id,
      delta: r.on_hand,
      reason: 'Opening balance',
      on_hand_after: r.on_hand,
      source: 'opening',
    });
    written++;
  }
  return written;
};
