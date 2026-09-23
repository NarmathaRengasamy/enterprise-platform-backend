import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { getPageParams, ok, paginated } from '../utils/response.util.js';

const log = createLogger('ConversationController');
import { Conversation, Message } from '../types/index.js';
import {
  fetchExternalConversations,
  fetchExternalConversationById,
  fetchExternalConversationEvents,
} from '../services/perfoxConversation.service.js';
import {
  fetchCustomerIndex,
  fetchCustomerById,
  displayName,
} from '../services/perfoxCustomer.service.js';

export const createConversationSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required'),
    avatar: z.string().optional().default(''),
    initials: z.string().optional(),
    channel: z.enum(['whatsapp', 'sms', 'email', 'voice', 'web']),
    channelLabel: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    initialMessage: z.string().min(1, 'Initial message is required'),
  }),
});

export const sendMessageSchema = z.object({
  body: z.object({
    text: z.string().min(1, 'Message text is required'),
    sender: z.enum(['me', 'them', 'system']).optional().default('me'),
    channel: z.enum(['whatsapp', 'sms', 'email', 'voice', 'web']).optional(),
    attachment: z
      .object({
        title: z.string().optional(),
        sku: z.string().optional(),
        status: z.string().optional(),
        image: z.string().optional(),
        fileUrl: z.string().optional(),
        fileName: z.string().optional(),
      })
      .optional(),
  }),
});

export const getConversations = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { channel, search, agentId } = req.query;

    let conversations: Conversation[] = [];
    /* Reported to the caller: falling back to the local copy without saying so
       is how a stale list gets mistaken for a live one. */
    let source: 'perfox' | 'local' = 'perfox';
    let sourceError = '';

    try {
      conversations = await fetchExternalConversations();
      /* Mirrored locally so the list survives Perfox being unreachable. */
      store.upsertConversations(conversations).catch((err) => {
        log.warn(`Could not mirror conversations locally: ${err.message}`);
      });
    } catch (apiErr: any) {
      source = 'local';
      sourceError = apiErr?.message ?? 'Perfox was unreachable';
      log.warn(`Perfox unavailable, serving the local copy: ${sourceError}`);
      conversations = await store.getConversations();
    }

    // Apply filtering by channel
    if (channel && channel !== 'all' && channel !== 'All') {
      const chFilter = (channel as string).toLowerCase();
      conversations = conversations.filter(
        (c) => c.channel?.toLowerCase() === chFilter || c.channels?.some((ch) => ch.toLowerCase() === chFilter)
      );
    }

    // Apply search filter
    if (search) {
      const q = (search as string).toLowerCase();
      conversations = conversations.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (c.summary && c.summary.toLowerCase().includes(q)) ||
          (c.lastMessage && c.lastMessage.toLowerCase().includes(q)) ||
          (c.customerId && c.customerId.toLowerCase().includes(q))
      );
    }

    /* The id alone means nothing to a person, so each row is given the agent's
       name from the cache. Agents deleted in Perfox leave threads behind, so a
       missing name is expected rather than an error. */
    const agents = await store.getAgents();
    const agentNames = new Map(agents.map((a: any) => [a.id, a.name]));
    /* The channels the agent is integrated with — what the composer may offer.
       A channel is only a real option if the agent can actually send on it. */
    const agentChannels = new Map(agents.map((a: any) => [a.id, a.channels ?? []]));

    /* Built BEFORE the agent filter is applied, and counted against the channel
       and search already in force.

       Deriving them afterwards left the dropdown holding only the agent just
       selected, so there was no way to switch to a different one without
       clearing the filter first. Counting them here also means each option
       reports what it would actually return in the current context, rather than
       a total that ignores the search box. */
    const counts = new Map<string, number>();
    conversations.forEach((c) => {
      if (!c.workflowId) return;
      counts.set(c.workflowId, (counts.get(c.workflowId) ?? 0) + 1);
    });

    const usedAgents = [...counts.entries()]
      .map(([id, count]) => ({ id, name: agentNames.get(id) ?? '', count }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

    /* Applied last, so it narrows the rows without narrowing the choices. */
    if (agentId && agentId !== 'all') {
      conversations = conversations.filter((c) => c.workflowId === agentId);
    }

    /* One call for the whole list, cached. `GET /customers` returns only the
       identified customers — the rest are anonymous visitors, and resolving
       those one by one would be a request per row against an API that
       rate-limits well below that. */
    let customers = new Map<string, any>();
    try {
      customers = await fetchCustomerIndex();
    } catch (err: any) {
      log.warn(`Could not read the customer index: ${err?.message ?? err}`);
    }

    const rows = conversations.map((c) => {
      const customer = c.customerId ? customers.get(c.customerId) : undefined;
      return {
        ...c,
        agentId: c.workflowId ?? '',
        agentName: c.workflowId ? agentNames.get(c.workflowId) ?? '' : '',
        agentChannels: c.workflowId ? agentChannels.get(c.workflowId) ?? [] : [],
        /* Absent from the index means anonymous: `GET /customers` returns
           everyone who has identified themselves, and six sampled absentees
           were all tagged `anonymous`. If that ever proves wrong, opening the
           thread resolves the real record by id and corrects the name. */
        name: customer
          ? displayName(customer, c.customerId)
          : c.customerId
            ? 'Anonymous visitor'
            : 'Unknown customer',
        /* Initials follow the name, or the bubble shows letters from an id. */
        initials: customer && !customer.anonymous && customer.name
          ? customer.name
              .split(' ')
              .filter(Boolean)
              .map((w: string) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()
          : '?',
        customerName: customer?.name ?? '',
        customerEmail: customer?.email ?? '',
        customerPhone: customer?.phone ?? '',
        customerTags: customer?.tags ?? [],
        /* Unknown to the index means anonymous, since the index holds everyone
           who has identified themselves. */
        customerKnown: Boolean(customer && !customer.anonymous),
      };
    });

    res.status(200).json({
      success: true,
      total: rows.length,
      source,
      sourceError,
      agents: usedAgents,
      data: rows,
    });
  } catch (error) {
    next(error);
  }
};

/** Backs the sidebar badge without pulling every thread down. */
export const getUnreadCount = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const conversations = await store.getConversations();
    const withUnread = conversations.filter((c) => (c.unread || 0) > 0);
    res.status(200).json(
      ok({
        threads: withUnread.length,
        messages: withUnread.reduce((sum, c) => sum + (c.unread || 0), 0),
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not compute the unread count', log));
  }
};

/** Paginates and searches within one thread, newest window last. */
export const getConversationMessages = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { page, limit } = getPageParams(req);
    const conversation = await store.getConversationById(req.params.id);
    if (!conversation) throw new AppError('Conversation not found', 404);

    let messages = conversation.messages ?? [];
    if (req.query.search) {
      const needle = String(req.query.search).toLowerCase();
      messages = messages.filter((m: any) => String(m.text ?? '').toLowerCase().includes(needle));
    }

    const total = messages.length;
    const start = Math.max(0, total - page * limit);
    const end = Math.max(0, total - (page - 1) * limit);

    res.status(200).json(paginated(messages.slice(start, end), total, page, limit));
  } catch (error) {
    next(toAppError(error, `Could not load messages for ${req.params.id}`, log));
  }
};

export const getConversationById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    let conversation: Conversation | undefined;

    try {
      // Fetch live conversation details with full event transcript
      conversation = await fetchExternalConversationById(id);
      if (conversation) {
        // Cache/update in local MongoDB
        store.upsertConversations([conversation]).catch(() => {});
      }
    } catch (apiErr: any) {
      console.warn(`⚠️ External API fetch failed for ${id}, checking local DB:`, apiErr.message);
      conversation = await store.getConversationById(id);
    }

    if (!conversation) {
      throw new AppError('Conversation not found', 404);
    }

    /* Resolved per id here, not from the index: the thread being opened is one
       request, and this is the only way to get anything for the anonymous
       visitors the list endpoint omits. */
    /* The composer reads this to decide which channels it may offer. */
    if (conversation.workflowId) {
      const agent = (await store.getAgents()).find((a: any) => a.id === conversation!.workflowId);
      (conversation as any).agentName = agent?.name ?? '';
      (conversation as any).agentChannels = (agent as any)?.channels ?? [];
    }

    const customer = await fetchCustomerById(conversation.customerId ?? '');
    if (customer) {
      conversation = {
        ...conversation,
        name: displayName(customer, conversation.customerId),
        phone: customer.phone || conversation.phone,
        email: customer.email || conversation.email,
      };
      (conversation as any).customer = customer;
    }

    res.status(200).json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
};

export const getConversationEvents = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const events = await fetchExternalConversationEvents(id);

    res.status(200).json({
      success: true,
      total: events.length,
      data: events,
    });
  } catch (error) {
    next(error);
  }
};

export const createConversation = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, avatar, initials, channel, phone, email, initialMessage } = req.body;

    const channelLabelMap: Record<string, string> = {
      whatsapp: 'WhatsApp',
      sms: 'SMS',
      email: 'Email',
      voice: 'Voice Call',
      web: 'Web Chat',
    };

    const channelColorMap: Record<string, string> = {
      whatsapp: '#25D366',
      sms: '#f59e0b',
      email: '#0284c7',
      voice: '#9333ea',
      web: '#2563eb',
    };

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const firstMsg: Message = {
      id: `m_${Date.now()}`,
      sender: 'them',
      actor: 'user',
      text: initialMessage,
      time: timeStr,
      timestamp: now.toISOString(),
      channel,
    };

    const newConvo: Conversation = {
      id: `convo-${Date.now()}`,
      name,
      avatar: avatar || '',
      initials: initials || name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase(),
      channel,
      channels: [channel],
      channelLabel: channelLabelMap[channel] || 'Web Chat',
      channelColor: channelColorMap[channel] || '#2563eb',
      phone,
      email,
      unread: 1,
      timestamp: timeStr,
      lastMessage: initialMessage,
      messages: [firstMsg],
      createdAt: now.toISOString(),
    };

    const created = await store.createConversation(newConvo);

    res.status(201).json({
      success: true,
      message: 'Conversation started',
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

export const sendMessage = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { text, sender = 'me', channel, attachment } = req.body;

    let existing = await store.getConversationById(id);
    if (!existing) {
      try {
        existing = await fetchExternalConversationById(id);
      } catch {}
    }

    if (!existing) {
      throw new AppError('Conversation not found', 404);
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const newMessage: Message = {
      id: `m_${Date.now()}`,
      sender,
      actor: sender === 'me' ? 'ai' : sender === 'them' ? 'user' : 'system',
      text,
      time: timeStr,
      timestamp: now.toISOString(),
      channel: channel || existing.channel,
      attachment,
    };

    const updated = await store.addMessageToConversation(id, newMessage);

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const markAsRead = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updated = await store.markConversationAsRead(id);

    if (!updated) {
      throw new AppError('Conversation not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'Conversation marked as read',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};
