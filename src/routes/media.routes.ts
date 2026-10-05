import { Router } from 'express';
import { receiveFile, uploadMedia } from '../controllers/media.controller.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

/* Role check first: a Viewer's upload is refused before any bytes hit the disk. */
router.post('/', requireRoles('Admin', 'Editor'), receiveFile, uploadMedia);

export default router;
