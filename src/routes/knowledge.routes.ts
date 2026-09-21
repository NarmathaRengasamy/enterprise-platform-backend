import { Router } from 'express';
import {
  getArticles,
  getArticleById,
  createArticle,
  updateArticle,
  deleteArticle,
  getCollections,
  createCollection,
  generateCatalogMarkdown,
  createArticleSchema,
  updateArticleSchema,
  createCollectionSchema,
} from '../controllers/knowledge.controller.js';
import { validateRequest } from '../middlewares/validate.js';

const router = Router();

router.get('/articles', getArticles);
router.get('/articles/:id', getArticleById);
router.post('/articles', validateRequest(createArticleSchema), createArticle);
router.put('/articles/:id', validateRequest(updateArticleSchema), updateArticle);
router.delete('/articles/:id', deleteArticle);

router.get('/collections', getCollections);
router.post('/collections', validateRequest(createCollectionSchema), createCollection);

router.post('/sync', generateCatalogMarkdown);

export default router;
