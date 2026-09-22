import { Router } from 'express';
import {
  getEvents,
  getScheduleStats,
  getEventById,
  createEvent,
  updateEvent,
  updateEventStatus,
  deleteEvent,
  createEventSchema,
  updateEventSchema,
} from '../controllers/schedule.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

router.get('/stats', getScheduleStats);
router.get('/', getEvents);
router.get('/:id', getEventById);
router.post('/', requireRoles('Admin', 'Editor'), validateRequest(createEventSchema), createEvent);
router.put('/:id', requireRoles('Admin', 'Editor'), validateRequest(updateEventSchema), updateEvent);
router.patch('/:id/status', requireRoles('Admin', 'Editor'), updateEventStatus);
router.delete('/:id', requireRoles('Admin', 'Editor'), deleteEvent);

export default router;
