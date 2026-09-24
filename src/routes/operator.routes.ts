import { Router } from 'express';
import { signOperator } from '../controllers/platform.controller.js';

const router = Router();

/*
 * Deliberately NOT under /developer, which is Admin-only.
 *
 * Configuring the site is an administrative act; taking a call is not. An
 * operator is whoever is signed in, so this route needs authentication — which
 * the API router already applies — and no role beyond it.
 *
 * It is also not behind requirePlatformConnection: the operator site is its own
 * credential, and the handler reports its absence with a 409 that names it.
 */
router.post('/sign', signOperator);

export default router;
