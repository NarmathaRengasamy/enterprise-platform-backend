import { Router } from 'express';
import {
  getAgents,
  getAgentById,
  createAgent,
  updateAgent,
  deleteAgent,
  getEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  pingEndpoint,
  createAgentSchema,
  updateAgentSchema,
  createEndpointSchema,
  updateEndpointSchema,
} from '../controllers/developer.controller.js';
import { validateRequest } from '../middlewares/validate.js';

const router = Router();

// Agents
router.get('/agents', getAgents);
router.get('/agents/:id', getAgentById);
router.post('/agents', validateRequest(createAgentSchema), createAgent);
router.put('/agents/:id', validateRequest(updateAgentSchema), updateAgent);
router.delete('/agents/:id', deleteAgent);

// Endpoints
router.get('/endpoints', getEndpoints);
router.get('/endpoints/:id', getEndpointById);
router.post('/endpoints', validateRequest(createEndpointSchema), createEndpoint);
router.put('/endpoints/:id', validateRequest(updateEndpointSchema), updateEndpoint);
router.delete('/endpoints/:id', deleteEndpoint);
router.post('/endpoints/:id/ping', pingEndpoint);

export default router;
