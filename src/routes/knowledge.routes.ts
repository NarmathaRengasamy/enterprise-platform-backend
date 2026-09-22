import { Router } from 'express';
import {
  getArticles,
  getArticleById,
  createArticle,
  updateArticle,
  deleteArticle,
  bulkDeleteArticles,
  recordArticleView,
  getKnowledgeStats,
  getCollections,
  createCollection,
  generateCatalogMarkdown,
  createArticleSchema,
  updateArticleSchema,
  createCollectionSchema,
  bulkDeleteArticlesSchema,
} from '../controllers/knowledge.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

router.get('/stats', getKnowledgeStats);

router.get('/articles', getArticles);
router.post(
  '/articles/bulk-delete',
  requireRoles('Admin', 'Editor'),
  validateRequest(bulkDeleteArticlesSchema),
  bulkDeleteArticles
);
router.get('/articles/:id', getArticleById);
router.post('/articles', requireRoles('Admin', 'Editor'), validateRequest(createArticleSchema), createArticle);
router.put('/articles/:id', requireRoles('Admin', 'Editor'), validateRequest(updateArticleSchema), updateArticle);
router.delete('/articles/:id', requireRoles('Admin', 'Editor'), deleteArticle);
router.post('/articles/:id/view', recordArticleView);

router.get('/collections', getCollections);
router.post('/collections', requireRoles('Admin', 'Editor'), validateRequest(createCollectionSchema), createCollection);

router.post('/sync', requireRoles('Admin', 'Editor'), generateCatalogMarkdown);

export default router;
