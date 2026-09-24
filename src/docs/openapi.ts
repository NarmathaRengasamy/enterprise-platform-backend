import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { loginSchema, registerSchema } from '../controllers/auth.controller.js';
import {
  bulkDeleteSchema,
  createCategorySchema,
  updateCategorySchema,
} from '../controllers/category.controller.js';
import {
  createConversationSchema,
  sendMessageSchema,
} from '../controllers/conversation.controller.js';
import {
  createEndpointSchema,
  updateEndpointSchema,
} from '../controllers/developer.controller.js';
import { savePlatformConnectionSchema } from '../controllers/platform.controller.js';
import {
  createFolderSchema,
  uploadMarkdownSchema,
} from '../controllers/kb.controller.js';
import { setAgentStatusSchema } from '../controllers/perfox.controller.js';
import { generateCatalogSchema } from '../controllers/kb.controller.js';
import { saveOperatorSiteSchema } from '../controllers/platform.controller.js';
import {
  sendOutboundSchema,
  startConversationSchema,
} from '../controllers/conversation.controller.js';
import { createProductSchema, updateProductSchema } from '../controllers/product.controller.js';
import { createEventSchema, updateEventSchema } from '../controllers/schedule.controller.js';
import { addMemberSchema, updateMemberSchema } from '../controllers/team.controller.js';

/**
 * OpenAPI 3.0 document for the Express service.
 *
 * Request bodies are generated from the same Zod schemas `validateRequest()`
 * enforces at runtime, so the documentation cannot drift from the validation:
 * change a schema and the docs change with it.
 *
 * Paths are declared here because Express carries no route metadata to read.
 */

/* validateRequest wraps everything in { body, query, params }; the docs only
   want the body half. */
const bodyOf = (schema: z.ZodTypeAny): Record<string, unknown> => {
  const shape = (schema as any)?._def?.shape?.();
  const body = shape?.body ?? schema;
  return zodToJsonSchema(body, { $refStrategy: 'none', target: 'openApi3' }) as Record<string, unknown>;
};

/* ------------------------------------------------------------------ pieces */

const bearer = [{ bearerAuth: [] }];

const envelope = (dataSchema: Record<string, unknown>) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    message: { type: 'string' },
    data: dataSchema,
  },
});

const listEnvelope = (itemRef: string) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    total: { type: 'integer', example: 8 },
    page: { type: 'integer', example: 1 },
    limit: { type: 'integer', example: 20 },
    totalPages: { type: 'integer', example: 1 },
    data: { type: 'array', items: { $ref: `#/components/schemas/${itemRef}` } },
  },
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

const COMMON_ERRORS = {
  401: errorResponse('Missing or invalid token', 'Authentication token required'),
  403: errorResponse('Role lacks permission', 'You do not have permission to perform this action'),
};

const okResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema } },
});

/* Standard list query parameters, shared by every paginated endpoint. */
const listParams = (extra: Array<Record<string, unknown>> = []) => [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 }, description: 'Clamped to 1 if lower.' },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'search', in: 'query', schema: { type: 'string' } },
  { name: 'sortBy', in: 'query', schema: { type: 'string' }, description: 'Allowlisted per resource; anything else is ignored.' },
  { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
  ...extra,
];

const pathId = (description = 'Resource id') => ({
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description,
});

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } },
});

/* --------------------------------------------------------------- responses */

const listOf = (ref: string) => okResponse('Paginated list', listEnvelope(ref));
const oneOf = (ref: string) =>
  okResponse('Single resource', envelope({ $ref: `#/components/schemas/${ref}` }));

/* ------------------------------------------------------------------ schemas */

const schemas: Record<string, unknown> = {
  ErrorResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      message: { type: 'string' },
      errors: {
        type: 'array',
        description: 'Present on a Zod validation failure.',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, message: { type: 'string' } },
        },
      },
    },
  },

  User: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'usr-001' },
      name: { type: 'string', example: 'Sarah Jenkins' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['Admin', 'Editor', 'Viewer'] },
      department: { type: 'string' },
      status: { type: 'string', enum: ['Active', 'Pending', 'Inactive'] },
      avatar: { type: 'string' },
    },
  },

  Product: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'PRD001' },
      name: { type: 'string' },
      sku: { type: 'string', example: 'PRD001' },
      categoryId: { type: 'string', example: 'CAT-001', description: 'Foreign key to Category.id.' },
      category: {
        type: 'string',
        example: 'Electronics',
        description: 'Display name, derived by the server from categoryId. Never accepted from a client.',
      },
      categoryCode: { type: 'string', deprecated: true, description: 'Mirror of categoryId.' },
      price: {
        type: 'number',
        example: 1299,
        description:
          'OPTIONAL. Absent when the offering has not been priced yet — an offering can be created before anyone has decided what it costs. With variants and no base price, this is the cheapest PRICED variant; absent when none of them carry a price.',
      },
      originalPrice: { type: 'number' },
      stock: {
        type: 'integer',
        example: 142,
        description:
          'OPTIONAL and never defaulted. Absent means the figure is UNKNOWN, which is not the same as 0 on the shelf. With variants, this is the sum of the variants that actually carry a capacity; absent when none do.',
      },
      stockStatus: {
        type: 'string',
        enum: ['In Stock', 'Low Stock', 'Out of Stock', 'Unspecified'],
        description:
          '`Unspecified` when no stock figure has been entered. A distinct value rather than an absent one, so it can be filtered, counted and displayed like any other. Never report an unknown stock as `Out of Stock` — sold out is a claim about the shelf, an empty field is a claim about the form.',
      },
      committed: { type: 'integer' },
      reorderPoint: { type: 'integer' },
      margin: { type: 'string', example: '54.2%' },
      discount: { type: 'string' },
      image: { type: 'string' },
      description: { type: 'string' },
      gallery: { type: 'array', items: { type: 'object' } },
      videos: { type: 'array', items: { type: 'object' } },
      variants: { type: 'array', items: { type: 'object' } },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Category: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'CAT-001', description: 'Referenced by Product.categoryId.' },
      name: { type: 'string', example: 'Electronics' },
      description: { type: 'string' },
      productsCount: { type: 'integer', description: 'Derived from the products collection on read.' },
      icon: { type: 'string' },
      color: { type: 'string' },
      updated: { type: 'string' },
    },
  },

  Conversation: {
    type: 'object',
    description:
      'A thread from the Perfox workspace, enriched server-side: the customer record supplies `name`/`customerPhone`/`customerEmail`, and the agent supplies `agentName` and `agentChannels` — which is what decides the channels the composer may offer.',
    properties: {
      agentId: { type: 'string', description: 'The Perfox agent that handled it (its workflowId).' },
      agentName: { type: 'string' },
      agentChannels: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Informational: the channel list as GET /agents reports it. Not the gate — it does not report every trigger.',
      },
      agentSenderChannels: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Informational: the sender nodes wired on the agent canvas. Not the gate.',
      },
      agentTriggerChannels: {
        type: 'array',
        items: { type: 'string' },
        description:
          "THE GATE for POST /{id}/send. The channels named by the agent's trigger nodes, read from GET /agents/{id} when this conversation is opened (cached 60s) and so present only on the detail response, never on list rows. A channel absent here is shown disabled in the composer and refused with 409 by the server. Webhook triggers are not counted for now.",
      },
      agentStatus: {
        type: 'string',
        description: 'Only a published agent may send.',
      },
      customerName: { type: 'string' },
      customerEmail: { type: 'string' },
      customerPhone: { type: 'string' },
      customerTags: { type: 'array', items: { type: 'string' } },
      customerKnown: { type: 'boolean', description: 'False for an anonymous visitor.' },
      id: { type: 'string', example: 'convo-1' },
      name: { type: 'string' },
      channel: { type: 'string', enum: ['whatsapp', 'sms', 'email', 'voice', 'web'] },
      channelLabel: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      unread: { type: 'integer' },
      timestamp: { type: 'string' },
      lastMessage: { type: 'string' },
      messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
    },
  },

  Message: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      sender: { type: 'string', enum: ['me', 'them', 'system'] },
      text: { type: 'string' },
      time: { type: 'string', example: '10:42 AM' },
      channel: { type: 'string' },
      attachment: { type: 'object' },
    },
  },

  ScheduleEvent: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'ev-1' },
      title: { type: 'string' },
      time: { type: 'string', example: '09:00 AM - 10:00 AM' },
      startTime: { type: 'string' },
      endTime: { type: 'string' },
      dateKey: { type: 'string', example: '2026-09-17' },
      client: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      attendee: { type: 'string' },
      participantType: { type: 'string', enum: ['human', 'agent', 'customer'] },
      type: { type: 'string' },
      location: { type: 'string' },
      status: { type: 'string', enum: ['Confirmed', 'Pending', 'Cancelled', 'Completed'] },
      notes: { type: 'string' },
    },
  },



  Agent: {
    type: 'object',
    description:
      'A cached copy of an agent in the connected Perfox workspace. Every field mirrors what Perfox reports; this service stores no configuration of its own against an agent.',
    properties: {
      id: { type: 'string', example: '01a09017-e57c-753a-801a-6bc6c13c13ca', description: 'The Perfox agent id.' },
      name: { type: 'string' },
      description: { type: 'string' },
      status: {
        type: 'string',
        enum: ['published', 'paused', 'draft'],
        description: "Perfox's own vocabulary, stored verbatim.",
      },
      channels: { type: 'array', items: { type: 'string' }, example: ['web'] },
      activeVersion: { type: 'integer' },
      nodeCount: { type: 'integer' },
      perfoxCreatedAt: { type: 'string', format: 'date-time' },
      perfoxUpdatedAt: { type: 'string', format: 'date-time' },
      syncedAt: {
        type: 'string',
        format: 'date-time',
        description: 'When this row was last refreshed from Perfox.',
      },
    },
  },

  Endpoint: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'ep-1' },
      name: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      transport: { type: 'string', enum: ['HTTP', 'SSE', 'WebSocket'] },
      authType: { type: 'string', enum: ['none', 'bearer', 'apiKey', 'basic'] },
      authConfig: { type: 'object', description: 'Credentials are masked on read.' },
      status: { type: 'string', enum: ['Healthy', 'Degraded', 'Offline'] },
      latency: { type: 'string' },
      connectedAgentsCount: { type: 'integer', description: 'Derived from agent assignments.' },
      lastPingStatus: { type: 'string' },
      lastPingTime: { type: 'string' },
    },
  },

  PlatformConnection: {
    type: 'object',
    description:
      'The connection this tenant holds to Perfox. A singleton — one row, keyed `perfox`. The API token is never returned, only the masked hint in `apiTokenMasked`.',
    properties: {
      configured: { type: 'boolean', description: 'False when nothing is configured; every other field is then empty.' },
      apiUrl: { type: 'string', format: 'uri', example: 'https://pradeepworkspace-api.perfox.ai/api/v1' },
      apiTokenMasked: { type: 'string', example: 'sk_****d457' },
      workspace: { type: 'string', example: 'pradeepworkspace', description: 'Derived from the API URL host.' },
      status: { type: 'string', enum: ['Connected', 'Unverified', 'Error'] },
      lastVerifiedAt: { type: 'string', format: 'date-time' },
      lastError: { type: 'string', description: 'Why the last verification failed; empty when it succeeded.' },
      connectedBy: { type: 'string', format: 'email' },
      updatedAt: { type: 'string', format: 'date-time' },
      source: {
        type: 'string',
        enum: ['stored', 'env', 'none'],
        description: 'Where the connection in force came from. A stored row always wins over the environment.',
      },
      verifyPath: { type: 'string', example: '/kb/folders', description: 'The Perfox path used to verify the credentials.' },
    },
  },

  PlatformVerification: {
    type: 'object',
    description: 'The result of calling Perfox. A rejected connection is a result, not an error — this never carries a non-200 HTTP status of its own.',
    properties: {
      ok: { type: 'boolean' },
      reachable: { type: 'boolean' },
      httpStatus: { type: 'integer', nullable: true, description: 'Null when the host never answered.' },
      message: { type: 'string', description: 'Empty when the check succeeded.' },
      latencyMs: { type: 'integer' },
    },
  },

  KbFolder: {
    type: 'object',
    description:
      "A folder in the Perfox knowledge base, read live. Perfox answers in snake_case and carries a large `index` block — the file manifest, entity lists and hashes — which is dropped at the boundary; only the count and summary survive.",
    properties: {
      id: { type: 'string', example: '01a0c813-682c-779f-9df8-23fb62f25368' },
      name: { type: 'string', example: 'folder_CRM' },
      parentId: { type: 'string', nullable: true, description: 'Null at the root.' },
      depth: { type: 'integer', description: 'Depth in the tree, 0 at the root. Indent a picker by this.' },
      displayPath: { type: 'string', description: "Readable ancestry, e.g. 'Company Docs / Nested'. `path` is ids." },
      path: { type: 'string', description: 'Ancestry as ids, as Perfox reports it.' },
      fileCount: { type: 'integer', description: 'Read from the `index.file_count` Perfox reports.' },
      summary: { type: 'string', description: "Perfox's generated description of the contents, when it has one." },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  KbFile: {
    type: 'object',
    description:
      'A file in the selected Perfox knowledge-base folder. Assembled per row from `GET /kb/files/{id}` — Perfox offers no endpoint that lists files.',
    properties: {
      id: { type: 'string', example: '01a0a375-1eeb-743f-a5a7-f33868768d5f' },
      name: { type: 'string', example: 'refund-policy.md' },
      mimeType: { type: 'string', example: 'text/markdown', description: 'Perfox’s `mime_type`.' },
      sizeBytes: { type: 'integer', example: 9132 },
      status: {
        type: 'string',
        example: 'active',
        description:
          'Ingestion state, passed through from Perfox. `active` is indexed and searchable; `error` was stored but never indexed, so it answers nothing. A transient processing state is likely between the two.',
      },
      chunkCount: { type: 'integer', description: 'Chunks the file was split into. 0 with `error` means nothing is searchable.' },
      folderId: { type: 'string' },
      folderName: { type: 'string', example: 'Root level', description: 'The folder it lives in.' },
      uploadedAt: { type: 'string', format: 'date-time', description: 'Perfox’s `created_at`.' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  // Request bodies, generated from the Zod schemas the routes actually enforce.
  LoginRequest: bodyOf(loginSchema),
  RegisterRequest: bodyOf(registerSchema),
  CreateProductRequest: bodyOf(createProductSchema),
  UpdateProductRequest: bodyOf(updateProductSchema),
  CreateCategoryRequest: bodyOf(createCategorySchema),
  UpdateCategoryRequest: bodyOf(updateCategorySchema),
  BulkDeleteRequest: bodyOf(bulkDeleteSchema),
  CreateConversationRequest: bodyOf(createConversationSchema),
  SendMessageRequest: bodyOf(sendMessageSchema),
  CreateEventRequest: bodyOf(createEventSchema),
  UpdateEventRequest: bodyOf(updateEventSchema),
  AddMemberRequest: bodyOf(addMemberSchema),
  UpdateMemberRequest: bodyOf(updateMemberSchema),
  SavePlatformConnectionRequest: bodyOf(savePlatformConnectionSchema),
  SetAgentStatusRequest: bodyOf(setAgentStatusSchema),
  GenerateCatalogRequest: bodyOf(generateCatalogSchema),
  SendOutboundRequest: bodyOf(sendOutboundSchema),
  StartConversationRequest: bodyOf(startConversationSchema),
  SaveOperatorSiteRequest: bodyOf(saveOperatorSiteSchema),
  CreateFolderRequest: bodyOf(createFolderSchema),
  UploadMarkdownRequest: bodyOf(uploadMarkdownSchema),
  CreateEndpointRequest: bodyOf(createEndpointSchema),
  UpdateEndpointRequest: bodyOf(updateEndpointSchema),
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/* -------------------------------------------------------------------- paths */

const paths: Record<string, unknown> = {
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Sign in',
      security: [],
      description:
        'Returns a JWT. `rememberMe` buys the configured session length (7d); without it the token lasts 12h.',
      requestBody: jsonBody(ref('LoginRequest')),
      responses: {
        200: okResponse(
          'Signed in',
          envelope({
            type: 'object',
            properties: {
              token: { type: 'string' },
              expiresIn: { type: 'string', example: '7d' },
              user: ref('User'),
            },
          })
        ),
        401: errorResponse('Bad credentials', 'Invalid email or password credentials'),
        422: errorResponse('Validation failed', 'Validation failed'),
      },
    },
  },
  '/auth/register': {
    post: {
      tags: ['Auth'],
      summary: 'Create an account',
      security: [],
      requestBody: jsonBody(ref('RegisterRequest')),
      responses: {
        201: oneOf('User'),
        409: errorResponse('Email taken', 'A user with this email already exists'),
      },
    },
  },
  '/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'The signed-in user',
      security: bearer,
      responses: { 200: oneOf('User'), ...COMMON_ERRORS },
    },
  },

  '/dashboard/metrics': {
    get: {
      tags: ['Dashboard'],
      summary: 'KPI counters',
      security: bearer,
      responses: { 200: okResponse('Metrics', envelope({ type: 'object' })), ...COMMON_ERRORS },
    },
  },
  '/dashboard/overview': {
    get: {
      tags: ['Dashboard'],
      summary: 'Metrics plus the recent products, appointments and conversations',
      security: bearer,
      responses: { 200: okResponse('Overview', envelope({ type: 'object' })), ...COMMON_ERRORS },
    },
  },

  '/products': {
    get: {
      tags: ['Products'],
      summary: 'List products',
      security: bearer,
      parameters: listParams([
        { name: 'categoryId', in: 'query', schema: { type: 'string' }, description: 'Preferred: filter by the category id.' },
        { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Legacy: filter by category name.' },
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string', enum: ['In Stock', 'Low Stock', 'Out of Stock', 'Unspecified'] },
          description: 'Filter by stock status. A product with no stock figure matches only `Unspecified`.',
        },
      ]),
      responses: { 200: listOf('Product'), ...COMMON_ERRORS },
    },
    post: {
      tags: ['Products'],
      summary: 'Create a product',
      description:
        'Requires `categoryId`; the server resolves it and derives `category`. **`price` and `stock` are both optional**, on the offering and on every variant: an offering can be created before it has been priced or counted. Do NOT send `0` for a value nobody entered — omit the field. A sent `0` is a real figure and will be treated as free, or as sold out. With variants and no base price, the listing price is the cheapest variant that has one, and the stock is the sum of the variants that carry a capacity; both stay absent when none do. Stock status derives to `Unspecified` when there is no stock figure.',
      security: bearer,
      requestBody: jsonBody(ref('CreateProductRequest')),
      responses: {
        201: oneOf('Product'),
        400: errorResponse('Bad pricing or unknown category', 'categoryId "CAT-999" does not match any category'),
        409: errorResponse('Duplicate SKU', 'A record with that sku already exists'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/products/stats': {
    get: {
      tags: ['Products'],
      summary: 'Catalog-wide counters (never page-scoped)',
      security: bearer,
      responses: {
        200: okResponse(
          'Stats',
          envelope({
            type: 'object',
            properties: {
              total: { type: 'integer' },
              inStock: { type: 'integer' },
              lowStock: { type: 'integer' },
              outOfStock: { type: 'integer' },
              stockNotSet: {
                type: 'integer',
                description:
                  'Products with no stock figure (stockStatus `Unspecified`). Include it: the four counts sum to `total`, and leaving it out makes the tiles appear not to add up.',
              },
              categoriesCount: { type: 'integer' },
              inStockPercentage: { type: 'integer' },
            },
          })
        ),
        ...COMMON_ERRORS,
      },
    },
  },
  '/products/export': {
    get: {
      tags: ['Products'],
      summary: 'CSV of the filtered set',
      security: bearer,
      parameters: [
        { name: 'categoryId', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'search', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'CSV file', content: { 'text/csv': { schema: { type: 'string' } } } },
        ...COMMON_ERRORS,
      },
    },
  },
  '/products/{id}': {
    get: {
      tags: ['Products'],
      summary: 'One product, including gallery, videos and variants',
      security: bearer,
      parameters: [pathId('Product id (the SKU)')],
      responses: { 200: oneOf('Product'), 404: errorResponse('Missing', 'Product not found'), ...COMMON_ERRORS },
    },
    put: {
      tags: ['Products'],
      summary: 'Replace a product',
      security: bearer,
      parameters: [pathId()],
      requestBody: jsonBody(ref('UpdateProductRequest')),
      responses: { 200: oneOf('Product'), 404: errorResponse('Missing', 'Product not found'), ...COMMON_ERRORS },
    },
    patch: {
      tags: ['Products'],
      summary: 'Partially update a product',
      security: bearer,
      parameters: [pathId()],
      requestBody: jsonBody(ref('UpdateProductRequest')),
      responses: { 200: oneOf('Product'), 404: errorResponse('Missing', 'Product not found'), ...COMMON_ERRORS },
    },
    delete: {
      tags: ['Products'],
      summary: 'Delete a product (Admin)',
      security: bearer,
      parameters: [pathId()],
      responses: { 200: okResponse('Deleted', envelope({ type: 'object' })), 404: errorResponse('Missing', 'Product not found'), ...COMMON_ERRORS },
    },
  },

  '/categories': {
    get: {
      tags: ['Categories'],
      summary: 'List categories',
      description: '`productsCount` is recomputed from the products collection on every read.',
      security: bearer,
      parameters: listParams([
        { name: 'hasProducts', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
      ]),
      responses: { 200: listOf('Category'), ...COMMON_ERRORS },
    },
    post: {
      tags: ['Categories'],
      summary: 'Create a category',
      description: '`id` is optional; a collision-safe one is generated when omitted.',
      security: bearer,
      requestBody: jsonBody(ref('CreateCategoryRequest')),
      responses: { 201: oneOf('Category'), 409: errorResponse('Code taken', 'A category with this code already exists'), ...COMMON_ERRORS },
    },
  },
  '/categories/stats': {
    get: { tags: ['Categories'], summary: 'Totals, top distribution and density', security: bearer, responses: { 200: okResponse('Stats', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/categories/export': {
    get: { tags: ['Categories'], summary: 'CSV export', security: bearer, responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: { type: 'string' } } } }, ...COMMON_ERRORS } },
  },
  '/categories/bulk-delete': {
    post: {
      tags: ['Categories'],
      summary: 'Delete several categories (Admin)',
      description: 'Deletes what it can; a category that still has products is reported as a conflict instead of failing the batch.',
      security: bearer,
      requestBody: jsonBody(ref('BulkDeleteRequest')),
      responses: { 200: okResponse('Result', envelope({ type: 'object' })), ...COMMON_ERRORS },
    },
  },
  '/categories/{id}': {
    get: { tags: ['Categories'], summary: 'One category', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Category'), 404: errorResponse('Missing', 'Category not found'), ...COMMON_ERRORS } },
    put: {
      tags: ['Categories'],
      summary: 'Update a category',
      description: 'Renaming rewrites the denormalised name on every product that references it.',
      security: bearer,
      parameters: [pathId()],
      requestBody: jsonBody(ref('UpdateCategoryRequest')),
      responses: { 200: oneOf('Category'), 404: errorResponse('Missing', 'Category not found'), ...COMMON_ERRORS },
    },
    delete: {
      tags: ['Categories'],
      summary: 'Delete a category (Admin)',
      security: bearer,
      parameters: [pathId()],
      responses: {
        200: okResponse('Deleted', envelope({ type: 'object' })),
        409: errorResponse('Still in use', '2 products are still assigned to this category'),
        ...COMMON_ERRORS,
      },
    },
  },

  '/conversations': {
    get: {
      tags: ['Conversations'],
      summary: 'List threads',
      description:
        'Read from the connected Perfox workspace and mirrored locally as it goes. The list is cached in process for 30 seconds, so it can be up to that old; the thread detail is fetched live on every open. Each row is named from the Perfox customer record — `GET /customers` is fetched once and cached, since it returns only the identified customers and takes no pagination. A customer absent from it is an anonymous visitor and is labelled as such rather than resolved individually, which would be a request per row against a rate-limited API; opening the thread resolves the real record by id. If Perfox cannot be reached the mirrored copy is served instead — `source` says which (`perfox` or `local`) and `sourceError` says why, so the mirror is never mistaken for Perfox data. Note `source` distinguishes the origin, not the freshness: a cached list still reports `perfox`.',
      security: bearer,
      parameters: listParams([
        { name: 'channel', in: 'query', schema: { type: 'string' } },
        {
          name: 'agentId',
          in: 'query',
          schema: { type: 'string' },
          description:
            "Narrow to the agent that handled the thread — a conversation's `workflowId` is the Perfox agent id.",
        },
      ]),
      responses: {
        200: okResponse(
          'Threads',
          {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              total: { type: 'integer' },
              source: {
                type: 'string',
                enum: ['perfox', 'local'],
                description:
                  "Where the data came from — 'perfox' or the local mirror. Not a freshness signal: a list served from the 30-second cache still reports 'perfox'.",
              },
              agents: {
                type: 'array',
                description:
                  'The agents that handled one of these threads, with a count each. Derived before `agentId` is applied, so selecting one does not remove the others from the list, and counted against the `channel` and `search` in force.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string', description: 'Empty when the agent was deleted in Perfox.' },
                    count: { type: 'integer' },
                  },
                },
              },
              sourceError: { type: 'string', description: "Why the live read failed, when source is 'local'." },
              data: { type: 'array', items: ref('Conversation') },
            },
          }
        ),
        ...COMMON_ERRORS,
      },
    },
    post: { tags: ['Conversations'], summary: 'Start a thread',
      description:
        'Writes to the local mirror only — this does not create a conversation in Perfox.', security: bearer, requestBody: jsonBody(ref('CreateConversationRequest')), responses: { 201: oneOf('Conversation'), ...COMMON_ERRORS } },
  },
  '/conversations/unread-count': {
    get: { tags: ['Conversations'], summary: 'Unread threads and messages', security: bearer, responses: { 200: okResponse('Counts', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/conversations/{id}': {
    get: { tags: ['Conversations'], summary: 'One thread with its messages', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Conversation'), 404: errorResponse('Missing', 'Conversation not found'), ...COMMON_ERRORS } },
  },
  '/conversations/{id}/messages': {
    get: { tags: ['Conversations'], summary: 'Paginate or search within a thread', security: bearer, parameters: [pathId(), ...listParams()], responses: { 200: listOf('Message'), ...COMMON_ERRORS } },
    post: { tags: ['Conversations'], summary: 'Send a message', description: 'Writes to the local mirror only — the customer does not receive it, because no Perfox send endpoint exists yet. Delivery needs a channel provider, which is not configured.', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('SendMessageRequest')), responses: { 201: oneOf('Message'), ...COMMON_ERRORS } },
  },
  '/conversations/outbound/options': {
    get: {
      tags: ['Conversations'],
      summary: 'Channels and agents for starting a conversation',
      description:
        "Fills the two dependent dropdowns on the new-conversation dialog: a channel, and the agents that can be reached on it. An agent qualifies by having a TRIGGER for that channel — not by Perfox's `channels` field, which does not report every trigger. Served entirely from the agent cache (`triggerChannels`, stored during the sync), so it costs ZERO Perfox calls; reading each agent graph on demand would be one request per agent, which is the fan-out that trips the rate limit. Every channel is returned even when no agent triggers on it, so the UI can disable rather than hide it. `web` is excluded: a web-chat conversation starts when a visitor opens the widget.",
      security: bearer,
      responses: {
        200: okResponse(
          'Options',
          envelope({
            type: 'object',
            properties: {
              channels: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', example: 'whatsapp' },
                    label: { type: 'string', example: 'WhatsApp' },
                    contact: {
                      type: 'string',
                      enum: ['phone', 'email'],
                      description: 'What the recipient field must hold for this channel.',
                    },
                    available: {
                      type: 'boolean',
                      description: 'True when at least one PUBLISHED agent triggers on it.',
                    },
                    agents: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          status: { type: 'string', example: 'published' },
                          available: { type: 'boolean', description: 'Only a published agent may start a conversation.' },
                        },
                      },
                    },
                  },
                },
              },
            },
          })
        ),
        ...COMMON_ERRORS,
      },
    },
  },
  '/conversations/outbound': {
    post: {
      tags: ['Conversations'],
      summary: 'Start a new conversation (Admin, Editor)',
      description:
        "Starts a NEW conversation through Perfox's `POST /outbound`, as opposed to `POST /{id}/send`, which replies on an existing thread. The same trigger rule the dropdown uses is enforced here, so a caller that skips the UI cannot start a conversation on a channel the agent has no trigger for. Refused with 409 unless the agent is **published** and has a trigger for that channel, and with 400 when the recipient does not match the channel (an address for `email`, a number otherwise). **A 201 does not guarantee delivery** — check `sendAuthorized`, which reports the agent's Sender node and therefore applies to the text channels only.\n\n`message` is REQUIRED for `whatsapp`, `sms` and `email` — a message with no message is nothing to send — and OPTIONAL for `phone`, which Perfox also marks optional: a call has nothing to open with. Max 2000 characters, Perfox's own limit.\n\nNOTE on `phone`: this makes the **AI AGENT** place the call. The UI does NOT use it for the Call button — a human operator dials through the `@perfox/operator-react` SDK instead (see `POST /operator/sign`). Both are real capabilities; do not wire one to the other.",
      security: bearer,
      requestBody: jsonBody(ref('StartConversationRequest')),
      responses: {
        201: okResponse(
          'Started',
          envelope({
            type: 'object',
            properties: {
              conversationId: { type: 'string' },
              executionId: { type: 'string' },
              status: { type: 'string' },
              channel: { type: 'string' },
              sendAuthorized: {
                type: 'boolean',
                description: 'False means Perfox accepted the request but nothing went out.',
              },
              to: { type: 'string' },
            },
          })
        ),
        404: errorResponse('Unknown agent', 'That agent is not in this workspace'),
        409: errorResponse(
          'Not startable',
          'Peacock Assist has no whatsapp trigger configured — it is triggered on web'
        ),
        ...COMMON_ERRORS,
      },
    },
  },
  '/conversations/{id}/send': {
    post: {
      tags: ['Conversations'],
      summary: 'Send a message through Perfox (Admin, Editor)',
      description:
        "Wraps Perfox's `POST /outbound`. Unlike `POST /{id}/messages`, which only records a message locally, this actually reaches the customer. Refused with 409 unless the agent is **published**, has a trigger for that channel (`agentTriggerChannels`), and the customer holds the matching contact detail. `phone` is excluded: Perfox opens a NEW conversation for a call, so it is not a reply on this thread. **A 200 does not guarantee delivery** — check `sendAuthorized`, which is false when Perfox accepted the request but the agent is not authorized to send on that channel.",
      security: bearer,
      parameters: [pathId()],
      requestBody: jsonBody(ref('SendOutboundRequest')),
      responses: {
        200: okResponse(
          'Accepted by Perfox',
          envelope({
            type: 'object',
            properties: {
              conversationId: { type: 'string' },
              executionId: { type: 'string' },
              status: { type: 'string' },
              channel: { type: 'string' },
              sendAuthorized: {
                type: 'boolean',
                description: 'False when the agent cannot actually send on this channel.',
              },
              to: { type: 'string', description: 'The number or address it was sent to.' },
            },
          })
        ),
        409: errorResponse('Cannot send', 'ARUVI INDUSTRIES has no sms sender configured'),
        502: errorResponse('Upstream', 'Perfox rejected the configured API token'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/conversations/{id}/read': {
    patch: { tags: ['Conversations'], summary: 'Clear the unread badge', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Conversation'), ...COMMON_ERRORS } },
  },
  '/conversations/{id}/events': {
    get: { tags: ['Conversations'], summary: 'External event feed for a thread', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Events', envelope({ type: 'array', items: { type: 'object' } })), ...COMMON_ERRORS } },
  },

  '/schedule': {
    get: {
      tags: ['Schedule'],
      summary: 'List events',
      description: 'Use `dateFrom`/`dateTo` for the week and month views; `dateKey` is a single exact day.',
      security: bearer,
      parameters: [
        { name: 'dateKey', in: 'query', schema: { type: 'string', example: '2026-09-17' } },
        { name: 'dateFrom', in: 'query', schema: { type: 'string', example: '2026-09-14' } },
        { name: 'dateTo', in: 'query', schema: { type: 'string', example: '2026-09-20' } },
        { name: 'participantType', in: 'query', schema: { type: 'string', enum: ['human', 'agent', 'customer'] } },
        { name: 'status', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: listOf('ScheduleEvent'), ...COMMON_ERRORS },
    },
    post: {
      tags: ['Schedule'],
      summary: 'Create an event',
      description: 'Rejects an end time that is not after the start time.',
      security: bearer,
      requestBody: jsonBody(ref('CreateEventRequest')),
      responses: { 201: oneOf('ScheduleEvent'), 400: errorResponse('Bad range', 'endTime must be later than startTime'), ...COMMON_ERRORS },
    },
  },
  '/schedule/stats': {
    get: { tags: ['Schedule'], summary: 'Counts per participant type', security: bearer, parameters: [{ name: 'dateFrom', in: 'query', schema: { type: 'string' } }, { name: 'dateTo', in: 'query', schema: { type: 'string' } }], responses: { 200: okResponse('Counts', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/schedule/{id}': {
    get: { tags: ['Schedule'], summary: 'One event', security: bearer, parameters: [pathId()], responses: { 200: oneOf('ScheduleEvent'), 404: errorResponse('Missing', 'Event/Appointment not found'), ...COMMON_ERRORS } },
    put: { tags: ['Schedule'], summary: 'Update an event', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('UpdateEventRequest')), responses: { 200: oneOf('ScheduleEvent'), ...COMMON_ERRORS } },
    delete: { tags: ['Schedule'], summary: 'Delete an event', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Deleted', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/schedule/{id}/status': {
    patch: { tags: ['Schedule'], summary: 'Confirm, cancel or complete', security: bearer, parameters: [pathId()], requestBody: jsonBody({ type: 'object', properties: { status: { type: 'string', enum: ['Confirmed', 'Pending', 'Cancelled', 'Completed'] } }, required: ['status'] }), responses: { 200: oneOf('ScheduleEvent'), ...COMMON_ERRORS } },
  },

  '/team/members': {
    get: { tags: ['Team'], summary: 'List members', security: bearer, parameters: listParams([{ name: 'role', in: 'query', schema: { type: 'string', enum: ['Admin', 'Editor', 'Viewer'] } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['Active', 'Pending', 'Inactive'] } }]), responses: { 200: listOf('User'), ...COMMON_ERRORS } },
    post: {
      tags: ['Team'],
      summary: 'Invite a member (Admin)',
      description: 'Creates the member as `Pending` and issues an invite token. No mail transport is configured, so nothing is delivered — the response says so.',
      security: bearer,
      requestBody: jsonBody(ref('AddMemberRequest')),
      responses: { 201: oneOf('User'), 409: errorResponse('Email taken or seats full', 'All 10 seats are in use'), ...COMMON_ERRORS },
    },
  },
  '/team/stats': {
    get: { tags: ['Team'], summary: 'Seat usage and status counts', security: bearer, responses: { 200: okResponse('Stats', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/team/members/{id}': {
    put: { tags: ['Team'], summary: 'Update a member (Admin)', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('UpdateMemberRequest')), responses: { 200: oneOf('User'), ...COMMON_ERRORS } },
    delete: {
      tags: ['Team'],
      summary: 'Revoke access (Admin)',
      description: 'Deactivates by default so audit history survives. Pass `?hard=true` to delete the row.',
      security: bearer,
      parameters: [pathId(), { name: 'hard', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
      responses: { 200: okResponse('Revoked', envelope({ type: 'object' })), ...COMMON_ERRORS },
    },
  },
  '/team/members/{id}/invite': {
    post: { tags: ['Team'], summary: 'Re-issue an invitation (Admin)', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Re-issued', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },

  '/knowledge/folders': {
    get: {
      tags: ['Knowledge Base'],
      summary: 'List knowledge-base folders',
      parameters: [
        {
          name: 'parentId',
          in: 'query',
          schema: { type: 'string' },
          description: "List just this folder's children. Omit for the whole walked tree, which is what a destination picker wants.",
        },
      ],
      description:
        "Every folder in the workspace, depth-first, parents before their children, newest first within each level. IMPORTANT: Perfox's own `GET /kb/folders` returns ONLY the root level, so the tree is walked here one level at a time via `parent_id` — a nested folder is otherwise invisible. Each row carries `depth` and a readable `displayPath` so a picker can indent without rebuilding the ancestry. Pass `parentId` for a single level, which is served by filtering the same walked tree rather than calling Perfox again. The tree is cached for 30s and cleared on any folder or file change, and concurrent callers share one walk — without that, a single page load walked the tree three times over and tripped Perfox's rate limit. Returns 409 until the platform connection is configured.",
      security: bearer,
      responses: {
        200: okResponse(
          'Folders',
          envelope({ type: 'object', properties: { folders: { type: 'array', items: ref('KbFolder') } } })
        ),
        ...COMMON_ERRORS,
      },
    },
    post: {
      tags: ['Knowledge Base'],
      summary: 'Create a folder (Admin, Editor)',
      description:
        'Creates the folder in Perfox. Omit `parentId` (or send an empty string) to create at the root.',
      security: bearer,
      requestBody: jsonBody(ref('CreateFolderRequest')),
      responses: {
        201: okResponse('Created', envelope({ type: 'object', properties: { folder: ref('KbFolder') } })),
        502: errorResponse('Upstream', 'Perfox did not return the created folder'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/knowledge/folders/{id}': {
    patch: {
      tags: ['Knowledge Base'],
      summary: 'Rename a knowledge-base folder',
      description:
        'Changes the display name only. The folder id is untouched, so every file in it and every agent pointing at it keeps working.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string', maxLength: 200 } },
            },
          },
        },
      },
      security: bearer,
      responses: {
        200: okResponse('Renamed', envelope({ type: 'object', properties: { folder: ref('KbFolder') } })),
        404: errorResponse('Missing folder', 'That folder no longer exists in Perfox'),
        ...COMMON_ERRORS,
      },
    },
    delete: {
      tags: ['Knowledge Base'],
      summary: 'Delete an empty knowledge-base folder',
      description:
        'Perfox refuses to delete a folder that still holds files or subfolders, and NEVER cascades — deleting a folder cannot remove documents. That refusal comes back as 409 with a message naming what is still inside. On success, `affectedAgents` lists the agents that were drawing on the folder. Note: the published Perfox spec documents only 200/401/403/404 for this route; the 409 is real and handled from observed behaviour.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      security: bearer,
      responses: {
        200: okResponse(
          'Deleted',
          envelope({
            type: 'object',
            properties: {
              id: { type: 'string' },
              deleted: { type: 'boolean' },
              affectedAgents: {
                type: 'array',
                items: { type: 'string' },
                description: 'Agents that were using this folder as a source.',
              },
            },
          })
        ),
        404: errorResponse('Missing folder', 'That folder no longer exists in Perfox'),
        409: errorResponse(
          'Folder not empty',
          'This folder still contains 3 files. Delete its contents first — deleting a folder never removes what is inside it.'
        ),
        ...COMMON_ERRORS,
      },
    },
  },
  '/knowledge/files/upload': {
    post: {
      tags: ['Knowledge'],
      summary: 'Upload a file (Admin, Editor)',
      description:
        'Takes the file as a **raw byte stream** with `Content-Type: application/octet-stream`, and rebuilds the multipart request Perfox wants server-side. Done this way so the destination folder is the server\u2019s decision: a browser posting multipart directly would carry its own `folder_id` and could write anywhere in the workspace. It also avoids adding a multipart parser to the service. Limited to 25MB, enforced by the body parser and again in the handler.',
      security: bearer,
      parameters: [
        { name: 'name', in: 'query', required: true, schema: { type: 'string' }, description: 'The file name, including its extension.' },
        { name: 'mime', in: 'query', schema: { type: 'string' }, description: 'The real media type; defaults to application/octet-stream.' },
        { name: 'folderId', in: 'query', schema: { type: 'string' }, description: 'Destination folder. Omit for the root.' },
      ],
      requestBody: {
        required: true,
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      responses: {
        201: okResponse('Uploaded', envelope({ type: 'object', properties: { file: ref('KbFile') } })),
        400: errorResponse('Empty', 'The request carried no file content'),
        404: errorResponse('Missing folder', 'That folder does not exist in the Perfox knowledge base'),
        413: errorResponse('Too large', 'Files must be 25MB or smaller'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/knowledge/files/{id}': {
    delete: {
      tags: ['Knowledge'],
      summary: 'Delete a knowledge-base file (Admin, Editor)',
      description:
        'Removes the file from Perfox, then drops this service\u2019s record of it. Perfox goes first: clearing the local pointer first would hide a file that still exists and still answers queries. Idempotent \u2014 a file already gone upstream returns 200, because the caller\u2019s intent is satisfied either way.',
      security: bearer,
      parameters: [pathId()],
      responses: {
        200: okResponse(
          'Deleted',
          envelope({ type: 'object', properties: { id: { type: 'string' }, deleted: { type: 'boolean' } } })
        ),
        ...COMMON_ERRORS,
      },
    },
  },
  '/knowledge/catalog': {
    post: {
      tags: ['Knowledge'],
      summary: 'Compile the product catalog into one document (Admin, Editor)',
      description:
        'Builds a single `product-catalog.md` from the products and categories held by this service and uploads it. Compiled server-side deliberately: the catalog is already here, a client could only page through part of it, and which fields are omitted is policy rather than formatting. **Price, stock and margin are never included** \u2014 an indexed document is a snapshot, so anything that moves on its own becomes a confident wrong answer; `margin` and `originalPrice` are internal money that should never reach a customer. Set `replaceExisting` to remove the previous copy in that folder first, otherwise re-running stacks duplicates that the agent may answer from at random.',
      security: bearer,
      requestBody: jsonBody(ref('GenerateCatalogRequest')),
      responses: {
        201: okResponse(
          'Compiled',
          envelope({
            type: 'object',
            properties: {
              file: ref('KbFile'),
              productCount: { type: 'integer' },
              categoryCount: { type: 'integer' },
              replaced: { type: 'integer', description: 'Previous copies removed.' },
              sizeBytes: { type: 'integer' },
            },
          })
        ),
        400: errorResponse('Nothing selected', 'Select products or categories to generate from'),
        404: errorResponse('Missing folder', 'That folder does not exist in the Perfox knowledge base'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/knowledge/files': {
    get: {
      tags: ['Knowledge'],
      summary: 'List the knowledge-base files',
      description:
        "One level of the knowledge base, newest first. Omit `folderId` for the ROOT level, or pass a folder id for that folder's contents — Perfox scopes `GET /kb/files` the same way, so a bare listing returns only root-level files, not the whole tree. `status`, `limit` and `cursor` pass straight through to Perfox. Files this service uploaded moments ago are merged in, because Perfox can omit a file from the listing while it is still being ingested; a recorded file Perfox can no longer return is dropped and forgotten.",
      parameters: [
        {
          name: 'folderId',
          in: 'query',
          schema: { type: 'string' },
          description: 'The folder to list. Omit for the root level — NOT for the whole tree.',
        },
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string' },
          description: 'Perfox ingestion state, e.g. `active`. Passed through unchanged.',
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer' },
          description: 'Page size, passed through to Perfox.',
        },
        {
          name: 'cursor',
          in: 'query',
          schema: { type: 'string' },
          description: 'Opaque page cursor from a previous response nextCursor.',
        },
      ],
      security: bearer,
      responses: {
        200: okResponse(
          'Files',
          envelope({
            type: 'object',
            properties: {
              total: { type: 'integer' },
              folderId: { type: 'string', description: 'Empty at the root level.' },
              folderName: { type: 'string', description: 'The level being listed, e.g. Root level.' },
              nextCursor: { type: 'string', description: 'Pass back as `cursor` for the next page; empty when there are no more.' },
              files: { type: 'array', items: ref('KbFile') },
            },
          })
        ),
        404: errorResponse('Missing folder', 'That folder does not exist in the Perfox knowledge base'),
        ...COMMON_ERRORS,
      },
    },
    post: {
      tags: ['Knowledge'],
      summary: 'Create a markdown file (Admin, Editor)',
      description:
        'Takes a file name and markdown content and uploads them as a real `.md` file. `folderId` chooses the destination; omit it for the root of the knowledge base. The browser sends text — the multipart upload Perfox wants is assembled server-side, so the API token never reaches it. `.md` is appended when the name lacks it, and characters that are not safe in a file name are stripped. The file is not searchable the moment this returns: Perfox indexes it asynchronously, and the list reports that as the row’s `status`.',
      security: bearer,
      requestBody: jsonBody(ref('UploadMarkdownRequest')),
      responses: {
        201: okResponse('Uploaded', envelope({ type: 'object', properties: { file: ref('KbFile') } })),
        409: errorResponse('No folder', 'No knowledge-base folder is selected — choose one in the Developer hub first'),
        502: errorResponse('Upstream', 'Perfox did not return the uploaded file'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/knowledge/stats': {
    get: {
      tags: ['Knowledge'],
      summary: 'File counts for the selected folder',
      description:
        'Counted from the same rows the list returns, so the tiles and the table cannot disagree. `notIndexed` is the number worth acting on: those files are stored but answer nothing. COST: counting the whole knowledge base means one Perfox file listing per folder, so the result is cached for 30s and cleared whenever a file or folder changes. Treat it as a summary, not a live readout.',
      parameters: [
        {
          name: 'folderId',
          in: 'query',
          schema: { type: 'string' },
          description: 'Narrow the figures to one folder — far cheaper, since the whole-base figure fans out across every folder. Omit for the whole knowledge base.',
        },
      ],
      security: bearer,
      responses: {
        200: okResponse(
          'Stats',
          envelope({
            type: 'object',
            properties: {
              totalFiles: { type: 'integer' },
              indexedFiles: { type: 'integer' },
              notIndexed: { type: 'integer' },
              totalChunks: { type: 'integer' },
              totalSizeBytes: { type: 'integer' },
            },
          })
        ),
        409: errorResponse('No folder', 'No knowledge-base folder is selected — choose one in the Developer hub first'),
        ...COMMON_ERRORS,
      },
    },
  },

  '/developer/platform': {
    get: {
      tags: ['Developer'],
      summary: 'Read the Perfox platform connection (Admin)',
      description:
        'Reports whether a workspace is connected and how. The API token is never returned — only a masked hint in `apiTokenMasked`. `source` is `stored` when the connection was saved from the Developer Hub, `env` when it comes from PERFOX_API_URL/PERFOX_API_TOKEN, and `none` when nothing is configured. `kbFolder` carries the selected knowledge-base folder as a nested object.',
      security: bearer,
      responses: {
        200: okResponse('Connection state', envelope(ref('PlatformConnection'))),
        ...COMMON_ERRORS,
      },
    },
    put: {
      tags: ['Developer'],
      summary: 'Save and verify the Perfox connection (Admin)',
      description:
        'Stores the credentials and immediately calls `GET {apiUrl}/kb/folders` to verify them. A failed verification still saves, with `status: "Error"` and the reason, so nothing the developer typed is lost. Omit `apiToken` to keep the one already saved. The URL is checked against the same SSRF allowlist as webhook endpoints.',
      security: bearer,
      requestBody: jsonBody(ref('SavePlatformConnectionRequest')),
      responses: {
        200: okResponse(
          'Saved',
          envelope({
            allOf: [
              ref('PlatformConnection'),
              {
                type: 'object',
                properties: { verification: ref('PlatformVerification') },
              },
            ],
          })
        ),
        400: errorResponse('Rejected', 'url must not point at a private or loopback address'),
        ...COMMON_ERRORS,
      },
    },
    delete: {
      tags: ['Developer'],
      summary: 'Disconnect the Perfox platform (Admin)',
      description:
        'Deletes the stored token. Agents and webhook endpoints are hidden again but are not themselves deleted. If the deployment also supplies the credentials through the environment, `fellBackToEnvironment` is true and the hub stays connected.',
      security: bearer,
      responses: {
        200: okResponse(
          'Disconnected',
          envelope({
            type: 'object',
            properties: {
              disconnected: { type: 'boolean' },
              fellBackToEnvironment: {
                type: 'boolean',
                description: 'True when environment credentials took over, leaving the hub connected.',
              },
              connection: ref('PlatformConnection'),
            },
          })
        ),
        404: errorResponse('Missing', 'No Perfox connection is configured'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/developer/platform/test': {
    post: {
      tags: ['Developer'],
      summary: 'Re-verify the stored connection (Admin)',
      description:
        'Calls Perfox with the configured credentials and reports the HTTP status, latency and any failure message. Never fails the request because Perfox rejected it — that is the result.',
      security: bearer,
      responses: {
        200: okResponse('Verification result', envelope(ref('PlatformVerification'))),
        409: errorResponse('Not configured', 'No Perfox connection is configured yet'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/developer/agents': {
    get: {
      tags: ['Developer'],
      summary: 'List agents (Admin)',
      description:
        'Agents cached from the connected Perfox workspace. Served from the local cache; Perfox is called only when the cache is empty or `refresh=true` is passed. Returns 409 until the platform connection is configured.',
      security: bearer,
      parameters: [
        {
          name: 'refresh',
          in: 'query',
          schema: { type: 'boolean' },
          description: 'Force a re-sync from Perfox instead of serving the cache.',
        },
      ],
      responses: { 200: okResponse('Agents', envelope({ type: 'object' })), ...COMMON_ERRORS },
    },
  },
  '/developer/agents/{id}': {
    get: {
      tags: ['Developer'],
      summary: 'One cached agent (Admin)',
      security: bearer,
      parameters: [pathId()],
      responses: {
        200: oneOf('Agent'),
        404: errorResponse('Missing', 'Agent not found'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/developer/agents/{id}/status': {
    patch: {
      tags: ['Developer'],
      summary: 'Publish or pause an agent (Admin)',
      description:
        "Forwarded to Perfox: `published` calls POST /agents/{id}/publish, `paused` calls PATCH /agents/{id}. The pause path first reads the agent and echoes its current name, description, channels, nodes and edges back with the new status, so the flow cannot be cleared. A draft agent is refused with 409. The status is read back from Perfox and the cached row re-synced.",
      security: bearer,
      parameters: [pathId()],
      requestBody: jsonBody(ref('SetAgentStatusRequest')),
      responses: {
        200: oneOf('Agent'),
        409: errorResponse('Draft', 'A draft agent cannot be toggled — publish it in Perfox first'),
        502: errorResponse('Upstream', 'Perfox rejected the configured API token'),
        ...COMMON_ERRORS,
      },
    },
  },
  '/developer/endpoints': {
    get: { tags: ['Developer'], summary: 'List endpoints (Admin)', description: 'Returns 409 until the Perfox platform connection is configured.', security: bearer, responses: { 200: listOf('Endpoint'), ...COMMON_ERRORS } },
    post: { tags: ['Developer'], summary: 'Register an endpoint (Admin)', description: 'The URL is checked against an SSRF allowlist: http/https only, and private, loopback or link-local targets are refused.', security: bearer, requestBody: jsonBody(ref('CreateEndpointRequest')), responses: { 201: oneOf('Endpoint'), 400: errorResponse('Unsafe URL', 'url must not point at a private or loopback address'), ...COMMON_ERRORS } },
  },
  '/developer/endpoints/{id}': {
    get: { tags: ['Developer'], summary: 'One endpoint (Admin)', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Endpoint'), 404: errorResponse('Missing', 'Endpoint not found'), ...COMMON_ERRORS } },
    put: { tags: ['Developer'], summary: 'Update an endpoint (Admin)', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('UpdateEndpointRequest')), responses: { 200: oneOf('Endpoint'), ...COMMON_ERRORS } },
    delete: { tags: ['Developer'], summary: 'Delete an endpoint (Admin)', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Deleted', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/developer/platform/operator': {
    put: {
      tags: ['Developer'],
      summary: 'Save the Perfox operator site (Admin)',
      description:
        "The Perfox **Site** a human operator signs in against — distinct from the workspace connection, which is how this service calls Perfox. Stored nested inside the single platform-connection row, so it lives with the tenant it belongs to. `siteSecret` is write-only: stored `select: false`, stripped from every response, and only ever echoed masked. Sending an empty `siteSecret` keeps the stored one, so the host can be corrected without retyping it. `apiHost` is validated: it must be the `-api` host and must not carry a `/api/v1` path — both mistakes surface in the browser as an unexplained CORS error. Returns 409 until the workspace connection exists.",
      security: bearer,
      requestBody: jsonBody(ref('SaveOperatorSiteRequest')),
      responses: {
        200: okResponse('Saved', envelope({ type: 'object' })),
        409: errorResponse(
          'No workspace connection',
          'Configure the Perfox workspace connection before the operator site'
        ),
        ...COMMON_ERRORS,
      },
    },
  },
  '/operator/sign': {
    post: {
      tags: ['Developer'],
      summary: 'Sign the current user as a Perfox operator',
      description:
        "Mints the identity the `@perfox/operator-react` SDK needs to go online, and the only thing standing between a browser and Perfox's operator routes. `userHash = HMAC_SHA256(siteSecret, siteId + '.' + externalId)`; the secret never leaves the server, only the signature. `externalId` is derived from the authenticated session (`op_<userId>`), NEVER from the request body — otherwise any signed-in user could ask us to vouch for somebody else's operator identity. Deliberately mounted outside the Admin-only `/developer` hub: configuring the site is an administrative act, taking a call is not. Returns 409 when no operator site is configured.",
      security: bearer,
      responses: {
        200: okResponse(
          'Signed',
          envelope({
            type: 'object',
            properties: {
              apiHost: { type: 'string', example: 'https://acme-api.perfox.ai' },
              siteId: { type: 'string' },
              workflowId: { type: 'string', nullable: true },
              externalId: { type: 'string', example: 'op_6650f1c2a9' },
              name: { type: 'string' },
              userHash: { type: 'string', description: 'Hex HMAC proving this server vouched for the operator.' },
            },
          })
        ),
        409: errorResponse(
          'No operator site',
          'The Perfox operator site is not configured — add it in the Developer hub'
        ),
        ...COMMON_ERRORS,
      },
    },
  },
  '/developer/endpoints/{id}/ping': {
    post: {
      tags: ['Developer'],
      summary: 'Ping an endpoint (Admin)',
      description:
        'Performs the real request using the endpoint’s method, auth, headers, query and body, with an 8s timeout, and reports the true status code and measured latency.',
      security: bearer,
      parameters: [pathId()],
      responses: { 200: okResponse('Ping result', envelope({ type: 'object' })), ...COMMON_ERRORS },
    },
  },
};

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Perfox / OmniFlow Enterprise Platform API',
    version: '1.0.0',
    description: [
      'Backend for the OmniFlow enterprise platform UI.',
      '',
      '**Authentication** — every route except `POST /auth/login`, `POST /auth/register` and',
      '`GET /api/health` needs `Authorization: Bearer <token>`. Sign in via `/auth/login`, then',
      'press **Authorize** above and paste the token.',
      '',
      '**Roles** — `Viewer` reads; `Editor` may write products, categories, schedule, knowledge',
      'and conversations; `Admin` adds Teams and the whole Developer hub.',
      '',
      '**Perfox rate limit** — the upstream platform answers `429` with `retry-after: 60`',
      'and publishes no quota headers, so there is no budget to read. Routes that would',
      'otherwise fan out are cached server-side and share their in-flight work: the knowledge',
      'folder tree and its stat tiles for 30s, agents until refreshed, customers for 60s.',
      'Each affected operation says so in its own description.',
      '',
      '**Envelope** — single `{ success, data }`, list',
      '`{ success, total, page, limit, totalPages, data }`, error `{ success: false, message }`',
      'plus `errors[]` on a validation failure.',
      '',
      'Request bodies below are generated from the same Zod schemas the server validates with,',
      'so they cannot drift from the real contract.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1', description: 'This server' }],
  tags: [
    { name: 'Auth', description: 'Sign in and identity' },
    { name: 'Dashboard', description: 'Aggregated counters' },
    { name: 'Products', description: 'Catalog. Products reference a category by id.' },
    { name: 'Categories', description: 'Classification. `productsCount` is derived on read.' },
    { name: 'Conversations', description: 'Multi-channel inbox' },
    { name: 'Schedule', description: 'Appointments, with date-range querying' },
    { name: 'Team', description: 'Members, roles and seats (Admin)' },
    {
      name: 'Knowledge',
      description:
        'The files in the selected Perfox knowledge-base folder. Backed by the Perfox workspace, not by local rows, so every route needs the platform connection configured in the Developer hub.',
    },
    {
      name: 'Developer',
      description:
        'The Perfox platform connection, the knowledge-base folder it works against, cached agents and webhook endpoints (Admin). Agents and endpoints stay hidden until the connection is configured.',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas,
  },
  security: bearer,
  paths,
};
