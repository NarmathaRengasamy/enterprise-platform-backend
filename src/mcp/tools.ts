import { store } from '../data/store.js';
import {
  publicProduct,
  publicCategory,
  toBound,
  queryCatalog,
} from '../services/publicCatalog.js';
import { createLogger } from '../utils/logger.js';
import type { Product, Category } from '../types/index.js';

/**
 * MCP CATALOGUE TOOLS.
 *
 * Read-only access to products and categories, for an AI agent answering
 * customer questions.
 *
 * These call the store directly rather than looping back through our own HTTP
 * API: the data is a function call away, and a self-request would need a
 * service token, a round trip and a second thing to keep running.
 *
 * Descriptions are written FOR THE AGENT, not for a developer — they say when
 * to call a tool and what to do with the result, which is most of what makes a
 * tool usable by a model.
 */

const log = createLogger('MCP');

export interface McpTool {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, any>) => Promise<unknown>;
}

const MAX_BATCH = 100;

export const mcpTools: Record<string, McpTool> = {
  list_products: {
    description:
      'Browse the product catalogue. Use this whenever the customer asks what is available, ' +
      'asks for something within a budget, or asks about a category. Supports filtering by ' +
      'category and price range, and a free-text search that also matches variant values such ' +
      'as a colour or a size. Returns one page — call again with a higher `page` for more. ' +
      'Only describe products this tool returned; never invent one.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description:
            'What the customer is looking for, in their own words, e.g. "blue watch" or "office chair". Matches the product name, SKU, brand and variant values. Omit to browse everything.',
        },
        categoryId: {
          type: 'string',
          description:
            'Restrict to one category by its id (e.g. CAT-004). Call list_categories first if you only know the category by name.',
        },
        priceMin: {
          type: 'number',
          description:
            'Lowest price to include, inclusive. Products with no price recorded are excluded from a priced search.',
        },
        priceMax: {
          type: 'number',
          description: 'Highest price to include, inclusive. Use for "under 5000" style questions.',
        },
        status: {
          type: 'string',
          description:
            "Stock status: 'In Stock', 'Low Stock', 'Out of Stock' or 'Unspecified'. 'Unspecified' means no stock figure has been recorded.",
        },
        sortBy: {
          type: 'string',
          description: "Field to sort by: 'price', 'name', 'stock' or 'createdAt'.",
        },
        sortOrder: {
          type: 'string',
          description: "'asc' or 'desc'. Use asc with sortBy price for cheapest first.",
        },
        page: { type: 'number', description: 'Page number, starting at 1. Defaults to 1.' },
        limit: {
          type: 'number',
          description:
            'Products per page. Keep it at 3–5 for WhatsApp and voice, up to 10 for web chat. Defaults to 10, maximum 50.',
        },
      },
    },
    handler: async (params) => {
      /* The same query the public API runs, so the agent and the storefront can
         never disagree about what is in the catalogue. */
      const result = await queryCatalog({
        search: params.search ? String(params.search) : undefined,
        categoryId: params.categoryId ? String(params.categoryId) : undefined,
        priceMin: toBound(params.priceMin),
        priceMax: toBound(params.priceMax),
        status: params.status ? String(params.status) : undefined,
        sortBy: params.sortBy ? String(params.sortBy) : undefined,
        sortOrder: params.sortOrder ? String(params.sortOrder) : undefined,
        page: Number(params.page) || 1,
        limit: Number(params.limit) || 10,
      });

      log.debug(`mcp list_products -> ${result.total} match(es)`, { search: params.search });

      if (result.products.length === 0) {
        return {
          products: [],
          total: 0,
          message:
            'Nothing matched those filters. Suggest a broader search or a different category — ' +
            'call list_categories to see what exists. Do not invent products.',
        };
      }
      return result;
    },
  },

  get_products: {
    description:
      'Fetch the full details of one or more products by id, in a single call. Use it after ' +
      'list_products when the customer picks something and wants specifics — variants, ' +
      'description, stock. Pass several ids at once rather than calling this repeatedly. Ids ' +
      'that do not exist come back in `missing`: say so rather than inventing a product.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'One or more product ids, e.g. ["PRD-0042"] or ["PRD-0042","PRD-0043"]. Take these from a previous list_products result. Maximum 100 per call.',
        },
      },
      required: ['ids'],
    },
    handler: async (params) => {
      const raw = Array.isArray(params.ids) ? params.ids : [params.ids];
      const ids = [...new Set(raw.map((id: unknown) => String(id ?? '').trim()).filter(Boolean))];

      if (ids.length === 0) throw new Error('At least one product id is required.');
      if (ids.length > MAX_BATCH) {
        throw new Error(`At most ${MAX_BATCH} ids per call; ${ids.length} were given.`);
      }

      const found = await Promise.all(ids.map((id) => store.getProductById(id)));
      const products = found.filter(Boolean) as Product[];
      const missing = ids.filter((_, index) => !found[index]);

      return {
        products: products.map(publicProduct),
        requested: ids.length,
        returned: products.length,
        missing,
        ...(missing.length
          ? { message: 'Some ids do not exist in the catalogue. Do not describe those.' }
          : {}),
      };
    },
  },

  list_categories: {
    description:
      'List the catalogue categories. Call this when the customer asks what kinds of things are ' +
      'sold, or when you need a categoryId to narrow a product search. Cheap — call it whenever ' +
      'you are unsure which category a request belongs to.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter categories by name.' },
        limit: { type: 'number', description: 'How many to return. Defaults to 50.' },
      },
    },
    handler: async (params) => {
      const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
      const all = await store.getCategories();

      const term = String(params.search ?? '').trim().toLowerCase();
      const matched = term
        ? all.filter((c: Category) => c.name?.toLowerCase().includes(term))
        : all;

      if (matched.length === 0) {
        return {
          categories: [],
          total: 0,
          message: term ? 'No category matched that name.' : 'No categories are set up yet.',
        };
      }
      return { categories: matched.slice(0, limit).map(publicCategory), total: matched.length };
    },
  },

  get_category: {
    description:
      'Fetch one category by id. Use it when the customer asks about a specific category and you ' +
      'need its description. To list what is inside it, call list_products with that categoryId ' +
      'instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The category id, e.g. CAT-004. Take it from list_categories.',
        },
      },
      required: ['id'],
    },
    handler: async (params) => {
      const id = String(params.id ?? '').trim();
      if (!id) throw new Error('A category id is required.');

      const category = await store.getCategoryById(id);
      if (!category) {
        return { category: null, message: `No category with id ${id}. Call list_categories.` };
      }
      return { category: publicCategory(category) };
    },
  },
};

export const toolDeclarations = () =>
  Object.entries(mcpTools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
