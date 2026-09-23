import { Router } from 'express';
import {
  getConversations,
  getConversationById,
  getConversationEvents,
  getUnreadCount,
  getConversationMessages,
  createConversation,
  sendMessage,
  markAsRead,
  sendOutbound,
  sendOutboundSchema,
  createConversationSchema,
  sendMessageSchema,
} from '../controllers/conversation.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

router.get('/', getConversations);
router.get('/unread-count', getUnreadCount);
router.get('/:id', getConversationById);
router.get('/:id/events', getConversationEvents);
router.get('/:id/messages', getConversationMessages);
router.post('/', validateRequest(createConversationSchema), createConversation);
router.post('/:id/messages', validateRequest(sendMessageSchema), sendMessage);
/* Sends through Perfox. Separate from POST /:id/messages, which only records a
   message locally — this one actually reaches the customer. */
router.post(
  '/:id/send',
  requireRoles('Admin', 'Editor'),
  validateRequest(sendOutboundSchema),
  sendOutbound
);

router.patch('/:id/read', markAsRead);

export default router;
