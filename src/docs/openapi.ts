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
  assignEndpointsSchema,
  createAgentSchema,
  createEndpointSchema,
  updateAgentSchema,
  updateAgentStatusSchema,
  updateEndpointSchema,
} from '../controllers/developer.controller.js';
import {
  bulkDeleteArticlesSchema,
  createArticleSchema,
  createCollectionSchema,
  updateArticleSchema,
} from '../controllers/knowledge.controller.js';
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
      price: { type: 'number', example: 1299 },
      originalPrice: { type: 'number' },
      stock: { type: 'integer', example: 142 },
      stockStatus: { type: 'string', enum: ['In Stock', 'Low Stock', 'Out of Stock'] },
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
    properties: {
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

  Article: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'art-1' },
      title: { type: 'string' },
      category: { type: 'string' },
      readTime: { type: 'string', description: 'Derived from the content length.' },
      visibility: { type: 'string' },
      views: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      updated: { type: 'string' },
      content: { type: 'string' },
    },
  },

  Collection: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'col-1' },
      title: { type: 'string' },
      description: { type: 'string' },
      articleCount: { type: 'integer' },
      icon: { type: 'string' },
      color: { type: 'string' },
    },
  },

  Agent: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'agt-001' },
      name: { type: 'string' },
      workflowId: { type: 'string' },
      channel: { type: 'string' },
      model: { type: 'string' },
      siteKey: { type: 'string', description: 'Public by design — embedded in the browser widget.' },
      secretKeyMasked: {
        type: 'string',
        example: 'sk_****9a3f',
        description: 'The plaintext secret is returned only at create and rotate.',
      },
      accentColor: { type: 'string' },
      position: { type: 'string', enum: ['bottom-right', 'bottom-left', 'embed-inline'] },
      status: { type: 'string' },
      totalCalls: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      avgLatency: { type: 'string' },
      assignedEndpoints: { type: 'array', items: { type: 'string' } },
      description: { type: 'string' },
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
  CreateArticleRequest: bodyOf(createArticleSchema),
  UpdateArticleRequest: bodyOf(updateArticleSchema),
  CreateCollectionRequest: bodyOf(createCollectionSchema),
  BulkDeleteArticlesRequest: bodyOf(bulkDeleteArticlesSchema),
  CreateAgentRequest: bodyOf(createAgentSchema),
  UpdateAgentRequest: bodyOf(updateAgentSchema),
  UpdateAgentStatusRequest: bodyOf(updateAgentStatusSchema),
  AssignEndpointsRequest: bodyOf(assignEndpointsSchema),
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
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['In Stock', 'Low Stock', 'Out of Stock'] } },
      ]),
      responses: { 200: listOf('Product'), ...COMMON_ERRORS },
    },
    post: {
      tags: ['Products'],
      summary: 'Create a product',
      description:
        'Requires `categoryId`; the server resolves it and derives `category`. `price` is required only when there are no variants — otherwise every variant needs its own price and the base price is the cheapest of them.',
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
      responses: { 200: okResponse('Stats', envelope({ type: 'object' })), ...COMMON_ERRORS },
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
    get: { tags: ['Conversations'], summary: 'List threads', security: bearer, parameters: listParams([{ name: 'channel', in: 'query', schema: { type: 'string' } }]), responses: { 200: listOf('Conversation'), ...COMMON_ERRORS } },
    post: { tags: ['Conversations'], summary: 'Start a thread', security: bearer, requestBody: jsonBody(ref('CreateConversationRequest')), responses: { 201: oneOf('Conversation'), ...COMMON_ERRORS } },
  },
  '/conversations/unread-count': {
    get: { tags: ['Conversations'], summary: 'Unread threads and messages', security: bearer, responses: { 200: okResponse('Counts', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/conversations/{id}': {
    get: { tags: ['Conversations'], summary: 'One thread with its messages', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Conversation'), 404: errorResponse('Missing', 'Conversation not found'), ...COMMON_ERRORS } },
  },
  '/conversations/{id}/messages': {
    get: { tags: ['Conversations'], summary: 'Paginate or search within a thread', security: bearer, parameters: [pathId(), ...listParams()], responses: { 200: listOf('Message'), ...COMMON_ERRORS } },
    post: { tags: ['Conversations'], summary: 'Send a message', description: 'Stores the message. Delivery needs a channel provider, which is not configured.', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('SendMessageRequest')), responses: { 201: oneOf('Message'), ...COMMON_ERRORS } },
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

  '/knowledge/articles': {
    get: { tags: ['Knowledge'], summary: 'List articles', security: bearer, parameters: listParams([{ name: 'category', in: 'query', schema: { type: 'string' } }]), responses: { 200: listOf('Article'), ...COMMON_ERRORS } },
    post: { tags: ['Knowledge'], summary: 'Create an article', description: '`readTime` is derived from the content length.', security: bearer, requestBody: jsonBody(ref('CreateArticleRequest')), responses: { 201: oneOf('Article'), ...COMMON_ERRORS } },
  },
  '/knowledge/articles/bulk-delete': {
    post: { tags: ['Knowledge'], summary: 'Delete several articles', security: bearer, requestBody: jsonBody(ref('BulkDeleteArticlesRequest')), responses: { 200: okResponse('Result', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/knowledge/articles/{id}': {
    get: { tags: ['Knowledge'], summary: 'One article', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Article'), 404: errorResponse('Missing', 'Article not found'), ...COMMON_ERRORS } },
    put: { tags: ['Knowledge'], summary: 'Update an article', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('UpdateArticleRequest')), responses: { 200: oneOf('Article'), ...COMMON_ERRORS } },
    delete: { tags: ['Knowledge'], summary: 'Delete an article', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Deleted', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/knowledge/articles/{id}/view': {
    post: { tags: ['Knowledge'], summary: 'Increment the view counter', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Counted', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/knowledge/collections': {
    get: { tags: ['Knowledge'], summary: 'List collections', security: bearer, responses: { 200: listOf('Collection'), ...COMMON_ERRORS } },
    post: { tags: ['Knowledge'], summary: 'Create a collection', security: bearer, requestBody: jsonBody(ref('CreateCollectionRequest')), responses: { 201: oneOf('Collection'), ...COMMON_ERRORS } },
  },
  '/knowledge/stats': {
    get: { tags: ['Knowledge'], summary: 'Article count, total views and active categories', security: bearer, responses: { 200: okResponse('Stats', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/knowledge/sync': {
    post: { tags: ['Knowledge'], summary: 'Generate markdown articles from the catalog', description: 'Runs inline; for a large catalog this belongs in a background job.', security: bearer, responses: { 200: okResponse('Generated', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },

  '/developer/agents': {
    get: { tags: ['Developer'], summary: 'List agents (Admin)', description: 'Secrets are masked; only `secretKeyMasked` is returned.', security: bearer, responses: { 200: listOf('Agent'), ...COMMON_ERRORS } },
    post: { tags: ['Developer'], summary: 'Create an agent (Admin)', description: 'Keys are generated server-side with a CSPRNG. The plaintext secret is returned exactly once, here.', security: bearer, requestBody: jsonBody(ref('CreateAgentRequest')), responses: { 201: oneOf('Agent'), ...COMMON_ERRORS } },
  },
  '/developer/agents/{id}': {
    get: { tags: ['Developer'], summary: 'One agent (Admin)', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Agent'), 404: errorResponse('Missing', 'Agent not found'), ...COMMON_ERRORS } },
    put: { tags: ['Developer'], summary: 'Update an agent (Admin)', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('UpdateAgentRequest')), responses: { 200: oneOf('Agent'), ...COMMON_ERRORS } },
    delete: { tags: ['Developer'], summary: 'Delete an agent (Admin)', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Deleted', envelope({ type: 'object' })), ...COMMON_ERRORS } },
  },
  '/developer/agents/{id}/status': {
    patch: { tags: ['Developer'], summary: 'Activate or pause an agent (Admin)', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('UpdateAgentStatusRequest')), responses: { 200: oneOf('Agent'), ...COMMON_ERRORS } },
  },
  '/developer/agents/{id}/endpoints': {
    patch: { tags: ['Developer'], summary: 'Replace the endpoint assignment (Admin)', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('AssignEndpointsRequest')), responses: { 200: oneOf('Agent'), 400: errorResponse('Unknown endpoint', 'One or more endpoint ids do not exist'), ...COMMON_ERRORS } },
  },
  '/developer/agents/{id}/rotate-key': {
    post: { tags: ['Developer'], summary: 'Rotate the secret key (Admin)', description: 'Returns the new plaintext secret exactly once.', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Agent'), ...COMMON_ERRORS } },
  },
  '/developer/endpoints': {
    get: { tags: ['Developer'], summary: 'List endpoints (Admin)', security: bearer, responses: { 200: listOf('Endpoint'), ...COMMON_ERRORS } },
    post: { tags: ['Developer'], summary: 'Register an endpoint (Admin)', description: 'The URL is checked against an SSRF allowlist: http/https only, and private, loopback or link-local targets are refused.', security: bearer, requestBody: jsonBody(ref('CreateEndpointRequest')), responses: { 201: oneOf('Endpoint'), 400: errorResponse('Unsafe URL', 'url must not point at a private or loopback address'), ...COMMON_ERRORS } },
  },
  '/developer/endpoints/{id}': {
    get: { tags: ['Developer'], summary: 'One endpoint (Admin)', security: bearer, parameters: [pathId()], responses: { 200: oneOf('Endpoint'), 404: errorResponse('Missing', 'Endpoint not found'), ...COMMON_ERRORS } },
    put: { tags: ['Developer'], summary: 'Update an endpoint (Admin)', security: bearer, parameters: [pathId()], requestBody: jsonBody(ref('UpdateEndpointRequest')), responses: { 200: oneOf('Endpoint'), ...COMMON_ERRORS } },
    delete: { tags: ['Developer'], summary: 'Delete an endpoint (Admin)', security: bearer, parameters: [pathId()], responses: { 200: okResponse('Deleted', envelope({ type: 'object' })), ...COMMON_ERRORS } },
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
    { name: 'Knowledge', description: 'Articles and collections' },
    { name: 'Developer', description: 'AI agents and webhook endpoints (Admin)' },
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
