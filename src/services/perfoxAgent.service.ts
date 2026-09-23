import { perfoxFetch } from '../utils/perfox.util.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PerfoxAgentService');

/**
 * The channels an agent is triggered on, read from its own graph.
 *
 * `GET /agents` reports a `channels` field, but it is not complete enough to
 * gate outbound on — so the decision is made from the agent's trigger nodes,
 * which only `GET /agents/{id}` returns.
 *
 * A trigger node looks like:
 *
 *   { type: 'trigger', config: { trigger_type: 'inbound_message', channel: 'web' } }
 *
 * Only `config.channel` is read. Webhook triggers carry their channel under a
 * different key and are deliberately ignored for now.
 */

/** Only these are offerable in the composer; a `web` trigger is not outbound. */
const OUTBOUND_CHANNELS = new Set(['whatsapp', 'sms', 'email']);

/* One Perfox call per conversation opened, against a rate limit that answers
   `retry_after: 60`. Clicking between threads on the same agent must not
   re-ask, and an agent's canvas does not change between two clicks. */
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { channels: string[]; at: number }>();

/**
 * Every channel named by a trigger on this agent, lowercased.
 *
 * Returns an empty list when the graph cannot be read: with no evidence that a
 * channel is configured, the composer offers nothing rather than offering a
 * send that would fail at Perfox.
 */
export const fetchAgentTriggerChannels = async (agentId: string): Promise<string[]> => {
  if (!agentId) return [];

  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.channels;

  try {
    const payload = await perfoxFetch<any>(`/agents/${encodeURIComponent(agentId)}`);
    const nodes = (payload?.data ?? payload)?.nodes;
    if (!Array.isArray(nodes)) return [];

    const channels = new Set<string>();
    for (const node of nodes) {
      if (String(node?.type ?? '') !== 'trigger') continue;
      const channel = String(node?.config?.channel ?? '').toLowerCase();
      if (channel) channels.add(channel);
    }

    const list = [...channels];
    cache.set(agentId, { channels: list, at: Date.now() });
    return list;
  } catch (error) {
    log.warn(`Could not read triggers for agent ${agentId}: ${(error as Error).message}`);
    return [];
  }
};

/** The subset the composer may offer — `web` and the rest are not outbound. */
export const outboundTriggerChannels = (channels: string[]): string[] =>
  channels.filter((channel) => OUTBOUND_CHANNELS.has(channel));
