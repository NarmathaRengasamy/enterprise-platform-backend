import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';

/**
 * Every stock change, as it happened (design §3.5, R30, R36).
 *
 * Written in the same transaction as the `item_stock` change it describes, so
 * for each stock row the deltas always add up to `on_hand`. Never edited or
 * deleted — it is the history.
 */

export const MOVEMENT_SOURCES = ['adjust', 'initial', 'opening', 'unit', 'sale'] as const;
export type MovementSource = (typeof MOVEMENT_SOURCES)[number];

const StockMovementSchema = new Schema({
  item_id: { type: String, required: true },
  location_id: { type: String, default: 'default' },
  /* Whole units: + received, − taken out. */
  delta: { type: Number, required: true },
  reason: { type: String, required: true, trim: true },
  on_hand_after: { type: Number, required: true },
  /* What caused it: a manual adjustment, initial stock, the opening balance, a serial unit, a sale. */
  source: { type: String, enum: MOVEMENT_SOURCES, default: 'adjust' },
});

StockMovementSchema.plugin(basePlugin);

StockMovementSchema.index({ item_id: 1, created_at: -1 });
StockMovementSchema.index({ item_id: 1, location_id: 1 });

export const StockMovementModel =
  mongoose.models.StockMovement || mongoose.model('StockMovement', StockMovementSchema, 'stock_movements');
