import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { tenantSettingsService } from '../services/tenantSettings.service.js';
import { DEFAULT_LABELS, MODULE_KEYS, isModuleKey } from '../config/modules.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { AppError } from '../middlewares/errorHandler.js';
import { ok } from '../utils/response.util.js';

const log = createLogger('SettingsController');

/* An inline image, capped. Images are stored as data URLs rather than uploaded
   files because there is no upload endpoint on this service and a logo is
   small — but "small" has to be enforced, or a 6 MB PNG ends up embedded in
   every settings read. 512 KB comfortably holds a sensible logo. */
const MAX_IMAGE_BYTES = 512 * 1024;

const imageField = z
  .string()
  .max(Math.ceil(MAX_IMAGE_BYTES * 1.4))
  .refine(
    (value) => value === '' || /^data:image\/(png|jpeg|webp|svg\+xml|x-icon);base64,/.test(value) || /^https?:\/\//.test(value),
    'Must be a PNG, JPEG, WebP, SVG or ICO image, or a URL'
  );

export const updateSettingsSchema = z.object({
  body: z.object({
    siteName: z.string().trim().min(1, 'Website name is required').max(60).optional(),
    legalName: z.string().trim().max(120).optional(),
    tagline: z.string().trim().max(60).optional(),
    logoUrl: imageField.optional(),
    faviconUrl: imageField.optional(),
    businessType: z.string().trim().max(60).optional(),

    /* Only the known module keys, so a typo cannot quietly create a label
       nothing will ever read. Both words are required together: a section
       named "Interactions" whose buttons still say "New conversation" is
       worse than not renaming it at all. */
    labels: z
      .record(
        z.string(),
        z.object({
          plural: z.string().trim().min(1, 'A name is required').max(40),
          singular: z.string().trim().min(1, 'A name is required').max(40),
        })
      )
      .refine(
        (value) => Object.keys(value).every(isModuleKey),
        `Unknown module. Valid keys: ${MODULE_KEYS.join(', ')}`
      )
      .optional(),
  }),
});

/**
 * The wire shape: the stored document with every module's label filled in.
 *
 * Merging on read rather than on write is what lets the shipped wording be
 * corrected in a release without rewriting every workspace that never changed
 * it — and keeps "not customised" distinguishable from "customised to the
 * same words".
 */
const serialise = (doc: any) => {
  /* `toJSON()` first, always.
     A Map of subdocuments cannot be spread: a Mongoose subdocument keeps its
     fields on an internal `_doc`, so `{ ...subdoc }` copies machinery like
     `$__parent` and none of the values. Serialising the whole document once
     turns the Map into a plain object of plain objects, which is the only
     shape safe to merge defaults into. */
  const json = doc.toJSON();
  const stored: Record<string, { plural?: string; singular?: string }> = json.labels ?? {};

  /* The settings now live in `tenant_settings` alongside the business settings.
     Only the site-settings fields are returned here — the same shape as before
     the move — so the Settings page and its callers see no change. */
  return {
    id: json.id,
    siteName: json.siteName,
    legalName: json.legalName,
    tagline: json.tagline,
    logoUrl: json.logoUrl,
    faviconUrl: json.faviconUrl,
    businessType: json.businessType,
    labels: Object.fromEntries(
      MODULE_KEYS.map((key) => [key, { ...DEFAULT_LABELS[key], ...(stored[key] ?? {}) }])
    ),
    updatedBy: json.updatedBy,
    ...(json.updated_at ? { updatedAt: json.updated_at } : {}),
  };
};

/**
 * GET /settings/site
 *
 * Always answers, even on a workspace that has never saved anything: a missing
 * document means "defaults", not "error". The sidebar reads this on every
 * load, so a 404 here would blank the branding on a fresh install.
 */
export const getSiteSettings = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    /* These change under the reader's feet whenever an Admin saves, and every
       screen reads them, so a stored copy is wrong rather than merely stale.
       (ETags are off app-wide — see `createApp` — which is what stops the
       conditional 304 this endpoint used to return.) */
    res.set('Cache-Control', 'no-store');

    /* An unsaved default document when nothing is stored: reading settings
       should not write to the database, and the schema defaults are the answer. */
    res.json(ok(serialise(await tenantSettingsService.get())));
  } catch (error) {
    next(toAppError(error, 'Could not read the site settings', log));
  }
};

/**
 * GET /public/settings — unauthenticated.
 *
 * The sign-in screen has to show the workspace's own name and logo, and it
 * has no token to ask with. That is not a leak: a login page is meant to be
 * branded, and nothing here is private.
 *
 * What it deliberately does NOT publish is everything a stranger has no
 * business reading — the registered legal name, the business category, and
 * the email of whoever last saved. Those stay behind the authenticated read.
 * This is an allow-list rather than a delete-list on purpose: a field added
 * later is private until someone decides otherwise.
 */
export const getPublicSiteSettings = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    res.set('Cache-Control', 'no-store');

    const full = serialise(await tenantSettingsService.get());

    res.json(
      ok({
        siteName: full.siteName,
        tagline: full.tagline,
        logoUrl: full.logoUrl,
        faviconUrl: full.faviconUrl,
        labels: full.labels,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not read the site settings', log));
  }
};

/**
 * PUT /settings/site  (Admin)
 *
 * An upsert onto the single fixed id, patching only the keys that were sent —
 * so a form that edits one tab cannot blank the fields belonging to another.
 */
export const updateSiteSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const patch = Object.fromEntries(
      Object.entries(req.body).filter(([, value]) => value !== undefined)
    );

    for (const key of ['logoUrl', 'faviconUrl'] as const) {
      const value = patch[key];
      if (typeof value === 'string' && value.startsWith('data:') && value.length > MAX_IMAGE_BYTES * 1.4) {
        throw new AppError(
          `That ${key === 'logoUrl' ? 'logo' : 'favicon'} is too large. The limit is ${Math.round(
            MAX_IMAGE_BYTES / 1024
          )} KB.`,
          422
        );
      }
    }

    /**
     * `labels` merges per module; it does not replace the map.
     *
     * `$set: { labels }` overwrites the whole thing, so a request naming one
     * module silently wiped the other eight. The admin form happens to send
     * every key every time, which is why it never showed there — but it made
     * the obvious API call ("rename just this one") destructive, and it did
     * exactly that to a live workspace.
     *
     * A label put back to its default is removed rather than written, so
     * "reset" does not leave a row saying "Conversations means
     * Conversations" pinning the workspace to today's wording forever.
     */
    const { labels, ...rest } = patch as Record<string, unknown> & {
      labels?: Record<string, { plural: string; singular: string }>;
    };

    const update: Record<string, unknown> = {
      ...rest,
      updatedBy: (req as any).user?.email ?? '',
    };
    const unset: Record<string, ''> = {};

    if (labels && typeof labels === 'object') {
      for (const [key, label] of Object.entries(labels)) {
        if (!isModuleKey(key)) continue;
        const isDefault =
          label.plural === DEFAULT_LABELS[key].plural &&
          label.singular === DEFAULT_LABELS[key].singular;
        if (isDefault) unset[`labels.${key}`] = '';
        else update[`labels.${key}`] = label;
      }
    }

    const updated = await tenantSettingsService.update(update, unset);

    log.log(`Site settings updated (${Object.keys(patch).join(', ') || 'no changes'})`);
    res.json(ok(serialise(updated), 'Settings saved'));
  } catch (error) {
    next(toAppError(error, 'Could not save the site settings', log));
  }
};
