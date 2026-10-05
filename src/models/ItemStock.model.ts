import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';

/**
 * Stock per item per location (design §3.5, R28–R31).
 *
 * Its own record, never a field a product save overwrites. A row exists only
 * while the item's Track inventory is on (R31): no row means "not tracked".
 * Phase 3 writes initial stock only; adjustments arrive in Phase 4.
 */

const ItemStockSchema = new Schema({
  item_id: { type: String, required: true },
  location_id: { type: String, default: 'default' },
  on_hand: { type: Number, default: 0 },
  reserved: { type: Number, default: 0 },
  reorder_point: { type: Number, default: 0 },
});

ItemStockSchema.plugin(basePlugin);

ItemStockSchema.index({ item_id: 1, location_id: 1 }, { unique: true, partialFilterExpression: { is_deleted: false } });

export const ItemStockModel = mongoose.models.ItemStock || mongoose.model('ItemStock', ItemStockSchema, 'item_stock');
