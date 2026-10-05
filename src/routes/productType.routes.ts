import { Router } from 'express';
import {
  addField,
  addFieldSchema,
  addOptions,
  addOptionsSchema,
  deleteField,
  getProductType,
  reorderFields,
  reorderFieldsSchema,
  updateField,
  updateFieldSchema,
  upgradeTemplate,
} from '../controllers/business.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

/* Read by every screen that builds a product form; changed only by Admins —
   the attributes are the shape of the whole catalogue. */
router.get('/', getProductType);
router.post('/upgrade', requireRoles('Admin'), upgradeTemplate);
/* Before '/fields/:key' so "reorder" is not read as a key. */
router.post('/fields/reorder', requireRoles('Admin'), validateRequest(reorderFieldsSchema), reorderFields);
router.post('/fields', requireRoles('Admin'), validateRequest(addFieldSchema), addField);
router.patch('/fields/:key', requireRoles('Admin'), validateRequest(updateFieldSchema), updateField);
router.delete('/fields/:key', requireRoles('Admin'), deleteField);
/* The one change an Editor may make (R44): adding options to a choice list,
   from the product form. Add-only and audited. */
router.post(
  '/fields/:key/options',
  requireRoles('Admin', 'Editor'),
  validateRequest(addOptionsSchema),
  addOptions
);

export default router;
