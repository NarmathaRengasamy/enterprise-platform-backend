import { Router } from 'express';
import {
  getEvents,
  getEventById,
  createEvent,
  updateEvent,
  updateEventStatus,
  deleteEvent,
  createEventSchema,
  updateEventSchema,
} from '../controllers/schedule.controller.js';
import { validateRequest } from '../middlewares/validate.js';

const router = Router();

router.get('/', getEvents);
router.get('/:id', getEventById);
router.post('/', validateRequest(createEventSchema), createEvent);
router.put('/:id', validateRequest(updateEventSchema), updateEvent);
router.patch('/:id/status', updateEventStatus);
router.delete('/:id', deleteEvent);

export default router;
