import mongoose, { Schema } from 'mongoose';
import { User } from '../types/index.js';

const UserSchema = new Schema<User>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true, lowercase: true },
    password: { type: String, select: false },
    role: { type: String, enum: ['Admin', 'Editor', 'Viewer'], default: 'Editor' },
    department: { type: String, default: 'Operations' },
    status: { type: String, enum: ['Active', 'Pending', 'Inactive'], default: 'Active' },
    avatar: { type: String, default: '' },
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
        delete ret.password;
        return ret;
      },
    },
  }
);

export const UserModel = mongoose.models.User || mongoose.model<User>('User', UserSchema);
