import { aiCatalogService, LANGUAGES, MAX_AVAILABILITY_IDS, MAX_DETAIL_IDS } from '../services/aiCatalog.service.js';
import { createLogger } from '../utils/logger.js';
import type { McpTool } from './tools.js';

/**
 * MCP CATALOGUE TOOLS — the new product module (design §9.5).
 *
 * Read-only. They call the same services as the screens (search, availability,
 * prices, limits) through aiCatalogService, which also serves the public
 * storefront's /public/v2 routes, so the agent and the website never disagree.
 *
 * Descriptions are written FOR THE AGENT: when to call, what to pass, what to
 * do with the result.
 */

const log = createLogger('MCP');

const language = {
  type: 'string',
  enum: [...LANGUAGES],
  description: "Language for names and labels: 'en' (default), 'ta' (Tamil) or 'hi' (Hindi). Use the customer's language.",
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => String(x));

export const catalogV2Tools: Record<string, McpTool> = {
  search_products: {
    description:
      'Find products for the customer. Use it for "what do you have", "show me red SUVs under 15 lakh", ' +
      '"cheapest 1 litre oil". Each result is a short card: name, category, price text, availability text ' +
      'and up to 3 matching variants (items) with their own price and availability. With filters, the price ' +
      'shown is the matching variant\'s price. Quote `price_text` and `availability.text` exactly as given — do ' +
      'no arithmetic. Call get_filters first to learn the filter keys and values. Call get_product_details ' +
      'when the customer picks a product. Only describe products this tool returned; never invent one.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'What the customer wants in their own words, e.g. "creta" or "sunflower oil". Omit to browse.' },
        category_id: { type: 'string', description: 'Limit to one category (and its sub-categories). Take the id from list_categories.' },
        filters: {
          type: 'object',
          description:
            'Attribute filters from get_filters: { "<key>": ["<value>", …] }, e.g. { "fuel": ["petrol"], "colour": ["red"] }. ' +
            'Use option `value`s, not labels. Sizes accept text like "1 l" or "500 g".',
          additionalProperties: { type: 'array', items: { type: ['string', 'number', 'boolean'] } },
        },
        price_min: { type: 'number', description: 'Lowest price in rupees (e.g. 500000 for 5 lakh).' },
        price_max: { type: 'number', description: 'Highest price in rupees. Use for "under …" questions.' },
        in_stock_only: { type: 'boolean', description: 'true to leave out variants that are out of stock.' },
        sort: {
          type: 'string',
          enum: ['relevance', 'price_asc', 'price_desc', 'newest', 'name', 'size_asc', 'size_desc'],
          description: "price_asc = cheapest first. relevance only with a search term. Defaults to relevance with a search, newest without.",
        },
        page: { type: 'number', description: 'Page, starting at 1.' },
        limit: { type: 'number', description: 'Products per page: 3–5 for WhatsApp and voice, up to 10 for web chat. Default 10, max 50.' },
        language,
      },
    },
    handler: async (params) => {
      const result = await aiCatalogService.search({
        search: params.search ? String(params.search) : undefined,
        category_id: params.category_id ? String(params.category_id) : undefined,
        filters:
          params.filters && typeof params.filters === 'object'
            ? Object.fromEntries(Object.entries(params.filters).map(([k, v]) => [k, Array.isArray(v) ? v : [v as any]]))
            : undefined,
        price_min: params.price_min,
        price_max: params.price_max,
        in_stock_only: params.in_stock_only === true,
        sort: params.sort,
        page: Number(params.page) || 1,
        limit: Number(params.limit) || 10,
        language: params.language,
      });
      log.debug(`mcp search_products -> ${result.total} match(es)`, { search: params.search });
      if (!result.products.length) {
        return {
          ...result,
          message:
            'Nothing matched. Suggest a broader search, fewer filters or another category (list_categories). Do not invent products.',
        };
      }
      return result;
    },
  },

  get_product_details: {
    description:
      'Full details of one or more products, in one call: description, attributes, every variant with its ' +
      'price, MRP and saving, tax (only when set), price per unit, pack saving, order limits, bundle contents ' +
      'and availability. Use it after search_products when the customer picks something. Pass several ids at ' +
      'once instead of calling repeatedly. Ids in `missing` are not on sale — say so; never describe them. ' +
      'Read texts out as given (price_text, availability.text, limits_text …).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: `Product ids from search_products. Maximum ${MAX_DETAIL_IDS}.` },
        language,
      },
      required: ['ids'],
    },
    handler: async (params) => aiCatalogService.details(list(params.ids), params.language),
  },

  get_filters: {
    description:
      'What you can filter products by (e.g. Fuel, Body type, Colour, Size) with the options that have ' +
      'products, plus the sort options. Call it before search_products whenever the customer names a feature, ' +
      'and use the option `value` in search_products filters. Pass category_id to see only that category\'s options.',
    inputSchema: {
      type: 'object',
      properties: {
        category_id: { type: 'string', description: 'Optional: only options found in this category (from list_categories).' },
        language,
      },
    },
    handler: async (params) => aiCatalogService.filters(params.category_id ? String(params.category_id) : undefined, params.language),
  },

  list_categories: {
    description:
      'The categories on sale, each with its full path (e.g. "Vehicles › SUV") and how many products are on ' +
      'sale in it. Call it when the customer asks what kinds of things are sold, or to get a category_id for ' +
      'search_products. Cheap — call it whenever unsure.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter by name.' },
        language,
      },
    },
    handler: async (params) => aiCatalogService.categories(params.search ? String(params.search) : undefined, params.language),
  },

  check_availability: {
    description:
      'Live availability for specific variants (items), e.g. "is the red XL in stock right now?". Pass the ' +
      'item_id values from search_products or get_product_details. Returns "In stock", "Only N left", ' +
      '"Out of stock" or "Available" (not stock-tracked — always available). Never promise a delivery date from this.',
    inputSchema: {
      type: 'object',
      properties: {
        item_ids: { type: 'array', items: { type: 'string' }, description: `Item ids. Maximum ${MAX_AVAILABILITY_IDS}.` },
      },
      required: ['item_ids'],
    },
    handler: async (params) => aiCatalogService.availability(list(params.item_ids)),
  },
};
