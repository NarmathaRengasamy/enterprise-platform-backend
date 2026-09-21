import mongoose, { Schema } from 'mongoose';
import { AIAgent } from '../types/index.js';

const AIAgentSchema = new Schema<AIAgent>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    workflowId: { type: String, required: true },
    channel: { type: String, default: 'Web Storefront Widget' },
    model: { type: String, default: 'Perfox-Omni 2.5' },
    siteKey: { type: String, default: '' },
    secretKey: { type: String, default: '' },
    accentColor: { type: String, default: '#2563eb' },
    position: { type: String, enum: ['bottom-right', 'bottom-left', 'embed-inline'], default: 'bottom-right' },
    status: { type: String, enum: ['Active', 'Standby', 'Disabled'], default: 'Active' },
    statusColor: { type: String, default: 'emerald' },
    totalCalls: { type: Schema.Types.Mixed, default: '0' },
    avgLatency: { type: String, default: '15 ms' },
    assignedEndpoints: [{ type: String }],
    description: { type: String, default: '' },
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  {
    timestamps: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const AIAgentModel = mongoose.models.AIAgent || mongoose.model<AIAgent>('AIAgent', AIAgentSchema);
