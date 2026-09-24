import { Router } from 'express';
import {
  getEndpoints,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  pingEndpoint,
  createEndpointSchema,
  updateEndpointSchema,
} from '../controllers/developer.controller.js';
import {
  getPlatformConnection,
  savePlatformConnection,
  testPlatformConnection,
  disconnectPlatform,
  requirePlatformConnection,
  savePlatformConnectionSchema,
  saveOperatorSite,
  saveOperatorSiteSchema,
} from '../controllers/platform.controller.js';
import {
  listAgents as listCachedAgents,
  getAgentById as getCachedAgentById,
  setAgentStatus,
  setAgentStatusSchema,
} from '../controllers/perfox.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

/* The whole developer hub is Admin-only: it exposes credentials and lets a user
   register a URL that the server will then call. */
router.use(requireRoles('Admin'));

/* Platform connection — deliberately NOT behind requirePlatformConnection:
   these are the routes a developer uses to create the connection in the first
   place, so gating them would lock the Developer Hub out of itself. */
router.get('/platform', getPlatformConnection);
router.put('/platform', validateRequest(savePlatformConnectionSchema), savePlatformConnection);
router.post('/platform/test', testPlatformConnection);
router.delete('/platform', disconnectPlatform);

/* The operator site: the Perfox Site a human operator signs in against. Saved
   here because it is a credential; the signing route itself is mounted outside
   this Admin-only hub, since operators are not administrators. */
router.put(
  '/platform/operator',
  validateRequest(saveOperatorSiteSchema),
  saveOperatorSite
);

/* Everything below needs a Perfox workspace to mean anything. */
router.use(['/agents', '/endpoints'], requirePlatformConnection);


/* Agents mirror the Perfox workspace and are read-only here: they are created
   and edited in Perfox, so this service exposes reads plus the publish/pause
   toggle, which it forwards upstream. Reads come from our cache; Perfox is
   called only on the first load or when ?refresh=true is asked for. */
router.get('/agents', listCachedAgents);
router.get('/agents/:id', getCachedAgentById);
/* Publishes or pauses the agent in Perfox, then re-syncs the cached row. */
router.patch('/agents/:id/status', validateRequest(setAgentStatusSchema), setAgentStatus);

// Endpoints
router.get('/endpoints', getEndpoints);
router.get('/endpoints/:id', getEndpointById);
router.post('/endpoints', validateRequest(createEndpointSchema), createEndpoint);
router.put('/endpoints/:id', validateRequest(updateEndpointSchema), updateEndpoint);
router.delete('/endpoints/:id', deleteEndpoint);
router.post('/endpoints/:id/ping', pingEndpoint);

export default router;
