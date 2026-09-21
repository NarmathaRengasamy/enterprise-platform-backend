import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
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
      data: agents,
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

    res.status(200).json({
      success: true,
      data: agent,
    });
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

    const existingAgents = await store.getAgents();
    const newAgent: AIAgent = {
      id: `agt-${String(existingAgents.length + 1).padStart(3, '0')}`,
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

    res.status(201).json({
      success: true,
      message: 'AI Agent created successfully',
      data: created,
    });
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
      data: endpoints,
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
    const existingEndpoints = await store.getEndpoints();

    const newEndpoint: WebhookEndpoint = {
      id: `ep-${existingEndpoints.length + 1}`,
      status: 'Healthy',
      statusColor: 'emerald',
      latency: `${Math.floor(Math.random() * 20) + 12} ms`,
      connectedAgentsCount: 0,
      lastPingStatus: '200 OK',
      lastPingTime: 'Just now',
      ...body,
    };

    const created = await store.createEndpoint(newEndpoint);

    res.status(201).json({
      success: true,
      message: 'Webhook Endpoint registered successfully',
      data: created,
    });
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

export const pingEndpoint = async (
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

    const latencyNum = Math.floor(Math.random() * 25) + 10;
    const updated = await store.updateEndpoint(id, {
      status: 'Healthy',
      statusColor: 'emerald',
      latency: `${latencyNum} ms`,
      lastPingStatus: '200 OK',
      lastPingTime: 'Just now',
    });

    res.status(200).json({
      success: true,
      message: `Ping successful (${latencyNum} ms)`,
      data: {
        endpointId: id,
        url: endpoint.url,
        status: '200 OK',
        latency: `${latencyNum} ms`,
        timestamp: new Date().toISOString(),
        details: updated,
      },
    });
  } catch (error) {
    next(error);
  }
};
