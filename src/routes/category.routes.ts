import { Router } from 'express';
import {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  exportCategories,
  createCategorySchema,
  updateCategorySchema,
} from '../controllers/category.controller.js';
import { validateRequest } from '../middlewares/validate.js';

const router = Router();

router.get('/export', exportCategories);
router.get('/', getCategories);
router.get('/:id', getCategoryById);
router.post('/', validateRequest(createCategorySchema), createCategory);
router.put('/:id', validateRequest(updateCategorySchema), updateCategory);
router.delete('/:id', deleteCategory);

export default router;
