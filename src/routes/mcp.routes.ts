import { Router, Request, Response } from 'express';
import { mcpTools, toolDeclarations } from '../mcp/tools.js';
import { createLogger } from '../utils/logger.js';

/**
 * MCP over JSON-RPC 2.0, mounted inside this service.
 *
 *   POST /mcp          initialize · tools/list · tools/call
 *   GET  /mcp/health   liveness, and what tools are exposed
 *
 * Mounted OUTSIDE the JWT-protected API router: the caller is an AI agent on
 * the Perfox platform, not a signed-in member of staff, so it carries its own
 * shared secret instead of a user session.
 */

const log = createLogger('MCP');
const router = Router();

/* JSON-RPC 2.0 codes, named so intent is readable at the call site. */
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const UNAUTHORIZED = -32001;

const rpcError = (res: Response, id: unknown, code: number, message: string) =>
  res.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * Shared-secret gate.
 *
 * Unset means open, which is fine on a laptop and wrong anywhere else — so it
 * is logged loudly at boot rather than failing silently. The catalogue is
 * customer-facing data, but an open endpoint is still an open endpoint.
 */
const requireMcpToken = (req: Request, res: Response, next: () => void) => {
  const expected = process.env.MCP_TOKEN?.trim();
  if (!expected) return next();

  const supplied = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (supplied !== expected) {
    log.warn('MCP call rejected: bad or missing token');
    return rpcError(res, (req.body as any)?.id, UNAUTHORIZED, 'Unauthorized');
  }
  return next();
};

router.post('/', requireMcpToken, async (req: Request, res: Response) => {
  const { jsonrpc, id, method, params } = (req.body ?? {}) as any;

  if (jsonrpc !== '2.0') {
    return rpcError(res, id, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
  }

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'omniflow-catalog-mcp', version: '1.0.0' },
        },
      });
    }

    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools: toolDeclarations() } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params ?? {};
      const tool = mcpTools[name];
      if (!tool) return rpcError(res, id, METHOD_NOT_FOUND, `Tool not found: ${name}`);

      const result = await tool.handler(args || {});
      log.debug(`mcp tools/call ${name}`);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
    }

    return rpcError(res, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  } catch (error) {
    /* Logged in full, returned as the message only — the agent reads this out
       to a customer, so a stack trace has no business in it. */
    log.error(`mcp ${method} failed`, error as Error);
    return rpcError(res, id, INTERNAL_ERROR, (error as Error).message ?? 'Unexpected error');
  }
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'omniflow-catalog-mcp',
    tools: Object.keys(mcpTools),
    secured: Boolean(process.env.MCP_TOKEN?.trim()),
    timestamp: new Date().toISOString(),
  });
});

export default router;
