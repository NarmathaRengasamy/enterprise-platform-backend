import { Router } from 'express';
import {
  addItem,
  addItemSchema,
  archiveProduct,
  createProduct,
  createProductSchema,
  deleteItem,
  deleteProduct,
  getProduct,
  exportProducts,
  productStats,
  publishProduct,
  restoreItem,
  restoreProduct,
  searchProducts,
  searchSchema,
  updateItem,
  updateItemSchema,
  updateProduct,
  updateProductSchema,
  variantPreview,
  variantPreviewSchema,
} from '../controllers/productV2.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

/** Mounted at /api/v2/products (beside /api/v1/products until the Phase 5 cut-over). */
const router = Router();

const writers = requireRoles('Admin', 'Editor');
const admins = requireRoles('Admin');

/* Before '/:id' so "search", "stats" and "variant-preview" are never read as ids. */
router.post('/search', validateRequest(searchSchema), searchProducts);
router.get('/stats', productStats);
router.post('/export', writers, validateRequest(searchSchema), exportProducts);
router.post('/variant-preview', writers, validateRequest(variantPreviewSchema), variantPreview);

router.post('/', writers, validateRequest(createProductSchema), createProduct);
router.get('/:id', getProduct);
router.patch('/:id', writers, validateRequest(updateProductSchema), updateProduct);
router.post('/:id/publish', writers, publishProduct);
router.post('/:id/archive', writers, archiveProduct);
router.delete('/:id', admins, deleteProduct);
router.post('/:id/restore', admins, restoreProduct);

router.post('/:id/items', writers, validateRequest(addItemSchema), addItem);
router.patch('/:id/items/:item_id', writers, validateRequest(updateItemSchema), updateItem);
router.delete('/:id/items/:item_id', admins, deleteItem);
router.post('/:id/items/:item_id/restore', admins, restoreItem);

export default router;
