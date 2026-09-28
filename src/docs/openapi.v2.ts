import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  addFieldSchema,
  createTypeSchema,
  updateFieldSchema,
  updateTypeSchema,
} from '../v2/controllers/type.controller.js';
import {
  createCategorySchema as createV2CategorySchema,
  updateCategorySchema as updateV2CategorySchema,
} from '../v2/controllers/category.controller.js';
import {
  createProductSchema as createV2ProductSchema,
  itemSchema,
  matrixSchema,
  searchSchema,
  updateProductSchema as updateV2ProductSchema,
} from '../v2/controllers/product.controller.js';
import {
  createChargeSchema,
  createPriceSchema,
  updateChargeSchema,
  updatePriceSchema,
} from '../v2/controllers/commerce.controller.js';
import {
  adjustStockSchema,
  createBookingSchema,
  upsertAvailabilitySchema,
} from '../v2/controllers/availability.controller.js';

/**
 * OpenAPI fragment for CATALOGUE V2.
 *
 * Kept in its own module so the v1 document stays exactly as it was. Request
 * bodies come from the same Zod schemas `validateRequest()` enforces, so the
 * documentation cannot drift from the validation.
 */

const bodyOf = (schema: z.ZodTypeAny): Record<string, unknown> => {
  const shape = (schema as any)?._def?.shape?.();
  const body = shape?.body ?? schema;
  return zodToJsonSchema(body, { $refStrategy: 'none', target: 'openApi3' }) as Record<string, unknown>;
};

const bearer = [{ bearerAuth: [] }];

const envelope = (data: Record<string, unknown>) => ({
  type: 'object',
  properties: { success: { type: 'boolean', example: true }, message: { type: 'string' }, data },
});

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } },
});

const okResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description: string, message: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorResponse' },
      example: { success: false, message },
    },
  },
});

const ERRORS = {
  401: errorResponse('Missing or invalid token', 'Authentication token required'),
  403: errorResponse('Role lacks permission', 'You do not have permission to perform this action'),
  404: errorResponse('Not found', "Product 'PRD2-X' not found"),
  409: errorResponse('Conflict with existing data', 'That slot is already booked'),
  422: errorResponse(
    'Failed validation against the configured type',
    "'Colour' must be one of: Blue, Green (got \"Turquoise\")"
  ),
};

const one = (ref: string) => okResponse('Single resource', envelope({ $ref: `#/components/schemas/${ref}` }));
const listOf = (ref: string) =>
  okResponse('List', envelope({ type: 'array', items: { $ref: `#/components/schemas/${ref}` } }));
const pagedOf = (ref: string) =>
  okResponse('Paginated list', {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      total: { type: 'integer' },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      totalPages: { type: 'integer' },
      data: { type: 'array', items: { $ref: `#/components/schemas/${ref}` } },
    },
  });

const param = (name: string, description: string, extra: Record<string, unknown> = {}) => ({
  name,
  in: 'query',
  schema: { type: 'string', ...extra },
  description,
});

const pathParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description,
});

/* ================================================================ schemas */

export const v2Schemas: Record<string, unknown> = {
  V2SoftDeleteFields: {
    type: 'object',
    description:
      'Carried by every v2 record. `id` is a server-minted v4 UUID — never derived from a name or a SKU, both of which change. Nothing is ever hard-deleted: `is_deleted` is how a record leaves the catalogue, so an order line, a booking or a report that points at it still resolves.',
    properties: {
      id: { type: 'string', format: 'uuid', example: '9f1c2e84-5b3a-4d6e-8f07-1a2b3c4d5e6f',
            description: 'Server-minted. A client-supplied id is ignored.' },
      is_deleted: { type: 'boolean', default: false },
      deletedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  V2FieldDefinition: {
    type: 'object',
    description:
      'One configurable field on a product type. `key` is derived from the label on creation and is immutable thereafter — renaming a label is cosmetic, renaming a key would orphan every stored value.',
    properties: {
      key: { type: 'string', example: 'colour', description: 'Immutable. Derived from the label.' },
      label: { type: 'string', example: 'Colour', description: 'Editable at any time.' },
      type: { type: 'string', enum: ['text', 'number', 'choice', 'boolean'] },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Required for `choice`. Values are matched case-insensitively and stored in the declared casing, so "blue" and "BLUE" cannot become separate facets.',
      },
      variantForming: {
        type: 'boolean',
        description:
          'Feeds the combination matrix. Only a `choice` field may form variants — a free-text axis would make the combination count unbounded.',
      },
      filterable: { type: 'boolean', description: 'Offered as a storefront facet.' },
      required: { type: 'boolean' },
      deprecated: {
        type: 'boolean',
        description:
          'Retired rather than deleted. Products keep their stored values, so re-enabling a field restores the data.',
      },
    },
  },

  V2ProductType: {
    type: 'object',
    description: 'Declares what fields a product has. The Setup tab — nothing else can be built first.',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Server-minted UUID.' },
      is_deleted: { type: 'boolean', default: false },
      deletedAt: { type: 'string', format: 'date-time', nullable: true },
      name: { type: 'string', example: 'Vehicle' },
      description: { type: 'string' },
      fields: { type: 'array', items: { $ref: '#/components/schemas/V2FieldDefinition' } },
      productCount: { type: 'integer', description: 'Present on the detail read only.' },
    },
  },

  V2Commerce: {
    type: 'object',
    description:
      'How a business sells a class of thing. This is what lets one platform serve a shop, a dealership and a clinic: the form, the storefront and the AI read these instead of assuming a price and a stock count exist.',
    properties: {
      pricing: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            enum: ['fixed', 'per_unit', 'per_time', 'per_variant', 'tiered', 'on_request', 'free'],
          },
          label: { type: 'string', example: 'Ex-showroom' },
          unit: { type: 'string', example: 'night', description: 'Required by per_unit and per_time.' },
          currency: { type: 'string', example: 'INR' },
        },
      },
      availability: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            enum: ['quantity', 'time_slot', 'capacity_per_date', 'unlimited', 'lead_time', 'none'],
          },
          label: { type: 'string' },
          slotMinutes: { type: 'integer', description: 'Required by time_slot.' },
          openingHours: { type: 'object', additionalProperties: { type: 'string' } },
          requiresIncharge: {
            type: 'boolean',
            description: 'Whether a booking needs a named person — a doctor, a coach.',
          },
        },
      },
    },
  },

  V2Category: {
    type: 'object',
    description:
      'A node in the category tree. Commerce and type are inherited from the nearest ancestor that declares them, so a tenant configures "Vehicles" once and everything beneath it follows.',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Server-minted UUID.' },
      is_deleted: { type: 'boolean', default: false },
      deletedAt: { type: 'string', format: 'date-time', nullable: true },
      name: { type: 'string' },
      description: { type: 'string' },
      parentId: { type: 'string', nullable: true, description: 'Null at the root.' },
      typeId: { type: 'string', nullable: true, description: 'Declared here, or inherited.' },
      commerce: { $ref: '#/components/schemas/V2Commerce' },
      effectiveCommerce: {
        $ref: '#/components/schemas/V2Commerce',
      },
      effectiveTypeId: { type: 'string', nullable: true },
      productsCount: { type: 'integer', description: 'Includes the whole subtree on the detail read.' },
      depth: { type: 'integer' },
      icon: { type: 'string' },
      color: { type: 'string' },
    },
  },

  V2Attribute: {
    type: 'object',
    properties: {
      key: { type: 'string', example: 'colour', description: 'Must be a field declared on the type.' },
      value: { type: 'string', example: 'Blue' },
    },
    required: ['key', 'value'],
  },

  V2Item: {
    type: 'object',
    description:
      'The thing actually sold. Its own record, because a price, an availability row and a booking all point at it. A product with no variant axes still has exactly one item — that is where its price and stock live.',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Server-minted UUID. The SKU is the human-readable handle.' },
      is_deleted: { type: 'boolean', default: false },
      deletedAt: { type: 'string', format: 'date-time', nullable: true },
      productId: { type: 'string', format: 'uuid' },
      sku: { type: 'string' },
      attributes: {
        type: 'array',
        items: { $ref: '#/components/schemas/V2Attribute' },
        description: 'The variant-forming values. THE definition of this combination.',
      },
      optionLabel: { type: 'string', example: 'Colour / Storage', description: 'Derived. Read-only.' },
      valueLabel: { type: 'string', example: 'Blue / 256GB', description: 'Derived. Read-only.' },
      description: { type: 'string' },
      image: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'active', 'archived'] },
      price: {
        type: 'object',
        nullable: true,
        description: 'Null is a real answer: on request, or simply not priced yet. Never a zero.',
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
          priceListId: { type: 'string' },
        },
      },
      availability: { $ref: '#/components/schemas/V2Availability' },
    },
  },

  V2Availability: {
    type: 'object',
    properties: {
      strategy: {
        type: 'string',
        enum: ['quantity', 'time_slot', 'capacity_per_date', 'unlimited', 'lead_time', 'none'],
      },
      available: { type: 'boolean' },
      label: {
        type: 'string',
        example: '12 in stock',
        description: '"3 left on 14 Oct", "Ships in about 6 weeks", "Availability not tracked".',
      },
      detail: { type: 'object', additionalProperties: true },
    },
  },

  V2Product: {
    type: 'object',
    description:
      '`status` is lifecycle, NOT stock: a draft product is unpublished, not unavailable. `priceFrom`/`priceTo` are null when nothing is priced.',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Server-minted UUID. The SKU is the human-readable handle.' },
      is_deleted: { type: 'boolean', default: false },
      deletedAt: { type: 'string', format: 'date-time', nullable: true },
      sku: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      brand: { type: 'string' },
      typeId: { type: 'string' },
      categoryIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Many, not one: a watch belongs in "Watches" and in "Gifts".',
      },
      attributes: {
        type: 'array',
        items: { $ref: '#/components/schemas/V2Attribute' },
        description: 'The non variant-forming fields — true of the product as a whole.',
      },
      status: { type: 'string', enum: ['draft', 'active', 'archived'] },
      image: { type: 'string' },
      media: { type: 'array', items: { type: 'string' } },
      commerce: { $ref: '#/components/schemas/V2Commerce' },
      items: { type: 'array', items: { $ref: '#/components/schemas/V2Item' } },
      priceFrom: { type: 'number', nullable: true },
      priceTo: { type: 'number', nullable: true },
      currency: { type: 'string' },
      available: { type: 'boolean' },
      availabilityLabel: { type: 'string' },
    },
  },

  V2Price: {
    type: 'object',
    description:
      'A price record, not a field. `priceListId` is what makes customer-specific and B2B pricing possible without duplicating the catalogue; `minQuantity` gives quantity bands; the validity window gives seasonal rates.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      is_deleted: { type: 'boolean', default: false },
      itemId: { type: 'string', format: 'uuid' },
      amount: { type: 'number' },
      currency: { type: 'string' },
      priceListId: { type: 'string', example: 'default', description: 'retail | b2b | staff | default' },
      validFrom: { type: 'string', format: 'date-time', nullable: true },
      validTo: { type: 'string', format: 'date-time', nullable: true },
      minQuantity: { type: 'integer', description: 'The lowest quantity this row applies from.' },
    },
  },

  V2Charge: {
    type: 'object',
    description:
      'Money that is not the price: a fee, a tax, an optional add-on. Deliberately independent of price, so a vehicle quoted on request can still publish a known registration fee.',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Server-minted UUID.' },
      name: {
        type: 'string',
        description:
          'The override key. A nearer scope with the same name replaces a broader one, which is how one category waives a platform-wide fee.',
      },
      label: { type: 'string', example: 'RTO registration' },
      scope: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['category', 'product', 'item'] },
          refId: { type: 'string' },
        },
        description: 'Most specific wins. A category charge applies to everything beneath it.',
      },
      basis: { type: 'string', enum: ['fixed', 'percent', 'per_unit', 'per_time'] },
      amount: { type: 'number', description: 'For fixed, per_unit and per_time.' },
      percent: { type: 'number', description: 'For percent.' },
      percentOf: {
        type: 'string',
        enum: ['base', 'base_plus_charges'],
        description:
          'Declares the order explicitly: a hotel charges GST on the room rate plus the service charge.',
      },
      required: { type: 'boolean' },
      selectable: { type: 'boolean' },
      maxQuantity: { type: 'integer' },
      currency: { type: 'string' },
      priceListId: { type: 'string', nullable: true },
      validFrom: { type: 'string', format: 'date-time', nullable: true },
      validTo: { type: 'string', format: 'date-time', nullable: true },
      showInListing: { type: 'boolean' },
    },
  },

  V2ChargeBreakdown: {
    type: 'object',
    description:
      'The full money picture for one item. `base` may legitimately be null — required charges are still returned and totalled separately, so a storefront can show "Price on request + ₹15,000 registration" rather than hiding both.',
    properties: {
      itemId: { type: 'string' },
      sku: { type: 'string' },
      pricingModel: { type: 'string' },
      priceLabel: { type: 'string', nullable: true },
      base: { type: 'number', nullable: true },
      currency: { type: 'string' },
      required: { type: 'array', items: { $ref: '#/components/schemas/V2ResolvedCharge' } },
      optional: { type: 'array', items: { $ref: '#/components/schemas/V2ResolvedCharge' } },
      totalRequired: {
        type: 'number',
        nullable: true,
        description:
          'Null when the base is unknown or a required percentage could not be computed. A partial total presented as a full one is worse than none.',
      },
      note: { type: 'string', nullable: true },
    },
  },

  V2ResolvedCharge: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      label: { type: 'string' },
      basis: { type: 'string' },
      amount: {
        type: 'number',
        nullable: true,
        description: 'Null with a `note` when a percentage cannot be computed without a base price.',
      },
      required: { type: 'boolean' },
      selectable: { type: 'boolean' },
      maxQuantity: { type: 'integer' },
      currency: { type: 'string' },
      showInListing: { type: 'boolean' },
      source: {
        type: 'object',
        description: 'Where it was inherited from, so the UI can say "from Cars".',
        properties: { level: { type: 'string' }, refId: { type: 'string' } },
      },
      note: { type: 'string' },
    },
  },

  V2AvailabilityRow: {
    type: 'object',
    description: 'One stored row. Which fields matter depends on the strategy.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      is_deleted: { type: 'boolean', default: false },
      itemId: { type: 'string', format: 'uuid' },
      locationId: { type: 'string', example: 'default', description: 'A shop, warehouse, room or court.' },
      strategy: {
        type: 'string',
        enum: ['quantity', 'time_slot', 'capacity_per_date', 'unlimited', 'lead_time', 'none'],
      },
      onHand: { type: 'integer' },
      reserved: { type: 'integer' },
      date: { type: 'string', example: '2026-10-14' },
      capacity: { type: 'integer' },
      openingHours: {
        type: 'object',
        additionalProperties: { type: 'string' },
        example: { mon: '09:00-18:00', wed: '09:00-12:00' },
        description: 'A day with no entry is closed, not open all day.',
      },
      slotMinutes: { type: 'integer' },
      resourceId: { type: 'string', description: 'A room, a bay, a court.' },
      inchargeId: { type: 'string', description: 'A doctor, a stylist, a coach.' },
      leadDays: { type: 'integer' },
      note: { type: 'string' },
    },
  },

  V2Slot: {
    type: 'object',
    properties: {
      startsAt: { type: 'string', format: 'date-time' },
      endsAt: { type: 'string', format: 'date-time' },
      available: { type: 'boolean' },
      inchargeId: { type: 'string' },
      resourceId: { type: 'string' },
      locationId: { type: 'string' },
    },
  },

  V2Booking: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      is_deleted: { type: 'boolean', default: false },
      itemId: { type: 'string', format: 'uuid' },
      locationId: { type: 'string' },
      inchargeId: { type: 'string' },
      resourceId: { type: 'string' },
      startsAt: { type: 'string', format: 'date-time' },
      endsAt: { type: 'string', format: 'date-time' },
      customerName: { type: 'string' },
      customerPhone: { type: 'string' },
      customerEmail: { type: 'string' },
      status: {
        type: 'string',
        enum: ['held', 'confirmed', 'cancelled', 'completed'],
        description: 'Cancelling frees the slot; the record survives for the history.',
      },
      notes: { type: 'string' },
    },
  },

  V2Matrix: {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      axes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },

  /* Request bodies, generated from the runtime Zod schemas. */
  V2CreateTypeRequest: bodyOf(createTypeSchema),
  V2UpdateTypeRequest: bodyOf(updateTypeSchema),
  V2AddFieldRequest: bodyOf(addFieldSchema),
  V2UpdateFieldRequest: bodyOf(updateFieldSchema),
  V2CreateCategoryRequest: bodyOf(createV2CategorySchema),
  V2UpdateCategoryRequest: bodyOf(updateV2CategorySchema),
  V2CreateProductRequest: bodyOf(createV2ProductSchema),
  V2UpdateProductRequest: bodyOf(updateV2ProductSchema),
  V2ItemRequest: bodyOf(itemSchema),
  V2MatrixRequest: bodyOf(matrixSchema),
  V2SearchRequest: bodyOf(searchSchema),
  V2CreatePriceRequest: bodyOf(createPriceSchema),
  V2UpdatePriceRequest: bodyOf(updatePriceSchema),
  V2CreateChargeRequest: bodyOf(createChargeSchema),
  V2UpdateChargeRequest: bodyOf(updateChargeSchema),
  V2AvailabilityRequest: bodyOf(upsertAvailabilitySchema),
  V2AdjustStockRequest: bodyOf(adjustStockSchema),
  V2CreateBookingRequest: bodyOf(createBookingSchema),
};

/* ================================================================== paths */

const T = ['Catalogue v2 — Types'];
const C = ['Catalogue v2 — Categories'];
const P = ['Catalogue v2 — Products'];
const M = ['Catalogue v2 — Prices & charges'];
const A = ['Catalogue v2 — Availability'];

export const v2Paths: Record<string, unknown> = {
  '/api/v1/v2/types': {
    get: { tags: T, summary: 'List product types', security: bearer,
           parameters: [param('includeDeleted', 'true also returns soft-deleted rows, each flagged `is_deleted`', { enum: ['true', 'false'] })],
           responses: { 200: pagedOf('V2ProductType'), ...ERRORS } },
    post: {
      tags: T,
      summary: 'Create a product type (Editor)',
      description:
        'Field keys are derived from the labels. Only a `choice` field may be `variantForming`, and a `choice` field with no options is refused.',
      security: bearer,
      requestBody: jsonBody({ $ref: '#/components/schemas/V2CreateTypeRequest' }),
      responses: { 201: one('V2ProductType'), ...ERRORS },
    },
  },
  '/api/v1/v2/types/{id}': {
    get: { tags: T, summary: 'Get a type, with its usage count', security: bearer, parameters: [pathParam('id', 'Type id')], responses: { 200: one('V2ProductType'), ...ERRORS } },
    patch: { tags: T, summary: 'Rename a type (Editor)', security: bearer, parameters: [pathParam('id', 'Type id')], requestBody: jsonBody({ $ref: '#/components/schemas/V2UpdateTypeRequest' }), responses: { 200: one('V2ProductType'), ...ERRORS } },
    delete: { tags: T, summary: 'Soft-delete a type (Admin)', description: 'Refused with 409 while any LIVE product is built from it — products already deleted no longer block it. Soft delete: the row is flagged `is_deleted`, keeps its UUID and is hidden from every ordinary read. Nothing is removed, so anything already pointing at it still resolves. Reversible via the matching restore.', security: bearer, parameters: [pathParam('id', 'Type id')], responses: { 200: one('V2ProductType'), ...ERRORS } },
  },
  '/api/v1/v2/types/{id}/fields': {
    post: {
      tags: T,
      summary: 'Add a field (Editor)',
      description:
        'A field added to a type that already has products is forced optional — marking it required would invalidate every product already saved.',
      security: bearer,
      parameters: [pathParam('id', 'Type id')],
      requestBody: jsonBody({ $ref: '#/components/schemas/V2AddFieldRequest' }),
      responses: { 201: one('V2ProductType'), ...ERRORS },
    },
  },
  '/api/v1/v2/types/{id}/fields/{key}': {
    patch: {
      tags: T,
      summary: 'Edit a field (Editor)',
      description:
        'The key and the type are immutable. Removing an option that items still use is refused with a 409 naming the count.',
      security: bearer,
      parameters: [pathParam('id', 'Type id'), pathParam('key', 'Field key')],
      requestBody: jsonBody({ $ref: '#/components/schemas/V2UpdateFieldRequest' }),
      responses: { 200: one('V2ProductType'), ...ERRORS },
    },
    delete: {
      tags: T,
      summary: 'Deprecate a field (Editor)',
      description:
        'Never a hard delete while data exists: the field is marked deprecated and the stored values survive. A field nothing has used is removed outright, and the message says which happened.',
      security: bearer,
      parameters: [pathParam('id', 'Type id'), pathParam('key', 'Field key')],
      responses: { 200: one('V2ProductType'), ...ERRORS },
    },
  },

  '/api/v1/v2/categories': {
    get: {
      tags: C,
      summary: 'List categories',
      security: bearer,
      parameters: [
        param('tree', 'true returns the nested tree instead of a flat list', { enum: ['true', 'false'] }),
      ],
      responses: { 200: listOf('V2Category'), ...ERRORS },
    },
    post: { tags: C, summary: 'Create a category (Editor)', security: bearer, requestBody: jsonBody({ $ref: '#/components/schemas/V2CreateCategoryRequest' }), responses: { 201: one('V2Category'), ...ERRORS } },
  },
  '/api/v1/v2/categories/{id}': {
    get: { tags: C, summary: 'Get a category with its ancestors, children and inherited fields', security: bearer, parameters: [pathParam('id', 'Category id')], responses: { 200: one('V2Category'), ...ERRORS } },
    patch: { tags: C, summary: 'Update a category (Editor)', description: 'A parent change that would create a cycle is refused with 422.', security: bearer, parameters: [pathParam('id', 'Category id')], requestBody: jsonBody({ $ref: '#/components/schemas/V2UpdateCategoryRequest' }), responses: { 200: one('V2Category'), ...ERRORS } },
    delete: { tags: C, summary: 'Soft-delete a category (Admin)', description: 'Refused while it has live children or live products, and the message says which. Soft delete: the row is flagged `is_deleted`, keeps its UUID and is hidden from every ordinary read. Nothing is removed, so anything already pointing at it still resolves. Reversible via the matching restore.', security: bearer, parameters: [pathParam('id', 'Category id')], responses: { 200: one('V2Category'), ...ERRORS } },
  },

  '/api/v1/v2/products': {
    get: {
      tags: P,
      summary: 'List products',
      description:
        'Attribute filters are namespaced: `attr.colour=Blue,Green`. The namespace is what stops a field called "status" colliding with the built-in status filter.',
      security: bearer,
      parameters: [
        param('page', 'Clamped to 1 if lower', { type: 'integer' }),
        param('limit', 'Max 100', { type: 'integer' }),
        param('search', 'Matches the product and its items'),
        param('categoryId', 'Includes the whole subtree beneath it'),
        param('typeId', 'Filter by product type'),
        param('brand', 'Exact, case-insensitive'),
        param('status', 'draft | active | archived'),
        param('priceMin', 'Against the item price range', { type: 'number' }),
        param('priceMax', 'Against the item price range', { type: 'number' }),
        param('inStockOnly', 'true hides everything unavailable', { enum: ['true', 'false'] }),
        param('priceListId', 'Which price book to resolve against'),
        param('sortBy', 'name | createdAt | updatedAt | sku | brand'),
        param('sortOrder', 'asc | desc', { enum: ['asc', 'desc'] }),
      ],
      responses: { 200: pagedOf('V2Product'), ...ERRORS },
    },
    post: {
      tags: P,
      summary: 'Create a product with its items (Editor)',
      description:
        'Attributes are validated against the type — an undeclared key or a value outside the declared options is a 422. `items[].price` and `items[].stock` are a convenience that writes the price and availability records; omitting them writes nothing, which is how "not priced yet" stays distinct from "priced at zero". A product with no variant axes still gets exactly one item.',
      security: bearer,
      requestBody: jsonBody({ $ref: '#/components/schemas/V2CreateProductRequest' }),
      responses: { 201: one('V2Product'), ...ERRORS },
    },
  },
  '/api/v1/v2/products/search': {
    post: {
      tags: P,
      summary: 'Search with nested filters and facets',
      description:
        'The same filters as the GET, but nestable. `facets: true` adds the filter sidebar, built by aggregation over the items that actually match — not by `distinct()`, which ignores the current filter and returns no counts.',
      security: bearer,
      requestBody: jsonBody({ $ref: '#/components/schemas/V2SearchRequest' }),
      responses: { 200: pagedOf('V2Product'), ...ERRORS },
    },
  },
  '/api/v1/v2/products/matrix': {
    post: {
      tags: P,
      summary: 'Preview the combination matrix (Editor)',
      description:
        'Saves nothing. Generation is offered, not imposed: a dealership does not stock every trim in every colour, so the UI generates the grid and the user prunes it before posting.',
      security: bearer,
      requestBody: jsonBody({ $ref: '#/components/schemas/V2MatrixRequest' }),
      responses: { 200: one('V2Matrix'), ...ERRORS },
    },
  },
  '/api/v1/v2/products/{id}': {
    get: { tags: P, summary: 'Get a product with its items, prices, availability and fields', security: bearer, parameters: [pathParam('id', 'Product id'), param('priceListId', 'Which price book to resolve against')], responses: { 200: one('V2Product'), ...ERRORS } },
    patch: { tags: P, summary: 'Update a product (Editor)', description: 'Partial: a required field the caller did not send is untouched, not an error.', security: bearer, parameters: [pathParam('id', 'Product id')], requestBody: jsonBody({ $ref: '#/components/schemas/V2UpdateProductRequest' }), responses: { 200: one('V2Product'), ...ERRORS } },
    delete: { tags: P, summary: 'Soft-delete a product (Admin)', description: 'Cascades to its items and their price and availability rows, all stamped with one timestamp so the restore can reverse exactly this cascade. Soft delete: the row is flagged `is_deleted`, keeps its UUID and is hidden from every ordinary read. Nothing is removed, so anything already pointing at it still resolves. Reversible via the matching restore. Its SKU is freed for reuse immediately, because SKU uniqueness is partial over live rows only.', security: bearer, parameters: [pathParam('id', 'Product id')], responses: { 200: one('V2Product'), ...ERRORS } },
  },
  '/api/v1/v2/products/{id}/items': {
    get: { tags: P, summary: 'List a product’s items', security: bearer, parameters: [pathParam('id', 'Product id')], responses: { 200: listOf('V2Item'), ...ERRORS } },
    post: { tags: P, summary: 'Add an item (Editor)', description: 'A combination that already exists is a 409, regardless of the order the attributes were sent in.', security: bearer, parameters: [pathParam('id', 'Product id')], requestBody: jsonBody({ $ref: '#/components/schemas/V2ItemRequest' }), responses: { 201: one('V2Item'), ...ERRORS } },
  },
  '/api/v1/v2/products/{id}/items/{itemId}': {
    patch: { tags: P, summary: 'Update an item (Editor)', security: bearer, parameters: [pathParam('id', 'Product id'), pathParam('itemId', 'Item id')], requestBody: jsonBody({ $ref: '#/components/schemas/V2ItemRequest' }), responses: { 200: one('V2Item'), ...ERRORS } },
    delete: { tags: P, summary: 'Soft-delete an item (Editor)', description: 'The last live item of a product cannot be deleted — it is where price and stock live. Delete the product instead. Soft delete: the row is flagged `is_deleted`, keeps its UUID and is hidden from every ordinary read. Nothing is removed, so anything already pointing at it still resolves. Reversible via the matching restore.', security: bearer, parameters: [pathParam('id', 'Product id'), pathParam('itemId', 'Item id')], responses: { 200: one('V2Item'), ...ERRORS } },
  },

  '/api/v1/v2/prices': {
    get: { tags: M, summary: 'List price records', security: bearer, parameters: [param('itemId', 'Filter to one item'), param('priceListId', 'Filter to one price book')], responses: { 200: listOf('V2Price'), ...ERRORS } },
    post: { tags: M, summary: 'Create a price record (Editor)', security: bearer, requestBody: jsonBody({ $ref: '#/components/schemas/V2CreatePriceRequest' }), responses: { 201: one('V2Price'), ...ERRORS } },
  },
  '/api/v1/v2/prices/{id}': {
    patch: { tags: M, summary: 'Update a price (Editor)', security: bearer, parameters: [pathParam('id', 'Price id')], requestBody: jsonBody({ $ref: '#/components/schemas/V2UpdatePriceRequest' }), responses: { 200: one('V2Price'), ...ERRORS } },
    delete: { tags: M, summary: 'Soft-delete a price (Editor)', description: 'Soft delete: the row is flagged `is_deleted`, keeps its UUID and is hidden from every ordinary read. Nothing is removed, so anything already pointing at it still resolves. Reversible via the matching restore.', security: bearer, parameters: [pathParam('id', 'Price id')], responses: { 200: one('V2Price'), ...ERRORS } },
  },

  '/api/v1/v2/charges': {
    get: { tags: M, summary: 'List charges', security: bearer, parameters: [param('scope', 'category | product | item', { enum: ['category', 'product', 'item'] }), param('refId', 'The id at that level')], responses: { 200: listOf('V2Charge'), ...ERRORS } },
    post: { tags: M, summary: 'Create a charge (Editor)', description: 'A percent charge needs `percent`; every other basis needs `amount`. Either missing would resolve to zero and disappear from every total.', security: bearer, requestBody: jsonBody({ $ref: '#/components/schemas/V2CreateChargeRequest' }), responses: { 201: one('V2Charge'), ...ERRORS } },
  },
  '/api/v1/v2/charges/{id}': {
    patch: { tags: M, summary: 'Update a charge (Editor)', security: bearer, parameters: [pathParam('id', 'Charge id')], requestBody: jsonBody({ $ref: '#/components/schemas/V2UpdateChargeRequest' }), responses: { 200: one('V2Charge'), ...ERRORS } },
    delete: { tags: M, summary: 'Soft-delete a charge (Editor)', description: 'It stops being collected on the next resolve. No total is rewritten retrospectively — an order already quoted at the old figure keeps it. Soft delete: the row is flagged `is_deleted`, keeps its UUID and is hidden from every ordinary read. Nothing is removed, so anything already pointing at it still resolves. Reversible via the matching restore.', security: bearer, parameters: [pathParam('id', 'Charge id')], responses: { 200: one('V2Charge'), ...ERRORS } },
  },

  '/api/v1/v2/items/{itemId}/charges': {
    get: {
      tags: M,
      summary: 'Resolve the price and every applicable charge',
      description:
        'Charges are collected from the item, its product and its categories with their ancestors; a nearer charge with the same `name` overrides a broader one. Percentages run after the fixed charges, and `percentOf: base_plus_charges` sees the required ones already settled — so a hotel taxes the room rate plus the service charge, in a declared order rather than an accidental one.',
      security: bearer,
      parameters: [
        pathParam('itemId', 'Item id'),
        param('priceListId', 'Which price book to resolve against'),
        param('at', 'ISO instant — resolve prices and charges as of this moment'),
        param('quantity', 'Selects the quantity band', { type: 'integer' }),
        param('units', 'Nights, hours or units — what per_unit and per_time multiply by', { type: 'integer' }),
      ],
      responses: { 200: one('V2ChargeBreakdown'), ...ERRORS },
    },
  },
  '/api/v1/v2/items/{itemId}/availability': {
    get: { tags: A, summary: 'Resolve availability for one item', description: 'Applies the strategy its category declares. No row at all means "not tracked", NOT "sold out".', security: bearer, parameters: [pathParam('itemId', 'Item id'), param('locationId', 'Narrow to one location'), param('date', 'YYYY-MM-DD — required by capacity_per_date')], responses: { 200: one('V2Availability'), ...ERRORS } },
  },
  '/api/v1/v2/items/{itemId}/slots': {
    get: {
      tags: A,
      summary: 'The bookable slots on a date',
      description:
        'A slot is free when the schedule opens it and nothing overlaps it. `inchargeId` narrows to one person’s calendar — "book with Dr Mehta"; omitting it searches every configured one — "3pm with anyone". Booked slots are returned marked unavailable, because a greyed-out 3pm is more useful than an unexplained gap.',
      security: bearer,
      parameters: [
        pathParam('itemId', 'Item id'),
        param('date', 'YYYY-MM-DD (required)'),
        param('locationId', 'Narrow to one location'),
        param('inchargeId', 'Narrow to one person'),
        param('resourceId', 'Narrow to one room, bay or court'),
        param('durationMinutes', 'Override the configured slot length', { type: 'integer' }),
        param('availableOnly', 'true drops the booked slots', { enum: ['true', 'false'] }),
      ],
      responses: { 200: one('V2Slot'), ...ERRORS },
    },
  },

  '/api/v1/v2/availability': {
    get: { tags: A, summary: 'List availability rows', security: bearer, parameters: [param('itemId', 'Filter to one item'), param('locationId', 'Filter to one location'), param('date', 'YYYY-MM-DD')], responses: { 200: listOf('V2AvailabilityRow'), ...ERRORS } },
    post: { tags: A, summary: 'Create or replace an availability row (Editor)', description: 'Keyed on item + location + date, so re-posting a day’s capacity updates it rather than stacking a second row that silently doubles it. Each strategy requires the field it cannot work without.', security: bearer, requestBody: jsonBody({ $ref: '#/components/schemas/V2AvailabilityRequest' }), responses: { 201: one('V2AvailabilityRow'), ...ERRORS } },
  },
  '/api/v1/v2/availability/adjust': {
    post: {
      tags: A,
      summary: 'Move stock by a delta (Editor)',
      description:
        'Signed: -2 sells two, +10 receives ten. A delta rather than an absolute figure because two concurrent sales that each read 10 and write 9 lose a unit. Overselling is a 409 naming what is actually on hand, and nothing is written.',
      security: bearer,
      requestBody: jsonBody({ $ref: '#/components/schemas/V2AdjustStockRequest' }),
      responses: { 200: one('V2AvailabilityRow'), ...ERRORS },
    },
  },
  '/api/v1/v2/availability/{id}': {
    delete: { tags: A, summary: 'Soft-delete an availability row (Editor)', description: 'Soft delete: the row is flagged `is_deleted`, keeps its UUID and is hidden from every ordinary read. Nothing is removed, so anything already pointing at it still resolves. Reversible via the matching restore.', security: bearer, parameters: [pathParam('id', 'Availability row id')], responses: { 200: one('V2AvailabilityRow'), ...ERRORS } },
  },

  '/api/v1/v2/bookings': {
    get: { tags: A, summary: 'List bookings', security: bearer, parameters: [param('itemId', 'Filter to one item'), param('inchargeId', 'Filter to one person'), param('status', 'held | confirmed | cancelled | completed'), param('from', 'ISO instant'), param('to', 'ISO instant')], responses: { 200: pagedOf('V2Booking'), ...ERRORS } },
    post: { tags: A, summary: 'Create a booking', description: 'A time_slot item is checked for an overlap on the same person or resource; a capacity_per_date item is checked against the remaining capacity for that date. Either failure is a 409.', security: bearer, requestBody: jsonBody({ $ref: '#/components/schemas/V2CreateBookingRequest' }), responses: { 201: one('V2Booking'), ...ERRORS } },
  },
  '/api/v1/v2/bookings/{id}/cancel': {
    post: { tags: A, summary: 'Cancel a booking', description: 'Cancelled, not deleted: the slot frees up because cancelled bookings are excluded from the overlap query, and the record survives for the history.', security: bearer, parameters: [pathParam('id', 'Booking id')], responses: { 200: one('V2Booking'), ...ERRORS } },
  },

  '/api/v1/v2/types/{id}/restore': {
    post: { tags: T, summary: 'Restore a soft-deleted type (Admin)', description: 'A restore on a row that is not deleted is a 409.', security: bearer, parameters: [pathParam('id', 'Type id')], responses: { 200: one('V2ProductType'), ...ERRORS } },
  },
  '/api/v1/v2/categories/{id}/restore': {
    post: { tags: C, summary: 'Restore a soft-deleted category (Admin)', description: 'If its parent is still deleted the restore succeeds but says so — the category would otherwise come back detached from the tree and be unreachable in the UI.', security: bearer, parameters: [pathParam('id', 'Category id')], responses: { 200: one('V2Category'), ...ERRORS } },
  },
  '/api/v1/v2/products/{id}/restore': {
    post: { tags: P, summary: 'Restore a soft-deleted product (Admin)', description: 'Reverses the cascade: the items, prices and availability rows that went down WITH this product come back, matched on the exact deletion timestamp. An item deleted deliberately beforehand stays deleted, rather than being silently resurrected.', security: bearer, parameters: [pathParam('id', 'Product id')], responses: { 200: one('V2Product'), ...ERRORS } },
  },
  '/api/v1/v2/prices/{id}/restore': {
    post: { tags: M, summary: 'Restore a soft-deleted price (Editor)', security: bearer, parameters: [pathParam('id', 'Price id')], responses: { 200: one('V2Price'), ...ERRORS } },
  },
  '/api/v1/v2/charges/{id}/restore': {
    post: { tags: M, summary: 'Restore a soft-deleted charge (Editor)', security: bearer, parameters: [pathParam('id', 'Charge id')], responses: { 200: one('V2Charge'), ...ERRORS } },
  },
  '/api/v1/v2/availability/{id}/restore': {
    post: { tags: A, summary: 'Restore a soft-deleted availability row (Editor)', security: bearer, parameters: [pathParam('id', 'Availability row id')], responses: { 200: one('V2AvailabilityRow'), ...ERRORS } },
  },
};

export const v2Tags = [
  {
    name: 'Catalogue v2 — Types',
    description:
      'The Setup tab. A type declares what fields a product has, so validation is driven by configuration rather than by code. Nothing else can be built first.',
  },
  {
    name: 'Catalogue v2 — Categories',
    description:
      'The tree, and the commerce config products inherit from it. Declaring "cars are quoted on request with a lead time" once is what lets one platform serve a shop, a dealership and a clinic.',
  },
  {
    name: 'Catalogue v2 — Products',
    description:
      'Products and the items beneath them. An item is the thing actually sold; a product with no variant axes still has exactly one.',
  },
  {
    name: 'Catalogue v2 — Prices & charges',
    description:
      'Price and charge are records, not fields — which is what makes price lists, seasonal windows, quantity bands and fees-without-a-price all expressible in one model.',
  },
  {
    name: 'Catalogue v2 — Availability',
    description:
      'Six strategies instead of a stock number, plus slots and bookings. "Is this available" means something different for a t-shirt, a hotel room on the 14th and a 3pm with a named doctor.',
  },
];
