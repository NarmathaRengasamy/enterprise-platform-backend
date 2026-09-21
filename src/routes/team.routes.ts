import { Router } from 'express';
import {
  getTeamMembers,
  addTeamMember,
  updateTeamMember,
  revokeTeamMember,
  addMemberSchema,
  updateMemberSchema,
} from '../controllers/team.controller.js';
import { validateRequest } from '../middlewares/validate.js';

const router = Router();

router.get('/members', getTeamMembers);
router.post('/members', validateRequest(addMemberSchema), addTeamMember);
router.put('/members/:id', validateRequest(updateMemberSchema), updateTeamMember);
router.delete('/members/:id', revokeTeamMember);

export default router;
