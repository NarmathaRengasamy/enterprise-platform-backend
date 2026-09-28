import { randomUUID } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import type {
  CatalogAvailability,
  CatalogBooking,
  CatalogCategory,
  CatalogCharge,
  CatalogItem,
  CatalogPrice,
  CatalogProduct,
  ProductType,
} from './types.js';

/**
 * CATALOGUE V2 — Mongoose models.
 *
 * Every collection here is new (`producttypes`, `catalog*`). v2 never reads or
 * writes a v1 collection, so the existing product/category flow, the MCP tools
 * and the public API all keep working untouched while this is built.
 */

/** Strips Mongo bookkeeping from every response, exactly as v1 does. */
const jsonTransform = {
  virtuals: true,
  transform: (_doc: unknown, ret: any) => {
    delete ret._id;
    delete ret.__v;
    return ret;
  },
};

/**
 * `versionKey: false` drops `__v`, and the plugin below drops `_id` from every
 * lean read.
 *
 * Both matter because most v2 reads are `.lean()` for speed, and lean bypasses
 * `toJSON` entirely — without this the Mongo bookkeeping leaks into responses
 * that the non-lean paths carefully strip, so the same resource came back in
 * two different shapes depending on which endpoint returned it.
 */
const baseOptions = { timestamps: true, versionKey: false, toJSON: jsonTransform } as const;

/**
 * Identity, soft deletion, and the query filter that makes them work.
 *
 * `id` is a v4 UUID. Nothing is derived from a name or a SKU any more: a
 * derived id changes meaning when the thing it was derived from is renamed,
 * and it collides with a soft-deleted row that still holds the old value.
 *
 * `is_deleted` replaces every hard delete. The row survives, so an order line,
 * a booking or a report that points at it still resolves — which is the whole
 * reason not to remove catalogue rows in the first place.
 */
const SOFT_DELETE_FIELDS = {
  id: { type: String, required: true, unique: true, index: true, default: () => randomUUID() },
  is_deleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
} as const;

const softDelete = (schema: Schema): void => {
  /* Deleted rows are invisible to every ordinary read. Opting back in is
     explicit — `.setOptions({ withDeleted: true })` — so no caller sees a
     deleted row by accident, and the restore and audit paths are the only
     places that ask for one. */
  schema.pre(/^find/, function (this: any) {
    if (this.getOptions?.().withDeleted) return;
    const filter = this.getFilter();
    if (filter.is_deleted === undefined) this.where({ is_deleted: { $ne: true } });
  });

  /* `countDocuments` does NOT match /^find/, and the dependency checks that
     refuse a delete are all counts — without this, a category with nothing but
     soft-deleted products beneath it could never be deleted. */
  schema.pre('countDocuments', function (this: any) {
    if (this.getOptions?.().withDeleted) return;
    const filter = this.getFilter();
    if (filter.is_deleted === undefined) this.where({ is_deleted: { $ne: true } });
  });

  /* Aggregations bypass the query middleware entirely, so the facet counts and
     the per-category product counts would happily include deleted rows. */
  schema.pre('aggregate', function (this: any) {
    const pipeline = this.pipeline();
    if (pipeline[0] && (pipeline[0] as any).$__withDeleted) {
      pipeline.shift();
      return;
    }
    pipeline.unshift({ $match: { is_deleted: { $ne: true } } });
  });
};

const hideMongoIds = (schema: Schema): void => {
  schema.pre(/^find/, function (this: any) {
    /* Lean reads only. A hydrated document stripped of its `_id` cannot be
       saved, so applying this everywhere breaks every read-modify-write path.
       Non-lean reads already go through `toJSON`, which strips the same keys. */
    if (!this._mongooseOptions?.lean) return;

    /* Merged rather than assigned: a query that already asked for specific
       fields keeps its projection, and `_id: 0` is the one exclusion MongoDB
       allows alongside an inclusive one. */
    this.select({ _id: 0, __v: 0 });
  });
};

/* ====================================================== product types */

const FieldDefinitionSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, required: true, enum: ['text', 'number', 'choice', 'boolean'] },
    options: { type: [String], default: undefined },
    variantForming: { type: Boolean, default: false },
    filterable: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    /* Retired, never removed: a product created last year still carries a value
       for this key, and deleting the definition would orphan it. */
    deprecated: { type: Boolean, default: false },
  },
  { _id: false }
);

const MediaConfigSchema = new Schema(
  {
    images: {
      enabled: { type: Boolean, default: false },
      required: { type: Boolean, default: false },
    },
    videos: {
      enabled: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

/**
 * One asset on a product or an item.
 *
 * `_id: false` because the asset carries its own uuid — the frontend needs a
 * stable handle to reorder and delete by, and Mongo's own id is stripped from
 * every response anyway.
 */
const MediaAssetSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, required: true, enum: ['image', 'video'] },
    url: { type: String, required: true },
    source: { type: String, required: true, enum: ['upload', 'link'], default: 'upload' },
    sort: { type: Number, required: true, default: 0 },
    isThumbnail: { type: Boolean, default: false },
    alt: { type: String },
    filename: { type: String },
    sizeBytes: { type: Number },
    contentType: { type: String },
  },
  { _id: false }
);

const ProductTypeSchema = new Schema<ProductType>(
  {
    ...SOFT_DELETE_FIELDS,
    name: { type: String, required: true, index: true },
    description: { type: String, default: '' },
    fields: { type: [FieldDefinitionSchema], default: [] },
    media: { type: MediaConfigSchema, default: undefined },
  },
  baseOptions
);

softDelete(ProductTypeSchema);
hideMongoIds(ProductTypeSchema);

export const ProductTypeModel =
  mongoose.models.ProductType ||
  mongoose.model<ProductType>('ProductType', ProductTypeSchema, 'producttypes');

/* ========================================================= categories */

const CommerceSchema = new Schema(
  {
    pricing: {
      model: {
        type: String,
        required: true,
        enum: ['fixed', 'per_unit', 'per_time', 'per_variant', 'tiered', 'on_request', 'free'],
        default: 'fixed',
      },
      label: { type: String },
      unit: { type: String },
      currency: { type: String, default: 'INR' },
    },
    availability: {
      model: {
        type: String,
        required: true,
        enum: ['quantity', 'time_slot', 'capacity_per_date', 'unlimited', 'lead_time', 'none'],
        default: 'quantity',
      },
      label: { type: String },
      slotMinutes: { type: Number },
      openingHours: { type: Schema.Types.Mixed },
      requiresIncharge: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

const CatalogCategorySchema = new Schema<CatalogCategory>(
  {
    ...SOFT_DELETE_FIELDS,
    name: { type: String, required: true, index: true },
    description: { type: String, default: '' },
    /* Null at the root. The tree is walked in application code rather than
       stored as a materialised path: depth here is small, and a path would have
       to be rewritten across every descendant on each move. */
    parentId: { type: String, default: null, index: true },
    typeId: { type: String, index: true },
    commerce: { type: CommerceSchema, default: undefined },
    icon: { type: String, default: 'category' },
    color: { type: String, default: 'primary' },
  },
  baseOptions
);

softDelete(CatalogCategorySchema);
hideMongoIds(CatalogCategorySchema);

export const CatalogCategoryModel =
  mongoose.models.CatalogCategory ||
  mongoose.model<CatalogCategory>('CatalogCategory', CatalogCategorySchema, 'catalogcategories');

/* =========================================================== products */

const AttributeValueSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: false }
);

const CatalogProductSchema = new Schema<CatalogProduct>(
  {
    ...SOFT_DELETE_FIELDS,
    /* No `index: true` here. Mongoose builds a plain `sku_1` from a
       field-level index and then DEDUPLICATES the explicit partial-unique
       declaration below against it by key pattern, so the uniqueness is
       silently dropped. Declaring it in exactly one place is the fix. */
    sku: { type: String, required: true },
    name: { type: String, required: true, index: true },
    description: { type: String, default: '' },
    brand: { type: String, index: true },
    typeId: { type: String, required: true, index: true },
    /* Many, not one: a watch belongs in "Watches" and in "Gifts", and forcing a
       single parent is what makes the v1 category field awkward. */
    categoryIds: { type: [String], default: [], index: true },
    attributes: { type: [AttributeValueSchema], default: [] },
    /* Lifecycle, NOT stock. A draft product is unpublished, not unavailable —
       v1 conflated the two, which is why an unpriced product read as sold out. */
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft', index: true },
    /* Derived from the thumbnail on every write — never an input of its
       own. See `syncDerived` in the media service. */
    image: { type: String },
    media: { type: [MediaAssetSchema], default: [] },
  },
  baseOptions
);

/* SKU uniqueness is PARTIAL, over the live rows only.
   A plain unique index would let one soft-deleted product hold its SKU for
   ever, so the obvious recovery — delete it and recreate it properly — fails
   with a duplicate-key error on the SKU the user just freed. */
CatalogProductSchema.index({ sku: 1 }, { unique: true, partialFilterExpression: { is_deleted: false } });

CatalogProductSchema.index({ 'attributes.key': 1, 'attributes.value': 1 });
CatalogProductSchema.index({ typeId: 1, status: 1 });

softDelete(CatalogProductSchema);
hideMongoIds(CatalogProductSchema);

export const CatalogProductModel =
  mongoose.models.CatalogProduct ||
  mongoose.model<CatalogProduct>('CatalogProduct', CatalogProductSchema, 'catalogproducts');

/* ============================================================== items */

const CatalogItemSchema = new Schema<CatalogItem>(
  {
    ...SOFT_DELETE_FIELDS,
    productId: { type: String, required: true, index: true },
    /* No `index: true` here. Mongoose builds a plain `sku_1` from a
       field-level index and then DEDUPLICATES the explicit partial-unique
       declaration below against it by key pattern, so the uniqueness is
       silently dropped. Declaring it in exactly one place is the fix. */
    sku: { type: String, required: true },
    attributes: { type: [AttributeValueSchema], default: [] },
    /* Derived, for display only. The attributes array is the source of truth;
       these exist so a list view need not rebuild a label per row. */
    optionLabel: { type: String },
    valueLabel: { type: String },
    description: { type: String },
    image: { type: String },
    media: { type: [MediaAssetSchema], default: [] },
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'active', index: true },
  },
  baseOptions
);

CatalogItemSchema.index({ sku: 1 }, { unique: true, partialFilterExpression: { is_deleted: false } });

/* $elemMatch on key+value needs both in one index entry, or a multi-axis filter
   degrades to a collection scan — measured on v1 before this was added. */
CatalogItemSchema.index({ 'attributes.key': 1, 'attributes.value': 1 });
CatalogItemSchema.index({ productId: 1, status: 1 });

softDelete(CatalogItemSchema);
hideMongoIds(CatalogItemSchema);

export const CatalogItemModel =
  mongoose.models.CatalogItem ||
  mongoose.model<CatalogItem>('CatalogItem', CatalogItemSchema, 'catalogitems');

/* ============================================================= prices */

const CatalogPriceSchema = new Schema<CatalogPrice>(
  {
    ...SOFT_DELETE_FIELDS,
    itemId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'INR' },
    /* A price book: retail, b2b, staff. This is what lets one catalogue carry
       customer-specific pricing without duplicating every product. */
    priceListId: { type: String, required: true, default: 'default', index: true },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    minQuantity: { type: Number, default: 1 },
  },
  baseOptions
);

CatalogPriceSchema.index({ itemId: 1, priceListId: 1, minQuantity: -1 });

softDelete(CatalogPriceSchema);
hideMongoIds(CatalogPriceSchema);

export const CatalogPriceModel =
  mongoose.models.CatalogPrice ||
  mongoose.model<CatalogPrice>('CatalogPrice', CatalogPriceSchema, 'catalogprices');

/* ============================================================ charges */

const CatalogChargeSchema = new Schema<CatalogCharge>(
  {
    ...SOFT_DELETE_FIELDS,
    name: { type: String, required: true },
    label: { type: String },
    scope: {
      level: { type: String, required: true, enum: ['category', 'product', 'item'] },
      refId: { type: String, required: true },
    },
    basis: { type: String, required: true, enum: ['fixed', 'percent', 'per_unit', 'per_time'] },
    amount: { type: Number },
    percent: { type: Number },
    /* Declares the order explicitly: a hotel charges GST on the room rate plus
       the service charge, and leaving that to evaluation order produces a total
       nobody can reproduce. */
    percentOf: { type: String, enum: ['base', 'base_plus_charges'], default: 'base' },
    required: { type: Boolean, default: true },
    selectable: { type: Boolean, default: false },
    maxQuantity: { type: Number, default: 1 },
    currency: { type: String, default: 'INR' },
    priceListId: { type: String, default: null, index: true },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    showInListing: { type: Boolean, default: false },
  },
  baseOptions
);

CatalogChargeSchema.index({ 'scope.level': 1, 'scope.refId': 1 });

softDelete(CatalogChargeSchema);
hideMongoIds(CatalogChargeSchema);

export const CatalogChargeModel =
  mongoose.models.CatalogCharge ||
  mongoose.model<CatalogCharge>('CatalogCharge', CatalogChargeSchema, 'catalogcharges');

/* ======================================================= availability */

const CatalogAvailabilitySchema = new Schema<CatalogAvailability>(
  {
    ...SOFT_DELETE_FIELDS,
    itemId: { type: String, required: true, index: true },
    /* A shop, a warehouse, a clinic room, a court. Always present, so that
       single-location and multi-location businesses read the same way. */
    locationId: { type: String, required: true, default: 'default', index: true },
    strategy: {
      type: String,
      required: true,
      enum: ['quantity', 'time_slot', 'capacity_per_date', 'unlimited', 'lead_time', 'none'],
    },
    onHand: { type: Number },
    reserved: { type: Number, default: 0 },
    date: { type: String },
    capacity: { type: Number },
    openingHours: { type: Schema.Types.Mixed },
    slotMinutes: { type: Number },
    resourceId: { type: String },
    inchargeId: { type: String, index: true },
    leadDays: { type: Number },
    note: { type: String },
  },
  baseOptions
);

CatalogAvailabilitySchema.index({ itemId: 1, locationId: 1, strategy: 1, date: 1 });

softDelete(CatalogAvailabilitySchema);
hideMongoIds(CatalogAvailabilitySchema);

export const CatalogAvailabilityModel =
  mongoose.models.CatalogAvailability ||
  mongoose.model<CatalogAvailability>(
    'CatalogAvailability',
    CatalogAvailabilitySchema,
    'catalogavailability'
  );

/* =========================================================== bookings */

const CatalogBookingSchema = new Schema<CatalogBooking>(
  {
    ...SOFT_DELETE_FIELDS,
    itemId: { type: String, required: true, index: true },
    locationId: { type: String, default: 'default', index: true },
    inchargeId: { type: String, index: true },
    resourceId: { type: String, index: true },
    startsAt: { type: Date, required: true, index: true },
    endsAt: { type: Date, required: true },
    customerName: { type: String },
    customerPhone: { type: String },
    customerEmail: { type: String },
    status: {
      type: String,
      enum: ['held', 'confirmed', 'cancelled', 'completed'],
      default: 'confirmed',
      index: true,
    },
    notes: { type: String },
  },
  baseOptions
);

/* The overlap query: everything booked for this item between two instants. */
CatalogBookingSchema.index({ itemId: 1, startsAt: 1, endsAt: 1 });

softDelete(CatalogBookingSchema);
hideMongoIds(CatalogBookingSchema);

export const CatalogBookingModel =
  mongoose.models.CatalogBooking ||
  mongoose.model<CatalogBooking>('CatalogBooking', CatalogBookingSchema, 'catalogbookings');

/* ------------------------------------------------------------- indexes */

/**
 * Waits for the v2 indexes to exist before the server takes traffic.
 *
 * Mongoose builds indexes in the background after a model is compiled, so on a
 * database that does not have them yet — a fresh install, a new environment —
 * there is a window where writes are accepted with no unique index behind
 * them. Two products with the same SKU written inside that window then make
 * the index build fail with a duplicate key, and uniqueness is silently off
 * for that collection from then on, which is the worst of both outcomes.
 *
 * Awaiting this at startup costs a moment on first boot and nothing
 * afterwards, since the indexes already exist.
 */
export const ensureV2Indexes = async (): Promise<void> => {
  await Promise.all([
    ProductTypeModel.init(),
    CatalogCategoryModel.init(),
    CatalogProductModel.init(),
    CatalogItemModel.init(),
    CatalogPriceModel.init(),
    CatalogChargeModel.init(),
    CatalogAvailabilityModel.init(),
    CatalogBookingModel.init(),
  ]);
};
