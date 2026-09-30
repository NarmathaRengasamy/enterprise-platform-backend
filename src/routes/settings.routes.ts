import { Router } from 'express';
import {
  getSiteSettings,
  updateSiteSettings,
  updateSettingsSchema,
} from '../controllers/settings.controller.js';
import {
  getBusinessSettings,
  updateBusinessSettings,
  updateBusinessSchema,
} from '../controllers/business.controller.js';
import { validateRequest } from '../middlewares/validate.js';
import { requireRoles } from '../middlewares/auth.js';

const router = Router();

/* Readable by anyone signed in — the sidebar and the browser tab need it on
   every page. Writable by Admins only: these are workspace-wide, and a
   non-admin changing the company name for everyone is not an edit, it is an
   incident. */
router.get('/site', getSiteSettings);
router.put('/site', requireRoles('Admin'), validateRequest(updateSettingsSchema), updateSiteSettings);

/* Business category, time zone, currency and languages — stored in the same
   tenant_settings document. Changing the category (re)loads the product type. */
router.get('/business', getBusinessSettings);
router.put('/business', requireRoles('Admin'), validateRequest(updateBusinessSchema), updateBusinessSettings);

export default router;
