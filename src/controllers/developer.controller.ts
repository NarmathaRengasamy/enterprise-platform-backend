import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { generateId, ok } from '../utils/response.util.js';
import {
  assertSafeUrl,
  authHeadersFor,
  maskAgent,
  maskEndpoint,
} from '../utils/outbound.util.js';

const log = createLogger('DeveloperController');
const PING_TIMEOUT_MS = 8000;

/** connectedAgentsCount is derived, never trusted from the stored value. */
const refreshEndpointCounts = async (): Promise<void> => {
  const agents = await store.getAgents();
  const counts = new Map<string, number>();
  for (const agent of agents) {
    for (const endpointId of agent.assignedEndpoints ?? []) {
      counts.set(endpointId, (counts.get(endpointId) ?? 0) + 1);
    }
  }
  const endpoints = await store.getEndpoints();
  await Promise.all(
    endpoints.map((e) => store.updateEndpoint(e.id, { connectedAgentsCount: counts.get(e.id) ?? 0 }))
  );
};
import { AIAgent, WebhookEndpoint } from '../types/index.js';

export const createAgentSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Agent name is required'),
    workflowId: z.string().min(1, 'Workflow ID is required'),
    channel: z.string().optional().default('Web Storefront Widget'),
    model: z.string().optional().default('Perfox-Omni 2.5'),
    accentColor: z.string().optional().default('#2563eb'),
    position: z.enum(['bottom-right', 'bottom-left', 'embed-inline']).optional().default('bottom-right'),
    description: z.string().optional().default(''),
    assignedEndpoints: z.array(z.string()).optional().default([]),
  }),
});

export const updateAgentSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    workflowId: z.string().optional(),
    channel: z.string().optional(),
    model: z.string().optional(),
    accentColor: z.string().optional(),
    position: z.enum(['bottom-right', 'bottom-left', 'embed-inline']).optional(),
    status: z.enum(['Active', 'Standby', 'Disabled']).optional(),
    description: z.string().optional(),
    assignedEndpoints: z.array(z.string()).optional(),
  }),
});

export const createEndpointSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Endpoint name is required'),
    url: z.string().url('Valid URL is required'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().default('GET'),
    transport: z.enum(['HTTP', 'SSE', 'WebSocket']).optional().default('HTTP'),
    authType: z.enum(['none', 'bearer', 'apiKey', 'basic']).optional().default('none'),
    authConfig: z.object({
      bearerToken: z.string().optional(),
      headerName: z.string().optional(),
      apiKeyValue: z.string().optional(),
      basicAuth: z.string().optional(),
    }).optional().default({}),
    headers: z.array(z.object({
      id: z.number(),
      key: z.string(),
      value: z.string(),
    })).optional(),
    queryParams: z.array(z.object({
      id: z.number(),
      key: z.string(),
      value: z.string(),
    })).optional(),
    bodyFormat: z.string().optional(),
    bodyContent: z.string().optional(),
  }),
});

export const updateEndpointSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    url: z.string().url().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
    transport: z.enum(['HTTP', 'SSE', 'WebSocket']).optional(),
    authType: z.enum(['none', 'bearer', 'apiKey', 'basic']).optional(),
    authConfig: z.any().optional(),
    headers: z.array(z.any()).optional(),
    queryParams: z.array(z.any()).optional(),
    bodyFormat: z.string().optional(),
    bodyContent: z.string().optional(),
    status: z.enum(['Healthy', 'Degraded', 'Offline']).optional(),
  }),
});

export const getAgents = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const agents = await store.getAgents();

    res.status(200).json({
      success: true,
      total: agents.length,
      data: agents.map(maskAgent),
    });
  } catch (error) {
    next(error);
  }
};

export const getAgentById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const agent = await store.getAgentById(id);

    if (!agent) {
      throw new AppError('AI Agent not found', 404);
    }

    res.status(200).json(ok(maskAgent(agent)));
  } catch (error) {
    next(error);
  }
};

export const createAgent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const body = req.body;
    const siteKey = `pk_live_${crypto.randomBytes(12).toString('hex')}`;
    const secretKey = `sk_live_${crypto.randomBytes(16).toString('hex')}`;

    const newAgent: AIAgent = {
      id: generateId('agt'),
      siteKey,
      secretKey,
      status: 'Active',
      statusColor: 'emerald',
      totalCalls: '0',
      avgLatency: '15 ms',
      createdAt: new Date().toISOString(),
      ...body,
    };

    const created = await store.createAgent(newAgent);
    await refreshEndpointCounts();
    log.log(`Created agent ${created.id} (${created.name})`);

    /* The plaintext secret is shown exactly once, here. Every later read is
       masked, so a list response can no longer leak every agent's key. */
    res.status(201).json(
      ok(
        {
          ...maskAgent(created),
          secretKey,
          warning: 'Store this key now — it will not be shown again.',
        },
        'AI Agent created successfully'
      )
    );
  } catch (error) {
    next(error);
  }
};

export const updateAgent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await store.getAgentById(id);
    if (!existing) {
      throw new AppError('AI Agent not found', 404);
    }

    const updated = await store.updateAgent(id, updates);

    res.status(200).json({
      success: true,
      message: 'AI Agent updated successfully',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const updateAgentStatusSchema = z.object({
  body: z.object({
    status: z.enum(['Active', 'Paused', 'Standby', 'Disabled']),
  }),
});

export const assignEndpointsSchema = z.object({
  body: z.object({
    assignedEndpoints: z.array(z.string()),
  }),
});

/** Activate / pause toggle — finer grained than a whole-object PUT. */
export const updateAgentStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const updated = await store.updateAgent(id, {
      status,
      statusColor: status === 'Active' ? 'emerald' : 'amber',
    } as any);
    if (!updated) throw new AppError('Agent not found', 404);

    log.log(`Agent ${id} status -> ${status}`);
    res.status(200).json(ok(maskAgent(updated), 'Agent status updated'));
  } catch (error) {
    next(toAppError(error, `Could not change status for agent ${req.params.id}`, log));
  }
};

/** Full-replacement assignment, which matches the checkbox grid in the UI. */
export const assignAgentEndpoints = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { assignedEndpoints } = req.body as { assignedEndpoints: string[] };

    const known = await store.getEndpoints();
    const knownIds = new Set(known.map((e) => e.id));
    if (assignedEndpoints.some((endpointId) => !knownIds.has(endpointId))) {
      throw new AppError('One or more endpoint ids do not exist', 400);
    }

    const updated = await store.updateAgent(id, { assignedEndpoints } as any);
    if (!updated) throw new AppError('Agent not found', 404);

    await refreshEndpointCounts();
    log.log(`Agent ${id} now has ${assignedEndpoints.length} endpoint(s)`);
    res.status(200).json(ok(maskAgent(updated), 'Endpoint assignment saved'));
  } catch (error) {
    next(toAppError(error, `Could not assign endpoints for agent ${req.params.id}`, log));
  }
};

/**
 * Rotates the secret server-side and returns the new value exactly once.
 * The frontend previously minted its own key with Math.random() and saved it
 * through a plain update.
 */
export const rotateAgentKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const secretKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;

    const updated = await store.updateAgent(id, { secretKey } as any);
    if (!updated) throw new AppError('Agent not found', 404);

    log.warn(`Rotated the secret key for agent ${id}`);
    res.status(200).json(
      ok(
        {
          ...maskAgent(updated),
          secretKey,
          warning: 'Store this key now — it will not be shown again.',
        },
        'Secret key rotated'
      )
    );
  } catch (error) {
    next(toAppError(error, `Could not rotate the key for agent ${req.params.id}`, log));
  }
};

export const deleteAgent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await store.deleteAgent(id);

    if (!success) {
      throw new AppError('AI Agent not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'AI Agent deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

export const getEndpoints = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const endpoints = await store.getEndpoints();

    res.status(200).json({
      success: true,
      total: endpoints.length,
      data: endpoints.map(maskEndpoint),
    });
  } catch (error) {
    next(error);
  }
};

export const getEndpointById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const endpoint = await store.getEndpointById(id);

    if (!endpoint) {
      throw new AppError('Endpoint not found', 404);
    }

    res.status(200).json({
      success: true,
      data: endpoint,
    });
  } catch (error) {
    next(error);
  }
};

export const createEndpoint = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const body = req.body;
    /* Refuse an internal or loopback target before it is ever stored. */
    await assertSafeUrl(body.url);

    const newEndpoint: WebhookEndpoint = {
      ...body,
      id: generateId('ep'),
      /* Never pinged yet — saying "Healthy, 200 OK, 15ms" before any request has
         been made is exactly the fiction this port removes. */
      status: 'Healthy',
      statusColor: 'emerald',
      latency: '0 ms',
      connectedAgentsCount: 0,
      lastPingStatus: 'Not pinged',
      lastPingTime: 'Never',
    };

    const created = await store.createEndpoint(newEndpoint);
    log.log(`Registered endpoint ${created.id} -> ${body.method ?? 'GET'} ${body.url}`);

    res.status(201).json(ok(maskEndpoint(created), 'Webhook Endpoint registered successfully'));
  } catch (error) {
    next(error);
  }
};

export const updateEndpoint = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    if (req.body.url) await assertSafeUrl(req.body.url);
    const updates = req.body;

    const existing = await store.getEndpointById(id);
    if (!existing) {
      throw new AppError('Endpoint not found', 404);
    }

    const updated = await store.updateEndpoint(id, updates);

    res.status(200).json({
      success: true,
      message: 'Endpoint updated successfully',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteEndpoint = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await store.deleteEndpoint(id);

    if (!success) {
      throw new AppError('Endpoint not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'Endpoint deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Performs a real request and reports what actually happened.
 *
 * The previous implementation returned `Math.random()` latency and a hardcoded
 * "200 OK" without contacting anything, so every health indicator in the UI was
 * fiction — a dead endpoint still showed as Healthy.
 */
export const pingEndpoint = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const endpoint = await store.getEndpointById(id);
    if (!endpoint) throw new AppError('Endpoint not found', 404);

    await assertSafeUrl(endpoint.url);

    const headers: Record<string, string> = {};
    for (const header of (endpoint as any).headers ?? []) {
      if (header?.key) headers[header.key] = header.value ?? '';
    }
    Object.assign(headers, authHeadersFor(endpoint));

    const url = new URL(endpoint.url);
    for (const param of (endpoint as any).queryParams ?? []) {
      if (param?.key) url.searchParams.append(param.key, param.value ?? '');
    }

    const method = (endpoint.method ?? 'GET').toUpperCase();
    const sendsBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (sendsBody && (endpoint as any).bodyFormat) {
      headers['Content-Type'] = (endpoint as any).bodyFormat;
    }

    const startedAt = Date.now();
    let statusText: string;
    let healthy: boolean;

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: sendsBody && (endpoint as any).bodyContent ? (endpoint as any).bodyContent : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      statusText = `${response.status} ${response.statusText}`.trim();
      healthy = response.status < 400;
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? 'Timeout' : (err as Error).message;
      statusText = `Failed: ${reason}`;
      healthy = false;
    }

    const latencyMs = Date.now() - startedAt;

    const updated = await store.updateEndpoint(id, {
      status: healthy ? 'Healthy' : 'Offline',
      statusColor: healthy ? 'emerald' : 'rose',
      latency: `${latencyMs} ms`,
      lastPingStatus: statusText,
      lastPingTime: 'Just now',
    } as any);

    const line = `Ping ${id} -> ${statusText} in ${latencyMs}ms`;
    healthy ? log.log(line) : log.warn(line);

    res.status(200).json(
      ok(
        {
          endpointId: id,
          url: endpoint.url,
          status: statusText,
          healthy,
          latency: `${latencyMs} ms`,
          timestamp: new Date().toISOString(),
          details: maskEndpoint(updated),
        },
        healthy ? `Ping successful (${latencyMs} ms)` : `Ping failed — ${statusText}`
      )
    );
  } catch (error) {
    next(toAppError(error, `Could not ping endpoint ${req.params.id}`, log));
  }
};
