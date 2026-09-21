import mongoose, { Schema } from 'mongoose';
import { Conversation } from '../types/index.js';

const MessageAttachmentSchema = new Schema(
  {
    title: { type: String },
    sku: { type: String },
    status: { type: String },
    image: { type: String },
    fileUrl: { type: String },
    fileName: { type: String },
  },
  { _id: false }
);

const MessageSchema = new Schema(
  {
    id: { type: String, required: true },
    sender: { type: String, enum: ['me', 'them', 'system'], required: true },
    actor: { type: String },
    eventType: { type: String },
    text: { type: String, required: true },
    time: { type: String, required: true },
    timestamp: { type: String },
    channel: { type: String, default: 'web' },
    toolName: { type: String },
    toolStatus: { type: String },
    attachment: { type: MessageAttachmentSchema, required: false },
  },
  { _id: false }
);

const ConversationSchema = new Schema<Conversation>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    customerId: { type: String, index: true },
    workflowId: { type: String },
    status: { type: String, default: 'ended' },
    summary: { type: String, default: '' },
    avatar: { type: String, default: '' },
    initials: { type: String, default: 'CU' },
    channel: { type: String, default: 'web', index: true },
    channels: [{ type: String }],
    channelLabel: { type: String, default: 'Web Chat' },
    channelColor: { type: String, default: '#2563eb' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    unread: { type: Number, default: 0 },
    timestamp: { type: String, default: 'Just now' },
    lastMessage: { type: String, default: '' },
    messages: [MessageSchema],
    createdAt: { type: String, default: () => new Date().toISOString() },
    updatedAt: { type: String, default: () => new Date().toISOString() },
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

export const ConversationModel =
  mongoose.models.Conversation || mongoose.model<Conversation>('Conversation', ConversationSchema);
