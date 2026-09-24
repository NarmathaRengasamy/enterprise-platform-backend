import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { perfoxFetch } from '../utils/perfox.util.js';
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
import { fetchAgentTriggerChannels } from '../services/perfoxAgent.service.js';
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
    /* What the agent can reach out on — the composer's real gate. */
    const agentSenders = new Map(agents.map((a: any) => [a.id, a.senderChannels ?? []]));
    const agentStatuses = new Map(agents.map((a: any) => [a.id, a.status ?? '']));

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
        agentSenderChannels: c.workflowId ? agentSenders.get(c.workflowId) ?? [] : [],
        agentStatus: c.workflowId ? agentStatuses.get(c.workflowId) ?? '' : '',
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
      /* The list rows carry this; the detail did not, so a page that only ever
         opened one thread had no agent to attribute a call to. */
      (conversation as any).agentId = conversation.workflowId;
      (conversation as any).agentName = agent?.name ?? '';
      (conversation as any).agentChannels = (agent as any)?.channels ?? [];
      (conversation as any).agentSenderChannels = (agent as any)?.senderChannels ?? [];
      (conversation as any).agentStatus = (agent as any)?.status ?? '';

      /* What the composer may offer. Read from the agent's own trigger nodes
         rather than the cached list, which does not report them all. Only on
         the detail route: doing it per row would be one Perfox call per
         conversation in the list. */
      (conversation as any).agentTriggerChannels = await fetchAgentTriggerChannels(
        conversation.workflowId
      );
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


/* Channels a message can go out on. `phone` is excluded deliberately: Perfox
   opens a NEW conversation for a call, so it is not a reply to this thread and
   belongs on its own action. */
const OUTBOUND_CHANNELS = ['whatsapp', 'sms', 'email'] as const;

export const sendOutboundSchema = z.object({
  body: z.object({
    channel: z.enum(OUTBOUND_CHANNELS, {
      errorMap: () => ({ message: `channel must be one of ${OUTBOUND_CHANNELS.join(', ')}` }),
    }),
    text: z.string().trim().min(1, 'A message is required'),
  }),
});

/**
 * POST /conversations/:id/send
 *
 * Sends a real message through Perfox, rather than writing one locally that
 * the customer never receives.
 *
 * The checks are made here, not only in the UI: the browser decides what to
 * offer, but what may actually be sent is not the browser's to decide.
 */
export const sendOutbound = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const channel = String(req.body.channel);
    const text = String(req.body.text).trim();

    const conversation = await store.getConversationById(id);
    if (!conversation) throw new AppError('Conversation not found', 404);

    const agentId = conversation.workflowId ?? '';
    if (!agentId) {
      throw new AppError('This conversation has no agent, so nothing can send on its behalf', 409);
    }

    const agent = (await store.getAgents()).find((a: any) => a.id === agentId);
    if (!agent) {
      throw new AppError('The agent that handled this conversation is no longer in the workspace', 409);
    }

    /* Perfox requires a PUBLISHED agent for outbound. Letting a draft through
       would fail upstream with a less useful message. */
    if (agent.status !== 'published') {
      throw new AppError(
        `${agent.name} is ${agent.status} — only a published agent can send`,
        409
      );
    }

    /* The same check the composer uses, so the UI and the server cannot
       disagree about what is allowed: the channel must be named by a trigger
       on the agent's graph. */
    const triggerChannels = await fetchAgentTriggerChannels(agentId);
    if (!triggerChannels.includes(channel)) {
      throw new AppError(
        `${agent.name} has no ${channel} trigger configured — it is triggered on ${
          triggerChannels.length ? triggerChannels.join(', ') : 'no channel'
        }`,
        409
      );
    }

    /* Where to send it. Perfox needs an address, and the customer record is the
       only place we hold one. */
    const customer = await fetchCustomerById(conversation.customerId ?? '');
    const to = channel === 'email' ? customer?.email : customer?.phone;
    if (!to) {
      throw new AppError(
        channel === 'email'
          ? 'No email address on this customer'
          : 'No phone number on this customer',
        409
      );
    }

    const result = await perfoxFetch<any>('/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        channel,
        to,
        opening_message: text,
        ...(conversation.customerId ? { customer_id: conversation.customerId } : {}),
      }),
    });

    const payload = result?.data ?? result ?? {};
    /* A 201 means Perfox accepted the request, not that it went out. The agent
       can only actually send if the matching sender is wired, which is what
       send_authorized reports — so it is passed through rather than swallowed. */
    const sendAuthorized = payload.send_authorized !== false;

    log.log(
      `Outbound ${channel} on ${id} via ${agent.name} -> ` +
        `conversation ${payload.conversation_id ?? '?'}, authorized=${sendAuthorized}`
    );

    return res.status(200).json(
      ok(
        {
          conversationId: payload.conversation_id ?? id,
          executionId: payload.execution_id ?? '',
          status: payload.status ?? '',
          channel: payload.channel ?? channel,
          sendAuthorized,
          to,
        },
        sendAuthorized
          ? `Sent via ${channel}`
          : `Perfox accepted the request but ${agent.name} is not authorized to send on ${channel}`
      )
    );
  } catch (error) {
    return next(toAppError(error, `Could not send on conversation ${req.params.id}`, log));
  }
};

/* Channels a conversation can be STARTED on. `web` is excluded: a web-chat
   conversation begins when a visitor opens the widget, not from here. */
const STARTABLE_CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', contact: 'phone' as const },
  { key: 'sms', label: 'SMS', contact: 'phone' as const },
  { key: 'email', label: 'Email', contact: 'email' as const },
  /* Perfox calls this `phone`; there is no separate `call` channel. */
  { key: 'phone', label: 'Phone call', contact: 'phone' as const },
];

/**
 * GET /conversations/outbound/options
 *
 * Fills the two dropdowns for starting a conversation: a channel, and the
 * agents that can be reached on it.
 *
 * Served entirely from the agent cache — `triggerChannels` is stored during the
 * sync, so this costs ZERO Perfox calls. Reading each agent's graph on demand
 * would be one request per agent, which is the fan-out that trips the rate
 * limit.
 *
 * Every channel is returned, including ones no agent triggers on, so the UI can
 * show them disabled rather than hiding what exists.
 */
export const outboundOptions = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const agents = (await store.getAgents()) as any[];

    const channels = STARTABLE_CHANNELS.map((channel) => {
      const matching = agents
        .filter((agent) =>
          (agent.triggerChannels ?? [])
            .map((c: string) => String(c).toLowerCase())
            .includes(channel.key)
        )
        /* Perfox refuses outbound from an agent that is not published, so the
           state travels with the row and the UI can disable rather than hide
           it — "why is my agent missing" is a worse question than "why is it
           greyed out". */
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          available: agent.status === 'published',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        key: channel.key,
        label: channel.label,
        /* What the recipient field must hold for this channel. */
        contact: channel.contact,
        available: matching.some((agent) => agent.available),
        agents: matching,
      };
    });

    log.debug(
      `Outbound options: ${channels.filter((c) => c.available).length} of ${channels.length} channel(s) usable`
    );
    return res.status(200).json(ok({ channels }));
  } catch (error) {
    return next(toAppError(error, 'Could not load the outbound options', log));
  }
};

export const startConversationSchema = z.object({
  body: z
    .object({
      agentId: z.string().trim().min(1, 'An agent is required'),
      channel: z.enum(['whatsapp', 'sms', 'email', 'phone'], {
        errorMap: () => ({ message: 'channel must be one of whatsapp, sms, email, phone' }),
      }),
      /* The destination. Trimmed first so '   ' cannot reach Perfox. */
      to: z.string().trim().min(1, 'A phone number or email address is required'),
      /* Optional upstream, and meaningless on a call: Perfox dials and the
         agent speaks, so there is no text to open with. Still required on the
         text channels, where a message with no message is nothing to send.
         2000 is Perfox's own limit. */
      message: z.string().trim().max(2000, 'An opening message cannot exceed 2000 characters').optional(),
      /* Links the new thread to a known customer when there is one. */
      customerId: z.string().trim().optional(),
    })
    .refine((body) => body.channel === 'phone' || Boolean(body.message?.trim()), {
      message: 'An opening message is required',
      path: ['message'],
    }),
});

/**
 * POST /conversations/outbound
 *
 * Starts a NEW conversation, as opposed to `POST /:id/send`, which replies on
 * an existing one. Wraps Perfox's `POST /outbound`.
 *
 * The same trigger rule the dropdown uses is enforced here, so a caller that
 * skips the UI cannot start a conversation on a channel the agent has no
 * trigger for.
 */
export const startConversation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = String(req.body.agentId);
    const channel = String(req.body.channel);
    const to = String(req.body.to).trim();
    const message = String(req.body.message ?? '').trim();
    const customerId = String(req.body.customerId ?? '').trim();

    const agent = (await store.getAgents()).find((a: any) => a.id === agentId);
    if (!agent) throw new AppError('That agent is not in this workspace', 404);

    if (agent.status !== 'published') {
      throw new AppError(
        `${agent.name} is ${agent.status} — only a published agent can start a conversation`,
        409
      );
    }

    const triggers = ((agent as any).triggerChannels ?? []).map((c: string) =>
      String(c).toLowerCase()
    );
    if (!triggers.includes(channel)) {
      throw new AppError(
        `${agent.name} has no ${channel} trigger configured — it is triggered on ${
          triggers.length ? triggers.join(', ') : 'no channel'
        }`,
        409
      );
    }

    /* An email channel needs an address and the rest need a number. Checked
       here so the mistake is named, rather than surfacing as a Perfox error. */
    const wantsEmail = channel === 'email';
    const looksLikeEmail = to.includes('@');
    if (wantsEmail && !looksLikeEmail) {
      throw new AppError('Email needs an email address as the recipient', 400);
    }
    if (!wantsEmail && looksLikeEmail) {
      throw new AppError(`${channel} needs a phone number as the recipient`, 400);
    }

    const result = await perfoxFetch<any>('/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        channel,
        to,
        /* Omitted rather than sent empty: the field is optional upstream and a
           call has nothing to open with. */
        ...(message ? { opening_message: message } : {}),
        ...(customerId ? { customer_id: customerId } : {}),
      }),
    });

    const payload = result?.data ?? result ?? {};
    /* A 201 means Perfox accepted it, not that it went out. `send_authorized`
       reports the Sender node, which only applies to the text channels — a call
       does not need one. */
    const sendAuthorized = channel === 'phone' || payload.send_authorized !== false;

    log.log(
      `Started ${channel} conversation via ${agent.name} to ${to} -> ` +
        `${payload.conversation_id ?? '?'}, authorized=${sendAuthorized}`
    );

    return res.status(201).json(
      ok(
        {
          conversationId: payload.conversation_id ?? '',
          executionId: payload.execution_id ?? '',
          status: payload.status ?? '',
          channel: payload.channel ?? channel,
          sendAuthorized,
          to,
        },
        sendAuthorized
          ? `Conversation started on ${channel}`
          : `Perfox accepted the request but ${agent.name} is not authorized to send on ${channel}`
      )
    );
  } catch (error) {
    return next(toAppError(error, 'Could not start the conversation', log));
  }
};
