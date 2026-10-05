import { AppError } from '../middlewares/errorHandler.js';
import { ItemUnitModel, UnitStatus } from '../models/ItemUnit.model.js';
import { newId } from '../utils/id.util.js';
import { withTransaction, Tx } from '../utils/transaction.util.js';
import { applyDelta, DEFAULT_LOCATION, stockContext, StockContext } from './stock.service.js';

/**
 * Serial / batch units (design §3.5, §6.2 `item_units`; plan 4.2).
 *
 * Only for an item whose Track inventory is on AND whose product's tracking
 * (product → type default; never the category) is serial or batch.
 *
 *   serial — serial_no required and unique among live units. The units ARE the
 *            stock: an in-stock unit added = +1, sold = −1, returned = +1, a
 *            counted unit removed = −1, each written as a stock movement.
 *   batch  — batch_no is a label on the unit; stock is adjusted normally
 *            (batch quantities are a known gap, plan Phase 4 status).
 *
 * Status moves: in_stock → sold → returned → in_stock. Anything else → 422.
 */

const invalid = (message: string, field?: string) => new AppError(message, 422, undefined, field ? { [field]: message } : undefined);
const conflict = (message: string) => new AppError(message, 409);

const NEXT: Record<UnitStatus, UnitStatus> = { in_stock: 'sold', sold: 'returned', returned: 'in_stock' };
/** Statuses that count as stock for a serial item. */
const COUNTED: UnitStatus[] = ['in_stock', 'returned'];
const MAX_AT_ONCE = 500;

export interface UnitInput {
  serial_no?: string | null;
  batch_no?: string | null;
  location_id?: string;
}

const clean = (v?: string | null) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const view = ({ _id, ...u }: any) => u;

/** The item may hold units, or 422 saying why not. */
const unitContext = async (itemId: string): Promise<StockContext> => {
  const ctx = await stockContext(itemId);
  if (ctx.item.pack_of) throw invalid(`${ctx.item.sku} is a pack — units belong to its base item`);
  if (ctx.product.is_bundle) throw invalid(`${ctx.item.sku} is a bundle — units belong to its components`);
  if (!ctx.tracked) throw invalid(`${ctx.item.sku} has Track inventory off, so it has no units`);
  if (ctx.tracking !== 'serial' && ctx.tracking !== 'batch') {
    throw invalid(`Units need tracking by serial or batch number — this ${ctx.product.name?.en ?? 'product'} tracks quantity only`);
  }
  return ctx;
};

/** Stock follows a serial unit's status change (R30 — atomic, with a movement). */
const moveStock = (tx: Tx, ctx: StockContext, location_id: string, delta: number, reason: string) =>
  ctx.tracking === 'serial' && delta !== 0
    ? applyDelta(tx, { item_id: ctx.item.id, location_id, delta, reason, source: 'unit', label: ctx.item.sku })
    : Promise.resolve();

export const unitService = {
  async list(itemId: string, opts: { search?: string; status?: UnitStatus } = {}) {
    const ctx = await unitContext(itemId);
    const q = opts.search?.trim();
    const filter: Record<string, unknown> = { item_id: itemId };
    if (opts.status) filter.status = opts.status;
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ serial_no: rx }, { batch_no: rx }];
    }
    const units = await ItemUnitModel.find(filter).sort({ created_at: -1 }).lean<any[]>();
    return { item_id: itemId, sku: ctx.item.sku, tracking: ctx.tracking, units: units.map(view) };
  },

  /** One unit or many (a pasted list), all or nothing. */
  async add(itemId: string, input: UnitInput & { units?: UnitInput[] }) {
    const ctx = await unitContext(itemId);
    const list = input.units?.length ? input.units : [input];
    if (list.length > MAX_AT_ONCE) throw invalid(`At most ${MAX_AT_ONCE} units at once`, 'units');
    const serial = ctx.tracking === 'serial';
    const docs = list.map((u, i) => {
      const serial_no = clean(u.serial_no);
      const batch_no = clean(u.batch_no);
      if (serial && !serial_no) throw invalid('A serial number is required', `units.${i}.serial_no`);
      if (!serial && !batch_no) throw invalid('A batch number is required', `units.${i}.batch_no`);
      return { id: newId(), item_id: itemId, serial_no, batch_no, location_id: u.location_id?.trim() || DEFAULT_LOCATION, status: 'in_stock' as UnitStatus };
    });
    if (serial) {
      const numbers = docs.map((d) => d.serial_no as string);
      const twice = numbers.find((n, i) => numbers.indexOf(n) !== i);
      if (twice) throw invalid(`Serial number ${twice} is given twice`, 'units');
      const taken = await ItemUnitModel.findOne({ serial_no: { $in: numbers } }).lean<any>();
      if (taken) throw conflict(`Serial number ${taken.serial_no} is already used by a unit`);
    }
    try {
      await withTransaction(async (tx) => {
        for (const d of docs) {
          await ItemUnitModel.create([d], { session: tx.session });
          tx.undo(() => ItemUnitModel.collection.deleteOne({ id: d.id }));
          await moveStock(tx, ctx, d.location_id, +1, `Unit added: ${d.serial_no}`);
        }
      });
    } catch (e: any) {
      if (e?.code === 11000) throw conflict('That serial number is already used by a unit');
      throw e;
    }
    return this.list(itemId);
  },

  /** Status (next step only), batch label or location. */
  async update(unitId: string, patch: { status?: UnitStatus; batch_no?: string | null; location_id?: string }) {
    const unit = await ItemUnitModel.findOne({ id: unitId }).lean<any>();
    if (!unit) throw new AppError('Unit not found', 404);
    const ctx = await unitContext(unit.item_id);
    const set: Record<string, unknown> = {};
    const status: UnitStatus = patch.status ?? unit.status;
    if (status !== unit.status) {
      if (NEXT[unit.status as UnitStatus] !== status) {
        throw invalid(`A unit goes ${unit.status} → ${NEXT[unit.status as UnitStatus]}, not → ${status}`, 'status');
      }
      set.status = status;
    }
    if (patch.batch_no !== undefined) set.batch_no = clean(patch.batch_no);
    const location = patch.location_id?.trim() || unit.location_id;
    if (location !== unit.location_id) set.location_id = location;
    if (!Object.keys(set).length) return view(unit);

    const label = unit.serial_no ?? unit.batch_no;
    const wasCounted = COUNTED.includes(unit.status);
    const isCounted = COUNTED.includes(status);
    await withTransaction(async (tx) => {
      /* Stock first (a sale of a unit not in stock is refused), then the unit. */
      if (wasCounted && !isCounted) await moveStock(tx, ctx, unit.location_id, -1, `Unit sold: ${label}`);
      else if (!wasCounted && isCounted) await moveStock(tx, ctx, location, +1, `Unit returned: ${label}`);
      else if (wasCounted && location !== unit.location_id) {
        await moveStock(tx, ctx, unit.location_id, -1, `Unit moved out: ${label}`);
        await moveStock(tx, ctx, location, +1, `Unit moved in: ${label}`);
      }
      await ItemUnitModel.updateOne({ id: unitId }, { $set: set }, { session: tx.session });
      tx.undo(() => ItemUnitModel.collection.replaceOne({ id: unitId }, unit));
    });
    return view(await ItemUnitModel.findOne({ id: unitId }).lean<any>());
  },

  /** Soft delete; a counted serial unit leaves the stock with it. */
  async remove(unitId: string) {
    const unit = await ItemUnitModel.findOne({ id: unitId }).lean<any>();
    if (!unit) throw new AppError('Unit not found', 404);
    const ctx = await unitContext(unit.item_id);
    const at = new Date();
    await withTransaction(async (tx) => {
      if (COUNTED.includes(unit.status)) await moveStock(tx, ctx, unit.location_id, -1, `Unit removed: ${unit.serial_no ?? unit.batch_no}`);
      await ItemUnitModel.updateOne({ id: unitId }, { $set: { is_deleted: true, deleted_at: at } }, { session: tx.session });
      tx.undo(() => ItemUnitModel.collection.updateOne({ id: unitId }, { $set: { is_deleted: false, deleted_at: null } }));
    });
    return { id: unitId };
  },
};

/** R31a: how many units are in stock across these items (tracking may not leave serial / batch while any are). */
export const unitsInStock = (itemIds: string[]): Promise<number> =>
  itemIds.length ? ItemUnitModel.countDocuments({ item_id: { $in: itemIds }, status: 'in_stock' }) : Promise.resolve(0);
