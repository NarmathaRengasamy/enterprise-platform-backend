import { Router } from 'express';
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  createProductSchema,
  updateProductSchema,
} from '../controllers/product.controller.js';
import { validateRequest } from '../middlewares/validate.js';

const router = Router();

router.get('/', getProducts);
router.get('/:id', getProductById);
router.post('/', validateRequest(createProductSchema), createProduct);
router.put('/:id', validateRequest(updateProductSchema), updateProduct);
router.delete('/:id', deleteProduct);

export default router;
