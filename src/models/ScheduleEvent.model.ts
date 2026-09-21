import mongoose, { Schema } from 'mongoose';
import { ScheduleEvent } from '../types/index.js';

const ScheduleEventSchema = new Schema<ScheduleEvent>(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    time: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    dateKey: { type: String, required: true, index: true },
    dayIndex: { type: Number, default: 0 },
    dateNum: { type: Number, default: 1 },
    topOffset: { type: Number, default: 0 },
    height: { type: Number, default: 60 },
    client: { type: String, default: 'Client' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    attendee: { type: String, default: 'OmniFlow AI Agent' },
    participantType: { type: String, enum: ['human', 'agent', 'customer'], default: 'agent', index: true },
    type: { type: String, default: 'AI Bot Scheduled' },
    location: { type: String, default: 'Microsoft Teams Meeting' },
    status: { type: String, enum: ['Confirmed', 'Pending', 'Cancelled', 'Completed'], default: 'Confirmed', index: true },
    statusColor: { type: String, default: 'purple' },
    notes: { type: String, default: '' },
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

export const ScheduleEventModel =
  mongoose.models.ScheduleEvent || mongoose.model<ScheduleEvent>('ScheduleEvent', ScheduleEventSchema);
