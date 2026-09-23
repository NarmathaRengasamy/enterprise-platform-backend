import { Router, raw } from 'express';
import {
  listFiles,
  uploadMarkdown,
  uploadMarkdownSchema,
  getKnowledgeStats,
  uploadFile,
  deleteFile,
  listFolders,
  createFolder,
  createFolderSchema,
  renameFolder,
  renameFolderSchema,
  deleteFolder,
  generateCatalog,
  generateCatalogSchema,
} from '../controllers/kb.controller.js';
import { requirePlatformConnection } from '../controllers/platform.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

/* The knowledge base is the Perfox workspace, not a local collection, so every
   route here needs the platform connection the Developer hub configures. */
router.use(requirePlatformConnection);

router.get('/stats', getKnowledgeStats);

/* Folders are chosen when a file is uploaded, not configured up front, so they
   belong to the knowledge base rather than to the developer hub. */
router.get('/folders', listFolders);
router.post('/folders', requireRoles('Admin', 'Editor'), validateRequest(createFolderSchema), createFolder);

/* Renaming touches only the display name; deleting is refused by Perfox while
   the folder still holds anything, and never cascades. */
router.patch(
  '/folders/:id',
  requireRoles('Admin', 'Editor'),
  validateRequest(renameFolderSchema),
  renameFolder
);
router.delete('/folders/:id', requireRoles('Admin', 'Editor'), deleteFolder);

router.get('/files', listFiles);
router.post(
  '/files',
  requireRoles('Admin', 'Editor'),
  validateRequest(uploadMarkdownSchema),
  uploadMarkdown
);

/* The file arrives as a raw byte stream, not multipart: the server rebuilds the
   multipart request for Perfox so the target folder is its decision, not the
   caller's. express.json() ignores this content type, so it reaches here intact. */
router.post(
  '/files/upload',
  requireRoles('Admin', 'Editor'),
  raw({ type: 'application/octet-stream', limit: '25mb' }),
  uploadFile
);

/* Compiles the catalogue server-side and uploads it as one document. */
router.post(
  '/catalog',
  requireRoles('Admin', 'Editor'),
  validateRequest(generateCatalogSchema),
  generateCatalog
);

router.delete('/files/:id', requireRoles('Admin', 'Editor'), deleteFile);

export default router;
