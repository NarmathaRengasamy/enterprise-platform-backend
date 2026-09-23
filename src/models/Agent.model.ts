import mongoose, { Schema } from 'mongoose';
import { AIAgent } from '../types/index.js';

/**
 * A cached copy of an agent in the connected Perfox workspace.
 *
 * Perfox is the source of truth for every field here; a refresh overwrites them
 * all. Nothing local is stored alongside — a value this platform cannot get
 * from Perfox would only ever be invented.
 */
const AIAgentSchema = new Schema<AIAgent>(
  {
    /* The Perfox agent id, used as our id too. */
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    description: { type: String, default: '' },
    /* Perfox's own status (published | paused | draft), stored verbatim. */
    status: { type: String, default: 'draft', index: true },
    channels: [{ type: String }],
    /* Derived from the agent's sender nodes — what it can reach out on. */
    senderChannels: [{ type: String }],
    activeVersion: { type: Number, default: 0 },
    nodeCount: { type: Number, default: 0 },
    perfoxCreatedAt: { type: String, default: '' },
    perfoxUpdatedAt: { type: String, default: '' },
    syncedAt: { type: String, default: '' },
  },
  {
    timestamps: false,
    /* No __v: nothing here is edited concurrently — the row is replaced wholesale
       on each sync, so a version key is one more field with no meaning. */
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        delete ret._id;
        return ret;
      },
    },
  }
);

export const AIAgentModel =
  mongoose.models.AIAgent || mongoose.model<AIAgent>('AIAgent', AIAgentSchema);
