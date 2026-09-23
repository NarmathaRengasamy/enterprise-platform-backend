import { perfoxFetch } from '../utils/perfox.util.js';
import { Conversation, Message, ChannelType } from '../types/index.js';

export interface ExternalConversationRaw {
  id: string;
  customer_id?: string;
  workflow_id?: string;
  status?: string;
  channel_started?: string;
  channels?: string[];
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ExternalEventRaw {
  id: string;
  event_type?: string;
  /** user | ai | human_agent | system */
  actor?: string;
  channel?: string;
  created_at?: string;
  text?: string;
  tool_name?: string;
  /**
   * The TRANSPORT outcome — success | error | timeout. Not the business result:
   * a tool that returned `{ success: false }` still reports `success` here, so
   * anything judging whether the action worked must read `tool_output`.
   */
  tool_status?: string;
  /* Only present when `include=tool_io` is requested. */
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
  tool_error_detail?: string;
  tool_latency_ms?: number;
  /* Only present when `include=files` is requested. */
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  /** Short-lived signed URL, minted on read — never stored. */
  file_url?: string;
  [key: string]: any;
}

// In-memory cache for fast repeat requests
let cachedConversations: Conversation[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30000; // 30 seconds cache

const formatChannelInfo = (rawChannel?: string, channels?: string[]) => {
  const ch = (rawChannel || channels?.[0] || 'web').toLowerCase();
  if (ch.includes('voice') || ch.includes('phone') || ch === 'web_voice') {
    return {
      channel: 'voice' as ChannelType,
      label: 'Voice Call',
      color: '#9333ea',
    };
  }
  if (ch.includes('whatsapp')) {
    return {
      channel: 'whatsapp' as ChannelType,
      label: 'WhatsApp',
      color: '#25D366',
    };
  }
  if (ch.includes('sms')) {
    return {
      channel: 'sms' as ChannelType,
      label: 'SMS',
      color: '#f59e0b',
    };
  }
  if (ch.includes('email')) {
    return {
      channel: 'email' as ChannelType,
      label: 'Email',
      color: '#0284c7',
    };
  }
  return {
    channel: 'web' as ChannelType,
    label: 'Web Chat',
    color: '#2563eb',
  };
};

const formatTime = (isoString?: string): string => {
  if (!isoString) return 'Just now';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'Just now';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'Just now';
  }
};

const formatConversationName = (raw: ExternalConversationRaw): string => {
  if (raw.customer_id) {
    const shortCust = raw.customer_id.split('-').pop() || raw.customer_id.slice(-6);
    return `Customer #${shortCust.toUpperCase()}`;
  }
  const shortId = raw.id.split('-').pop() || raw.id.slice(-6);
  return `Order / Session #${shortId.toUpperCase()}`;
};

export const transformEventToMessage = (
  event: ExternalEventRaw,
  fallbackChannel: string = 'web'
): Message => {
  let sender: 'me' | 'them' | 'system' = 'them';
  if (event.actor === 'ai') {
    sender = 'me';
  } else if (event.actor === 'system') {
    sender = 'system';
  } else if (event.actor === 'user') {
    sender = 'them';
  }

  let text = event.text || '';
  if (!text) {
    if (event.event_type === 'tool_call') {
      text = `⚙️ Action: ${event.tool_name || 'Processing'}`;
    } else if (event.event_type === 'tool_result') {
      text = `✅ Result: ${event.tool_name || 'Success'}`;
    } else if (event.event_type === 'file_upload') {
      text = `📎 Customer uploaded document`;
    } else if (event.event_type === 'call_recorded') {
      text = `📞 Call recorded`;
    } else if (event.event_type === 'guardrail_triggered') {
      text = `🛡️ System security guardrail active`;
    } else if (event.event_type === 'grounding_decision') {
      text = `🧠 Knowledge base grounding applied`;
    } else {
      text = `[${(event.event_type || 'Event').replace(/_/g, ' ')}]`;
    }
  }

  return {
    id: event.id || `evt-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    sender,
    actor: event.actor || (sender === 'me' ? 'ai' : sender === 'them' ? 'user' : 'system'),
    eventType: event.event_type,
    text,
    time: formatTime(event.created_at),
    timestamp: event.created_at,
    channel: event.channel || fallbackChannel,
    toolName: event.tool_name,
    toolStatus: event.tool_status,
    toolLatencyMs: event.tool_latency_ms,
    toolErrorDetail: event.tool_error_detail,
    toolInput: event.tool_input,
    toolOutput: event.tool_output,
    /* Present only for file events, and only because `include=files` is asked
       for. `fileUrl` is signed and short-lived — fine to render, never to
       store or cache. */
    attachment: event.file_name
      ? {
          fileName: event.file_name,
          fileUrl: event.file_url,
          mimeType: event.mime_type,
          fileSize: event.file_size,
        }
      : undefined,
  };
};

export const transformRawConversation = (
  raw: ExternalConversationRaw,
  events: ExternalEventRaw[] = []
): Conversation => {
  const channelInfo = formatChannelInfo(raw.channel_started, raw.channels);
  const name = formatConversationName(raw);
  const initials = name
    .replace('#', '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const messages = events.map((e) => transformEventToMessage(e, channelInfo.channel));

  // Determine last message from summary or last message event
  let lastMessage = raw.summary || '';
  if (!lastMessage && messages.length > 0) {
    const lastMsgWithText = [...messages].reverse().find((m) => m.text);
    if (lastMsgWithText) lastMessage = lastMsgWithText.text;
  }
  if (!lastMessage) {
    lastMessage = `Session started via ${channelInfo.label}`;
  }

  const unread = raw.status === 'abandoned' ? 1 : 0;

  return {
    id: raw.id,
    name,
    customerId: raw.customer_id,
    workflowId: raw.workflow_id,
    status: raw.status || 'ended',
    summary: raw.summary,
    initials: initials || 'CU',
    avatar: '',
    channel: channelInfo.channel,
    channels: raw.channels || [channelInfo.channel],
    channelLabel: channelInfo.label,
    channelColor: channelInfo.color,
    phone: '',
    email: '',
    unread,
    timestamp: formatTime(raw.updated_at || raw.created_at),
    lastMessage,
    messages,
    createdAt: raw.created_at || new Date().toISOString(),
    updatedAt: raw.updated_at || new Date().toISOString(),
  };
};

/**
 * Every conversation in the connected Perfox workspace.
 *
 * Goes through `perfoxFetch`, which resolves the connection configured in the
 * Developer hub. This used to read the API URL and token straight from the
 * environment, so on any deployment that configured Perfox through the UI —
 * which is all of them — the URL was still the `.env` placeholder and every
 * call failed.
 */
export const fetchExternalConversations = async (): Promise<Conversation[]> => {
  const now = Date.now();
  if (cachedConversations && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedConversations;
  }

  const payload = await perfoxFetch<{ data?: ExternalConversationRaw[] }>('/conversations');
  const raw = Array.isArray(payload?.data) ? payload.data : [];
  const conversations = raw.map((row) => transformRawConversation(row));

  cachedConversations = conversations;
  lastFetchTime = now;
  return conversations;
};

/**
 * One conversation and its event stream.
 *
 * Both are fetched together: the summary row carries no messages, and the
 * events endpoint carries no customer details, so a detail view needs both.
 */
export const fetchExternalConversationById = async (id: string): Promise<Conversation> => {
  const path = `/conversations/${encodeURIComponent(id)}`;
  const [detail, rawEvents] = await Promise.all([
    perfoxFetch<any>(path),
    /* Events are the body of the conversation, but a conversation with none is
       still a conversation — an empty list must not fail the whole read. */
    fetchExternalConversationEvents(id).catch(() => [] as ExternalEventRaw[]),
  ]);

  const rawConversation: ExternalConversationRaw = detail?.data ?? detail;

  const conversation = transformRawConversation(rawConversation);
  conversation.messages = rawEvents
    .map((event) => transformEventToMessage(event, conversation.channel))
    .filter(Boolean) as Message[];

  const lastText = [...conversation.messages].reverse().find((m) => m.text)?.text;
  if (lastText) conversation.lastMessage = lastText;

  return conversation;
};

/* Opt-in payloads. Without `files` an attachment carries no name, type or URL,
   and without `tool_io` a tool call shows only its name — neither is enough to
   tell an operator what actually happened. */
const EVENT_INCLUDE = 'tool_io,files';

/* The API caps a page at 1000 and defaults to 100. Asking for the maximum keeps
   a long transcript to one round trip in almost every case. */
const EVENT_PAGE_SIZE = 1000;

/* A ceiling on paging, so a pathological conversation cannot spin forever. */
const MAX_EVENT_PAGES = 20;

/**
 * The full event stream for one conversation.
 *
 * Pages through `next_after` until the API says there is no more. The previous
 * version made a single unparameterised call, which took the default first 100
 * events and silently dropped the rest — a long thread rendered as a partial
 * transcript with nothing to say so.
 */
export const fetchExternalConversationEvents = async (
  id: string
): Promise<ExternalEventRaw[]> => {
  const base = `/conversations/${encodeURIComponent(id)}/events`;
  const events: ExternalEventRaw[] = [];
  let after: string | undefined;

  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const query = new URLSearchParams({
      include: EVENT_INCLUDE,
      limit: String(EVENT_PAGE_SIZE),
    });
    if (after) query.set('after', after);

    const payload = await perfoxFetch<{
      data?: ExternalEventRaw[];
      has_more?: boolean;
      next_after?: string;
    }>(`${base}?${query.toString()}`);

    const rows = Array.isArray(payload?.data) ? payload.data : [];
    events.push(...rows);

    /* `has_more` is the authority; `next_after` without it would loop. */
    if (!payload?.has_more || !payload?.next_after || !rows.length) break;
    after = payload.next_after;

    if (page === MAX_EVENT_PAGES - 1) {
      console.warn(
        `[Perfox] Stopped paging ${base} at ${events.length} events — more remain`
      );
    }
  }

  return events;
};
