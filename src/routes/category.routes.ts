import { Router } from 'express';
import {
  getCategories,
  getCategoryById,
  getCategoryStats,
  createCategory,
  updateCategory,
  deleteCategory,
  bulkDeleteCategories,
  exportCategories,
  createCategorySchema,
  updateCategorySchema,
  bulkDeleteSchema,
} from '../controllers/category.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

router.get('/stats', getCategoryStats);
router.get('/export', exportCategories);
router.post('/bulk-delete', requireRoles('Admin'), validateRequest(bulkDeleteSchema), bulkDeleteCategories);

router.get('/', getCategories);
router.get('/:id', getCategoryById);

router.post('/', requireRoles('Admin', 'Editor'), validateRequest(createCategorySchema), createCategory);
router.put('/:id', requireRoles('Admin', 'Editor'), validateRequest(updateCategorySchema), updateCategory);
router.delete('/:id', requireRoles('Admin'), deleteCategory);

export default router;
