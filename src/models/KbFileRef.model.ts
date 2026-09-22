import mongoose, { Schema } from 'mongoose';
import { KbFileRef } from '../types/index.js';

/**
 * A note that this service uploaded a given file to a Perfox folder.
 *
 * Perfox has no "list files" endpoint: the only enumeration is a folder's
 * `index.manifest`, which is regenerated asynchronously. A file uploaded a
 * moment ago is therefore absent from the manifest — and an empty folder has no
 * `index` block at all — so a list built from the manifest alone would not show
 * the file the user just created, which is the one thing they are looking for.
 *
 * These rows are a pointer, never a copy: the name, type, size and status shown
 * in the list are always read back from Perfox, which stays the source of truth.
 * A row whose file has since been deleted upstream is dropped on the next read.
 */
const KbFileRefSchema = new Schema<KbFileRef>(
  {
    /* Perfox's file id — the addressable one, not its internal `_id`. */
    fileId: { type: String, required: true, unique: true, index: true },
    folderId: { type: String, required: true, index: true },
    name: { type: String, default: '' },
    uploadedAt: { type: String, default: () => new Date().toISOString() },
    uploadedBy: { type: String, default: '' },
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

export const KbFileRefModel =
  mongoose.models.KbFileRef || mongoose.model<KbFileRef>('KbFileRef', KbFileRefSchema);
