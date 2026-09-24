import mongoose, { Schema } from 'mongoose';
import {
  PlatformConnection,
  PlatformKbFolder,
  PlatformOperatorSite,
} from '../types/index.js';

/* `_id: false` — a subdocument, not a row of its own; Mongo would otherwise
   mint an ObjectId for it on every write. */
const KbFolderSchema = new Schema<PlatformKbFolder>(
  {
    id: { type: String, default: '' },
    name: { type: String, default: '' },
    path: { type: String, default: '' },
    selectedAt: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * The Perfox Site a human operator signs in against.
 *
 * `_id: false` for the same reason as the folder above. `siteSecret` is
 * `select: false` and deleted in `toJSON`, matching `apiToken`: it signs
 * operator identities, so anyone holding it can act as any operator.
 */
const OperatorSiteSchema = new Schema<PlatformOperatorSite>(
  {
    apiHost: { type: String, default: '' },
    siteId: { type: String, default: '' },
    siteSecret: { type: String, default: '', select: false },
    workflowId: { type: String, default: '' },
    configuredAt: { type: String, default: '' },
    configuredBy: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * The tenant's connection to the Perfox platform.
 *
 * Exactly one row ever exists, keyed `id: 'perfox'` — this is configuration,
 * not a collection. It is modelled in Mongo rather than read only from the
 * environment so a developer can set it from the Developer Hub without a
 * redeploy, and so the verification result survives a restart.
 */
const PlatformConnectionSchema = new Schema<PlatformConnection>(
  {
    id: { type: String, required: true, unique: true, index: true },
    apiUrl: { type: String, required: true },
    /* select:false so no query can leak the token by accident — every read has
       to ask for it by name, which makes the few places that need it obvious. */
    apiToken: { type: String, required: true, select: false },
    workspace: { type: String, default: '' },
    status: {
      type: String,
      enum: ['Connected', 'Unverified', 'Error'],
      default: 'Unverified',
    },
    lastVerifiedAt: { type: String, default: '' },
    lastError: { type: String, default: '' },
    connectedBy: { type: String, default: '' },
    operatorSite: { type: OperatorSiteSchema, default: undefined },
    updatedAt: { type: String, default: () => new Date().toISOString() },
  },
  {
    timestamps: false,
    /* No __v: this is a single configuration row replaced by $set, so a version
       key is one more stored field that answers nothing. */
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        delete ret._id;
        delete ret.__v;
        delete ret.apiToken;
        /* Defence in depth: `select: false` already keeps it out of a normal
           read, but a query that asks for it explicitly must not be able to
           serialise it by accident. */
        if (ret.operatorSite) delete ret.operatorSite.siteSecret;
        return ret;
      },
    },
  }
);

export const PlatformConnectionModel =
  mongoose.models.PlatformConnection ||
  mongoose.model<PlatformConnection>('PlatformConnection', PlatformConnectionSchema);
