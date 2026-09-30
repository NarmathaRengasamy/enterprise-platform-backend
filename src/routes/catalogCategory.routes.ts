import { Router } from 'express';
import {
  createCategory,
  createCategorySchema,
  deleteCategory,
  exportCategories,
  exportSchema,
  getCategory,
  listCategories,
  reorderCategories,
  reorderSchema,
  restoreCategory,
  updateCategory,
  updateCategorySchema,
} from '../controllers/catalogCategory.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

router.get('/', listCategories);
/* Before '/:id' so "export" and "reorder" are not read as ids. */
router.get('/export', requireRoles('Admin', 'Editor'), validateRequest(exportSchema), exportCategories);
router.post('/reorder', requireRoles('Admin', 'Editor'), validateRequest(reorderSchema), reorderCategories);
router.get('/:id', getCategory);
router.post('/', requireRoles('Admin', 'Editor'), validateRequest(createCategorySchema), createCategory);
router.patch('/:id', requireRoles('Admin', 'Editor'), validateRequest(updateCategorySchema), updateCategory);
/* Deleting and restoring are Admin-only, as for the rest of the product module. */
router.delete('/:id', requireRoles('Admin'), deleteCategory);
router.post('/:id/restore', requireRoles('Admin'), restoreCategory);

export default router;
