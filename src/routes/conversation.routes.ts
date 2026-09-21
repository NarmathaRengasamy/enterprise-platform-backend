import { Router } from 'express';
import {
  getConversations,
  getConversationById,
  getConversationEvents,
  createConversation,
  sendMessage,
  markAsRead,
  createConversationSchema,
  sendMessageSchema,
} from '../controllers/conversation.controller.js';
import { validateRequest } from '../middlewares/validate.js';

const router = Router();

router.get('/', getConversations);
router.get('/:id', getConversationById);
router.get('/:id/events', getConversationEvents);
router.post('/', validateRequest(createConversationSchema), createConversation);
router.post('/:id/messages', validateRequest(sendMessageSchema), sendMessage);
router.patch('/:id/read', markAsRead);

export default router;
