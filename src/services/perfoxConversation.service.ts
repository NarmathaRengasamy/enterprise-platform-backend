import { config } from '../config/index.js';
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
  actor?: string; // 'user' | 'ai' | 'system'
  channel?: string;
  created_at?: string;
  text?: string;
  tool_name?: string;
  tool_status?: string;
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

export const fetchExternalConversations = async (): Promise<Conversation[]> => {
  const now = Date.now();
  if (cachedConversations && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedConversations;
  }

  try {
    const response = await fetch(`${config.perfoxApiUrl}/conversations`, {
      method: 'GET',
      headers: {
        Authorization: config.perfoxApiToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Perfox API responded with HTTP ${response.status}: ${response.statusText}`);
    }

    const payload = (await response.json()) as { data?: ExternalConversationRaw[] };
    const rawList: ExternalConversationRaw[] = Array.isArray(payload)
      ? payload
      : payload.data || [];

    const transformed = rawList.map((raw) => transformRawConversation(raw, []));

    cachedConversations = transformed;
    lastFetchTime = now;

    return transformed;
  } catch (error: any) {
    console.error('❌ [Perfox Conversation API Error]:', error.message);
    if (cachedConversations) {
      return cachedConversations;
    }
    throw error;
  }
};

export const fetchExternalConversationById = async (id: string): Promise<Conversation> => {
  try {
    // Fetch conversation metadata and events in parallel
    const [convoRes, eventsRes] = await Promise.all([
      fetch(`${config.perfoxApiUrl}/conversations/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          Authorization: config.perfoxApiToken,
          'Content-Type': 'application/json',
        },
      }),
      fetch(`${config.perfoxApiUrl}/conversations/${encodeURIComponent(id)}/events`, {
        method: 'GET',
        headers: {
          Authorization: config.perfoxApiToken,
          'Content-Type': 'application/json',
        },
      }),
    ]);

    if (!convoRes.ok) {
      throw new Error(`Failed to fetch conversation ${id}: HTTP ${convoRes.status}`);
    }

    const convoData = (await convoRes.json()) as ExternalConversationRaw;
    let eventsData: ExternalEventRaw[] = [];

    if (eventsRes.ok) {
      const evPayload = (await eventsRes.json()) as { data?: ExternalEventRaw[] };
      eventsData = Array.isArray(evPayload) ? evPayload : evPayload.data || [];
    }

    return transformRawConversation(convoData, eventsData);
  } catch (error: any) {
    console.error(`❌ [Perfox API Error for conversation ${id}]:`, error.message);
    throw error;
  }
};

export const fetchExternalConversationEvents = async (id: string): Promise<ExternalEventRaw[]> => {
  try {
    const response = await fetch(
      `${config.perfoxApiUrl}/conversations/${encodeURIComponent(id)}/events`,
      {
        method: 'GET',
        headers: {
          Authorization: config.perfoxApiToken,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch events for ${id}: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { data?: ExternalEventRaw[] };
    return Array.isArray(payload) ? payload : payload.data || [];
  } catch (error: any) {
    console.error(`❌ [Perfox API Events Error for ${id}]:`, error.message);
    throw error;
  }
};
