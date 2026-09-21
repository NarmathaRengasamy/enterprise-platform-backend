import { Router } from 'express';
import { getDashboardMetrics, getDashboardOverview } from '../controllers/dashboard.controller.js';

const router = Router();

router.get('/metrics', getDashboardMetrics);
router.get('/overview', getDashboardOverview);

export default router;
