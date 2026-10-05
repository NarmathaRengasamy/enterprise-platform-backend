import mongoose, { Schema } from 'mongoose';
import { basePlugin } from './plugins/base.plugin.js';

/**
 * What a bundle item is made of (design §3.5, §6.2 `bundle_components`):
 * e.g. a "Service kit" = 1 × oil filter + 4 × spark plug.
 *
 * The bundle has no stock of its own; its availability is the smallest
 * ⌊available ÷ quantity⌋ over its components.
 */

const BundleComponentSchema = new Schema({
  bundle_item_id: { type: String, required: true },
  component_item_id: { type: String, required: true },
  quantity: { type: Number, required: true },
});

BundleComponentSchema.plugin(basePlugin);

BundleComponentSchema.index(
  { bundle_item_id: 1, component_item_id: 1 },
  { unique: true, partialFilterExpression: { is_deleted: false } }
);
/* "Is this item used in a bundle?" (delete guards). */
BundleComponentSchema.index({ component_item_id: 1 });

export const BundleComponentModel =
  mongoose.models.BundleComponent || mongoose.model('BundleComponent', BundleComponentSchema, 'bundle_components');
