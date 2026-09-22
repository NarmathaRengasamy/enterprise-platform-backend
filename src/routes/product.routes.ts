import { Router } from 'express';
import {
  getProducts,
  getProductById,
  getProductStats,
  exportProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  createProductSchema,
  updateProductSchema,
} from '../controllers/product.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

/* Declared before '/:id' so "stats" and "export" are not swallowed as ids. */
router.get('/stats', getProductStats);
router.get('/export', exportProducts);

router.get('/', getProducts);
router.get('/:id', getProductById);

router.post('/', requireRoles('Admin', 'Editor'), validateRequest(createProductSchema), createProduct);
router.put('/:id', requireRoles('Admin', 'Editor'), validateRequest(updateProductSchema), updateProduct);
router.patch('/:id', requireRoles('Admin', 'Editor'), validateRequest(updateProductSchema), updateProduct);
router.delete('/:id', requireRoles('Admin'), deleteProduct);

export default router;
