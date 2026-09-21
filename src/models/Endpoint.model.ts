import mongoose, { Schema } from 'mongoose';
import { WebhookEndpoint } from '../types/index.js';

const WebhookEndpointSchema = new Schema<WebhookEndpoint>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    url: { type: String, required: true },
    method: { type: String, enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
    transport: { type: String, enum: ['HTTP', 'SSE', 'WebSocket'], default: 'HTTP' },
    authType: { type: String, enum: ['none', 'bearer', 'apiKey', 'basic'], default: 'none' },
    authConfig: {
      bearerToken: { type: String },
      headerName: { type: String },
      apiKeyValue: { type: String },
      basicAuth: { type: String },
    },
    headers: [{ id: Number, key: String, value: String }],
    queryParams: [{ id: Number, key: String, value: String }],
    bodyFormat: { type: String },
    bodyContent: { type: String, default: '' },
    status: { type: String, enum: ['Healthy', 'Degraded', 'Offline'], default: 'Healthy' },
    statusColor: { type: String, default: 'emerald' },
    latency: { type: String, default: '15 ms' },
    connectedAgentsCount: { type: Number, default: 0 },
    lastPingStatus: { type: String, default: '200 OK' },
    lastPingTime: { type: String, default: 'Just now' },
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

export const WebhookEndpointModel =
  mongoose.models.WebhookEndpoint ||
  mongoose.model<WebhookEndpoint>('WebhookEndpoint', WebhookEndpointSchema);
