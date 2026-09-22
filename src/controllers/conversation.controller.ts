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
    const { channel, search } = req.query;

    let conversations: Conversation[] = [];

    try {
      // 1. Fetch live conversations from the real Perfox API
      conversations = await fetchExternalConversations();
      // Sync to local store/MongoDB in background
      store.upsertConversations(conversations).catch((err) => {
        console.warn('⚠️ [MongoDB Sync Warning]:', err.message);
      });
    } catch (apiErr: any) {
      console.warn('⚠️ External Perfox API unavailable, using local MongoDB fallback:', apiErr.message);
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

    res.status(200).json({
      success: true,
      total: conversations.length,
      data: conversations,
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
