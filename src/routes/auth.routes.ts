import { Router } from 'express';
import { login, register, getCurrentUser, loginSchema, registerSchema } from '../controllers/auth.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { authenticateJWT } from '../middlewares/auth.js';

const router = Router();

router.post('/login', validateRequest(loginSchema), login);
router.post('/register', validateRequest(registerSchema), register);
router.get('/me', authenticateJWT, getCurrentUser);

export default router;
