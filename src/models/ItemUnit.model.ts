import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';

/**
 * Individual units of an item (design §3.5, §6.2 `item_units`) — a car's
 * chassis / VIN, a phone's IMEI, or a batch label.
 *
 * Only for items whose Track inventory is on and whose product's tracking is
 * serial or batch. For serial tracking the units ARE the stock: adding an
 * in-stock unit is +1, selling one −1, a return +1 (each a stock movement).
 */

export const UNIT_STATUSES = ['in_stock', 'sold', 'returned'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

const ItemUnitSchema = new Schema({
  item_id: { type: String, required: true },
  serial_no: { type: String, trim: true, default: null },
  batch_no: { type: String, trim: true, default: null },
  location_id: { type: String, default: 'default' },
  status: { type: String, enum: UNIT_STATUSES, default: 'in_stock' },
});

ItemUnitSchema.plugin(basePlugin);

/* A serial number belongs to one live unit; a deleted unit's number can be reused. */
ItemUnitSchema.index(
  { serial_no: 1 },
  { unique: true, partialFilterExpression: { is_deleted: false, serial_no: { $type: 'string' } } }
);
ItemUnitSchema.index({ item_id: 1, status: 1 });

export const ItemUnitModel = mongoose.models.ItemUnit || mongoose.model('ItemUnit', ItemUnitSchema, 'item_units');
