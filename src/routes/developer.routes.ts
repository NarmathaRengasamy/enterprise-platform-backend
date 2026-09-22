import { Router } from 'express';
import {
  getAgents,
  getAgentById,
  createAgent,
  updateAgent,
  updateAgentStatus,
  assignAgentEndpoints,
  rotateAgentKey,
  deleteAgent,
  getEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  pingEndpoint,
  createAgentSchema,
  updateAgentSchema,
  updateAgentStatusSchema,
  assignEndpointsSchema,
  createEndpointSchema,
  updateEndpointSchema,
} from '../controllers/developer.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

/* The whole developer hub is Admin-only: it exposes credentials and lets a user
   register a URL that the server will then call. */
router.use(requireRoles('Admin'));

// Agents
router.get('/agents', getAgents);
router.get('/agents/:id', getAgentById);
router.post('/agents', validateRequest(createAgentSchema), createAgent);
router.put('/agents/:id', validateRequest(updateAgentSchema), updateAgent);
router.patch('/agents/:id/status', validateRequest(updateAgentStatusSchema), updateAgentStatus);
router.patch('/agents/:id/endpoints', validateRequest(assignEndpointsSchema), assignAgentEndpoints);
router.post('/agents/:id/rotate-key', rotateAgentKey);
router.delete('/agents/:id', deleteAgent);

// Endpoints
router.get('/endpoints', getEndpoints);
router.get('/endpoints/:id', getEndpointById);
router.post('/endpoints', validateRequest(createEndpointSchema), createEndpoint);
router.put('/endpoints/:id', validateRequest(updateEndpointSchema), updateEndpoint);
router.delete('/endpoints/:id', deleteEndpoint);
router.post('/endpoints/:id/ping', pingEndpoint);

export default router;
