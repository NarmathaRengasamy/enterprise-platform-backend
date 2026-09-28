/**
 * CATALOGUE V2 — shared types.
 *
 * A configurable catalogue: a Type declares what fields exist, a Category
 * declares how the business behaves, and Price, Availability and Charge are
 * their own records rather than fields on a product.
 *
 * Everything here is new. Nothing reads or writes a v1 collection.
 */

/**
 * Carried by every v2 record.
 *
 * `id` is a v4 UUID, minted by the server — never derived from a name or a
 * SKU, both of which change. `is_deleted` is how records leave the catalogue:
 * nothing is ever removed, so anything already pointing at a row keeps
 * resolving.
 */
export interface SoftDeletable {
  id: string;
  is_deleted?: boolean;
  deletedAt?: string | Date | null;
}

/* ------------------------------------------------------------ type system */

export type FieldType = 'text' | 'number' | 'choice' | 'boolean';

export interface FieldDefinition {
  /** Immutable once created. Renaming the label must never orphan data. */
  key: string;
  label: string;
  type: FieldType;
  /** Allowed values, for `choice`. */
  options?: string[];
  /** Feeds the combination matrix: Colour x Size produces items. */
  variantForming?: boolean;
  /** Offered as a storefront facet. */
  filterable?: boolean;
  required?: boolean;
  /** Retired rather than deleted — products still carry values for it. */
  deprecated?: boolean;
}

/**
 * What a product carries besides its fields.
 *
 * Declared per type, so a phone can require photos while a repair service has
 * none at all and its product form never mentions them.
 */
export interface MediaConfig {
  images: { enabled: boolean; required?: boolean };
  videos: { enabled: boolean };
}

export type MediaKind = 'image' | 'video';

/**
 * One picture or video.
 *
 * `sort` is an explicit number rather than array position, so moving one asset
 * does not depend on rewriting the whole list. `isThumbnail` is a flag on an
 * image rather than a field on the product, so it cannot end up pointing at
 * something that was deleted.
 */
export interface MediaAsset {
  id: string;
  kind: MediaKind;
  url: string;
  /** `upload` lives on our disk; `link` is somebody else's player. */
  source: 'upload' | 'link';
  sort: number;
  /** Images only. At most one per list, enforced on write. */
  isThumbnail?: boolean;
  alt?: string;
  /** Present for uploads, so the file can be removed with the record. */
  filename?: string;
  sizeBytes?: number;
  contentType?: string;
}

export interface ProductType extends SoftDeletable {
  name: string;
  description?: string;
  fields: FieldDefinition[];
  /** Absent means neither images nor videos are offered. */
  media?: MediaConfig;
}

/* -------------------------------------------------------------- commerce */

export type PricingModel =
  | 'fixed'
  | 'per_unit'
  | 'per_time'
  | 'per_variant'
  | 'tiered'
  | 'on_request'
  | 'free';

export type AvailabilityModel =
  | 'quantity'
  | 'time_slot'
  | 'capacity_per_date'
  | 'unlimited'
  | 'lead_time'
  | 'none';

/**
 * How a category behaves commercially.
 *
 * This is what lets one platform serve a shop, a dealership and a clinic: the
 * form, the storefront and the AI all read these instead of assuming a price
 * and a stock count exist.
 */
export interface CommerceConfig {
  pricing: {
    model: PricingModel;
    /** "Ex-showroom", "Consultation fee", "Rate per night". */
    label?: string;
    unit?: string;
    currency?: string;
  };
  availability: {
    model: AvailabilityModel;
    label?: string;
    /** time_slot only. */
    slotMinutes?: number;
    openingHours?: Record<string, string>;
    /** Does booking need a named person (a doctor, a coach)? */
    requiresIncharge?: boolean;
  };
}

export interface CatalogCategory extends SoftDeletable {
  name: string;
  description?: string;
  /** Null at the root. Categories are a tree. */
  parentId?: string | null;
  /** Which ProductType products here are built from. */
  typeId?: string;
  commerce?: CommerceConfig;
  icon?: string;
  color?: string;
}

/* -------------------------------------------------------- product / item */

/** One stored value for a field the Type declared. */
export interface AttributeValue {
  key: string;
  value: string;
}

export type LifecycleStatus = 'draft' | 'active' | 'archived';

export interface CatalogProduct extends SoftDeletable {
  sku: string;
  name: string;
  description?: string;
  brand?: string;
  typeId: string;
  /** MANY categories, not one: a watch is in "Watches" AND "Gifts". */
  categoryIds: string[];
  /** Non variant-forming fields — true of the product as a whole. */
  attributes: AttributeValue[];
  /** Lifecycle, NOT stock. A draft product is not an out-of-stock one. */
  status: LifecycleStatus;
  /**
   * Derived, read-only: the thumbnail's URL.
   *
   * Kept because the storefront and the admin list already read it. Writing to
   * it does nothing — set `isThumbnail` on the asset instead.
   */
  image?: string;
  media?: MediaAsset[];
}

/**
 * The thing actually sold.
 *
 * Its own collection, not an embedded array: an order line, a price and an
 * availability record all point at an item, and none of that is expressible
 * from inside a parent document.
 */
export interface CatalogItem extends SoftDeletable {
  productId: string;
  sku: string;
  /** The variant-forming values. THE definition of this combination. */
  attributes: AttributeValue[];
  /** Derived display labels. Never the source of truth. */
  optionLabel?: string;
  valueLabel?: string;
  description?: string;
  /** Derived from this item's own thumbnail, as on the product. */
  image?: string;
  /** A variant's own photos. Empty means it falls back to the product's. */
  media?: MediaAsset[];
  status: LifecycleStatus;
}

/* ----------------------------------------------------------------- price */

export interface CatalogPrice extends SoftDeletable {
  itemId: string;
  amount: number;
  currency: string;
  /** retail | b2b | staff — lets one catalogue carry many price books. */
  priceListId: string;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  /** Lowest quantity this row applies from, for tiered pricing. */
  minQuantity?: number;
}

/* --------------------------------------------------------------- charges */

export type ChargeBasis = 'fixed' | 'percent' | 'per_unit' | 'per_time';
export type ChargeScopeLevel = 'category' | 'product' | 'item';

/**
 * Money that is not the price: a fee, a tax, an optional add-on.
 *
 * Deliberately independent of price — a dealership vehicle is "on request" and
 * still has a known registration fee, which is impossible to express if charges
 * live inside a price.
 */
export interface CatalogCharge extends SoftDeletable {
  name: string;
  label?: string;
  scope: { level: ChargeScopeLevel; refId: string };
  basis: ChargeBasis;
  amount?: number;
  percent?: number;
  /** Whether a percentage is taken before or after the fixed charges. */
  percentOf?: 'base' | 'base_plus_charges';
  /** Mandatory, or an add-on the customer chooses. */
  required: boolean;
  selectable?: boolean;
  maxQuantity?: number;
  currency?: string;
  priceListId?: string | null;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  showInListing?: boolean;
}

/* ---------------------------------------------------------- availability */

export interface CatalogAvailability extends SoftDeletable {
  itemId: string;
  /** A shop, a warehouse, a clinic room, a court. */
  locationId: string;
  strategy: AvailabilityModel;
  /** quantity */
  onHand?: number;
  reserved?: number;
  /** capacity_per_date */
  date?: string;
  capacity?: number;
  /** time_slot */
  openingHours?: Record<string, string>;
  slotMinutes?: number;
  resourceId?: string;
  inchargeId?: string;
  /** lead_time */
  leadDays?: number;
  note?: string;
}

export interface CatalogBooking extends SoftDeletable {
  itemId: string;
  locationId?: string;
  inchargeId?: string;
  resourceId?: string;
  /** ISO on the wire, a Date once it has been through Mongoose. */
  startsAt: string | Date;
  endsAt: string | Date;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  status: 'held' | 'confirmed' | 'cancelled' | 'completed';
  notes?: string;
}
