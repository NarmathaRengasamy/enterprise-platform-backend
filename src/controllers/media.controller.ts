import fs from 'node:fs';
import path from 'node:path';
import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { AppError } from '../middlewares/errorHandler.js';
import { newId } from '../utils/id.util.js';
import { ok } from '../utils/response.util.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Media');

/**
 * File upload for product images and videos (design §9.3 `POST /media`).
 *
 * The product form used to keep `blob:` URLs from `URL.createObjectURL` and save
 * them as if they were real — they only ever existed in that one browser tab, so
 * every image broke on reload. Files now land on the server and the response is
 * a URL that keeps working.
 */

export const UPLOADS_ROOT = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
/** Public URL prefix the uploads directory is served under (see app.ts). */
export const UPLOADS_URL_PREFIX = '/uploads';

const MB = 1024 * 1024;

const ALLOWED: Record<string, { kind: 'image' | 'video'; ext: string; maxBytes: number }> = {
  'image/png': { kind: 'image', ext: '.png', maxBytes: 10 * MB },
  'image/jpeg': { kind: 'image', ext: '.jpg', maxBytes: 10 * MB },
  'image/webp': { kind: 'image', ext: '.webp', maxBytes: 10 * MB },
  'video/mp4': { kind: 'video', ext: '.mp4', maxBytes: 60 * MB },
  'video/quicktime': { kind: 'video', ext: '.mov', maxBytes: 60 * MB },
};

const LARGEST_ALLOWED = Math.max(...Object.values(ALLOWED).map((a) => a.maxBytes));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    /* One folder per month keeps any single directory from growing without bound. */
    const now = new Date();
    const dir = path.join(
      UPLOADS_ROOT,
      'media',
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0')
    );
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  /* The stored name never comes from the client: a user-supplied name could
     carry `../` or overwrite another file. */
  filename: (_req, file, cb) => cb(null, `${newId()}${ALLOWED[file.mimetype]?.ext ?? ''}`),
});

const upload = multer({
  storage,
  limits: { fileSize: LARGEST_ALLOWED, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED[file.mimetype]) {
      return cb(
        new AppError(
          'Unsupported file type. Allowed: PNG, JPEG, WEBP images; MP4, MOV videos',
          422,
          undefined,
          { file: `"${file.mimetype}" is not an allowed type` }
        )
      );
    }
    cb(null, true);
  },
}).single('file');

/** multer as middleware, with its errors translated into the API's error shape. */
export const receiveFile = (req: Request, res: Response, next: NextFunction): void => {
  upload(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof AppError) return next(err);
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError('File is too large (images up to 10 MB, videos up to 60 MB)', 422));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return next(new AppError('Send exactly one file in the "file" field', 400));
      }
      return next(new AppError(err.message, 400));
    }
    return next(err);
  });
};

export const uploadMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = req.file;
    if (!file) throw new AppError('No file received — send it as multipart field "file"', 400);

    const rule = ALLOWED[file.mimetype];
    /* multer's limit is the largest allowed size overall; an image also has to
       fit its own, smaller limit. */
    if (file.size > rule.maxBytes) {
      await fs.promises.unlink(file.path).catch(() => undefined);
      throw new AppError(
        `${rule.kind === 'image' ? 'Images' : 'Videos'} can be at most ${rule.maxBytes / MB} MB`,
        422
      );
    }

    const relative = path.relative(UPLOADS_ROOT, file.path).split(path.sep).join('/');
    const url = `${UPLOADS_URL_PREFIX}/${relative}`;
    log.debug(`Stored ${rule.kind} ${url} (${file.size} bytes)`);

    res.status(201).json(
      ok(
        { url, kind: rule.kind, size_bytes: file.size, mime_type: file.mimetype },
        'File uploaded'
      )
    );
  } catch (error) {
    next(error);
  }
};
