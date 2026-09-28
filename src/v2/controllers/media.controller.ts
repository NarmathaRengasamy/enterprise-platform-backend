import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AppError } from '../../middlewares/errorHandler.js';
import { toAppError } from '../../utils/error.util.js';
import { createLogger } from '../../utils/logger.js';
import { ok } from '../../utils/response.util.js';
import { CatalogItemModel, CatalogProductModel } from '../models.js';
import { remove, store } from '../services/media.js';

const log = createLogger('V2MediaController');

/**
 * Uploads for product media.
 *
 * Buffered in memory rather than streamed to a temp file: the size ceiling is
 * already enforced here, and holding one file briefly is simpler than cleaning
 * up half-written temp files when a request is abandoned.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    /* The outer wall. `store()` applies the real per-kind limit and returns a
       message naming the actual size, which multer cannot do. */
    fileSize: Number(process.env.MAX_VIDEO_BYTES ?? 200 * 1024 * 1024),
    files: 10,
  },
});

/**
 * POST /v2/media  (multipart, field name `files`)
 *
 * Stores the files and returns asset records. It deliberately does **not**
 * attach them to anything: the product form collects, orders and picks a
 * thumbnail before saving, and an upload that failed to attach should leave a
 * loose file rather than a half-edited product.
 */
export const uploadMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new AppError('No files were uploaded', 400);

    const stored = [];
    for (const file of files) {
      stored.push(await store(file.buffer, file.mimetype, file.originalname));
    }

    log.log(`Uploaded ${stored.length} file(s)`);
    res.status(201).json(ok(stored, `${stored.length} file(s) uploaded`));
  } catch (error) {
    next(toAppError(error, 'Could not upload', log));
  }
};

/**
 * DELETE /v2/media/:filename
 *
 * Removes a file that is not referenced by anything. A file still attached to
 * a product is refused — deleting it would leave a broken image on the
 * storefront with nothing to explain it. Detach it from the product first, and
 * that save cleans the file up on its own.
 */
export const deleteMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { filename } = req.params;

    const [inProduct, inItem] = await Promise.all([
      CatalogProductModel.countDocuments({ 'media.filename': filename }),
      CatalogItemModel.countDocuments({ 'media.filename': filename }),
    ]);

    if (inProduct + inItem > 0) {
      throw new AppError(
        'That file is still attached to a product. Remove it there and it is deleted automatically.',
        409
      );
    }

    await remove(filename);
    res.json(ok({ filename }, 'File deleted'));
  } catch (error) {
    next(toAppError(error, 'Could not delete the file', log));
  }
};
