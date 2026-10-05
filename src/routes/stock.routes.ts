import { Router } from 'express';
import {
  addUnits,
  addUnitsSchema,
  adjustSchema,
  adjustStock,
  deleteUnit,
  getBundle,
  getStock,
  listMovements,
  listUnits,
  listUnitsSchema,
  movementsSchema,
  reorderPointSchema,
  replaceBundle,
  bundleSchema,
  setReorderPoint,
  updateUnit,
  updateUnitSchema,
} from '../controllers/stock.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

/** Mounted at /api/v2 (Phase 4): stock, serial / batch units and bundle components of items. */
const router = Router();

const writers = requireRoles('Admin', 'Editor');

router.get('/items/:id/stock', getStock);
router.post('/items/:id/stock/adjust', writers, validateRequest(adjustSchema), adjustStock);
router.patch('/items/:id/stock/reorder-point', writers, validateRequest(reorderPointSchema), setReorderPoint);
router.get('/items/:id/stock/movements', writers, validateRequest(movementsSchema), listMovements);

router.get('/items/:id/units', writers, validateRequest(listUnitsSchema), listUnits);
router.post('/items/:id/units', writers, validateRequest(addUnitsSchema), addUnits);
router.patch('/units/:id', writers, validateRequest(updateUnitSchema), updateUnit);
router.delete('/units/:id', writers, deleteUnit);

router.get('/items/:id/bundle-components', writers, getBundle);
router.put('/items/:id/bundle-components', writers, validateRequest(bundleSchema), replaceBundle);

export default router;
