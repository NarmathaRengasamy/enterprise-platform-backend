import { Router } from 'express';
import {
  getTeamMembers,
  getTeamStats,
  addTeamMember,
  resendInvite,
  updateTeamMember,
  revokeTeamMember,
  addMemberSchema,
  updateMemberSchema,
} from '../controllers/team.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

router.get('/members', getTeamMembers);
router.get('/stats', getTeamStats);

/* Managing who can sign in is an Admin concern. */
router.post('/members', requireRoles('Admin'), validateRequest(addMemberSchema), addTeamMember);
router.post('/members/:id/invite', requireRoles('Admin'), resendInvite);
router.put('/members/:id', requireRoles('Admin'), validateRequest(updateMemberSchema), updateTeamMember);
router.delete('/members/:id', requireRoles('Admin'), revokeTeamMember);

export default router;
