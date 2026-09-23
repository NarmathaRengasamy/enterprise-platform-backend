import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { ok } from '../utils/response.util.js';
import { perfoxFetch, toWorkspaceAgent } from '../utils/perfox.util.js';
import { AIAgent } from '../types/index.js';

const log = createLogger('PerfoxController');

/** Maps a Perfox agent onto the fields the cache stores for it. */
const toCachedAgent = (raw: any): Partial<AIAgent> => {
  const agent = toWorkspaceAgent(raw);
  return {
    /* The Perfox id is the agent's identity here too — one id, not a local one
       shadowing a remote one. */
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    channels: agent.channels,
    /* Filled in by the sync, which reads the graph; a bare list read cannot
       know it, and an empty default must not overwrite a known value. */
    senderChannels: [],
    activeVersion: agent.activeVersion,
    nodeCount: agent.nodeCount,
    perfoxCreatedAt: agent.createdAt,
    perfoxUpdatedAt: agent.updatedAt,
  };
};

/** Fetches the workspace agents and writes them into the cache. */
/**
 * Sender node type -> the channel it can reach out on.
 *
 * Perfox reports an agent's `channels` as its TRIGGER channels — how
 * conversations start. What it can send on lives in the graph as sender nodes,
 * which only `GET /agents/{id}` returns. An agent triggered by web chat can
 * still hold a WhatsApp sender, so the two must be read separately.
 */
const SENDER_NODE_CHANNELS: Record<string, string> = {
  whatsapp_sender: 'whatsapp',
  sms_sender: 'sms',
  email_sender: 'email',
  phone_caller: 'phone',
};

/* Perfox rate-limits (retry_after: 60), and this runs once per agent on a
   sync. Spacing the reads keeps a 12-agent workspace under the limit. */
const AGENT_GRAPH_DELAY_MS = 900;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The channels one agent can reach out on, read from its graph.
 *
 * A failure here is not fatal: the agent still syncs, it simply reports no
 * sender until the next refresh. Losing the whole sync because one graph could
 * not be read would be worse.
 */
const readSenderChannels = async (id: string): Promise<string[]> => {
  try {
    const payload = await perfoxFetch<any>(`/agents/${encodeURIComponent(id)}`);
    const nodes = (payload?.data ?? payload)?.nodes;
    if (!Array.isArray(nodes)) return [];

    const channels = new Set<string>();
    for (const node of nodes) {
      const channel = SENDER_NODE_CHANNELS[String(node?.type ?? '')];
      if (channel) channels.add(channel);
    }
    return [...channels];
  } catch (error) {
    log.warn(`Could not read the graph for agent ${id}: ${(error as Error).message}`);
    return [];
  }
};

const refreshFromPerfox = async (): Promise<{ synced: number; removed: number }> => {
  const payload = await perfoxFetch<{ data?: any[] }>('/agents');
  const raw = Array.isArray(payload?.data) ? payload.data : [];
  const agents = raw.map(toCachedAgent);

  /* Serial, not parallel: twelve simultaneous reads trip the rate limit, and a
     sync is not on a request path anyone is waiting behind. */
  for (let index = 0; index < agents.length; index += 1) {
    if (index > 0) await pause(AGENT_GRAPH_DELAY_MS);
    agents[index].senderChannels = await readSenderChannels(agents[index].id!);
  }

  const result = await store.syncAgentsFromPerfox(agents);

  const sendCapable = agents.filter((a) => (a.senderChannels ?? []).length).length;
  log.log(
    `Synced ${result.synced} agent(s) from Perfox, ${sendCapable} with an outbound sender` +
      (result.removed ? `, removed ${result.removed} no longer in the workspace` : '')
  );
  return result;
};

/**
 * GET /developer/agents
 *
 * Served from our own collection. Perfox is called in exactly two cases:
 *
 *   1. the cache is empty — the first ever load has to come from somewhere;
 *   2. `?refresh=true` — the user asked for it.
 *
 * Every other read is local, so opening the tab does not hit the platform.
 */
export const listAgents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refresh = String(req.query.refresh ?? '').toLowerCase() === 'true';
    const cached = await store.countAgents();

    let source: 'cache' | 'perfox' = 'cache';
    let sync: { synced: number; removed: number } | null = null;

    if (refresh || cached === 0) {
      log.debug(refresh ? 'Refresh requested — calling Perfox' : 'Cache is empty — calling Perfox');
      sync = await refreshFromPerfox();
      source = 'perfox';
    }

    const agents = await store.getAgents();
    return res.status(200).json(
      ok({
        source,
        syncedAt: agents[0]?.syncedAt ?? '',
        ...(sync ?? {}),
        agents,
      })
    );
  } catch (error) {
    return next(toAppError(error, 'Could not list the agents', log));
  }
};

/** GET /developer/agents/:id — from the cache; 404 if it is not there. */
export const getAgentById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agent = await store.getAgentById(req.params.id);
    if (!agent) throw new AppError('Agent not found', 404);
    return res.status(200).json(ok(agent));
  } catch (error) {
    return next(toAppError(error, `Could not read agent ${req.params.id}`, log));
  }
};

export const setAgentStatusSchema = z.object({
  body: z.object({
    /* Only the two states a toggle can express. A draft agent has to be
       published in Perfox first — there is nothing to toggle between. */
    status: z.enum(['published', 'paused'], {
      errorMap: () => ({ message: "status must be 'published' or 'paused'" }),
    }),
  }),
});

/**
 * PATCH /developer/agents/:id/status
 *
 * Wraps the two different Perfox calls behind one switch:
 *
 *   paused    -> PATCH /agents/{id}   with status: 'paused'
 *   published -> POST  /agents/{id}/publish
 *
 * The pause path reads the agent first and echoes its current name, description,
 * channels, nodes and edges back alongside the new status. Perfox's own example
 * sends the whole document, so posting `{ status }` alone would risk clearing
 * the flow if the endpoint replaces rather than merges. One extra read is worth
 * not gambling with someone's agent.
 */
export const setAgentStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const target = String(req.body.status);

    const cached = await store.getAgentById(id);
    if (!cached) throw new AppError('Agent not found', 404);

    if (cached.status === 'draft') {
      throw new AppError(
        'A draft agent cannot be toggled — publish it in Perfox first',
        409
      );
    }
    if (cached.status === target) {
      /* Nothing to do; saying so beats a pointless round trip to Perfox. */
      return res.status(200).json(ok(cached, `Agent is already ${target}`));
    }

    if (target === 'published') {
      await perfoxFetch(`/agents/${encodeURIComponent(id)}/publish`, { method: 'POST' });
      log.log(`Published agent ${id}`);
    } else {
      const current = await perfoxFetch<any>(`/agents/${encodeURIComponent(id)}`);
      const doc = current?.data ?? current;
      if (!doc?.id) throw new AppError('Agent not found in the Perfox workspace', 404);

      await perfoxFetch(`/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: doc.name,
          description: doc.description ?? '',
          channels: doc.channels ?? [],
          nodes: doc.nodes ?? [],
          edges: doc.edges ?? [],
          status: 'paused',
        }),
      });
      log.log(`Paused agent ${id}`);
    }

    /* Read back rather than assume the write took: Perfox is the authority on
       what the status now is. */
    const confirmed = await perfoxFetch<any>(`/agents/${encodeURIComponent(id)}`);
    const fresh = toCachedAgent(confirmed?.data ?? confirmed);
    const updated = await store.updateAgent(id, { ...fresh, syncedAt: new Date().toISOString() });

    return res.status(200).json(
      ok(updated, `Agent ${fresh.status === 'published' ? 'published' : 'paused'}`)
    );
  } catch (error) {
    return next(toAppError(error, `Could not change the status of agent ${req.params.id}`, log));
  }
};
