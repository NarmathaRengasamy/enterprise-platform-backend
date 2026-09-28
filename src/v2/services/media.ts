import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middlewares/errorHandler.js';
import { createLogger } from '../../utils/logger.js';
import type { MediaAsset, MediaConfig, ProductType } from '../types.js';

/**
 * Product media — uploads, ordering, and the thumbnail.
 *
 * Files live on the server's own disk and are served statically. That is the
 * simplest thing that works and needs no account anywhere, at the cost of two
 * things worth stating plainly: the folder must be a mounted volume or a
 * redeploy loses it, and it does not scale past one machine. Moving to object
 * storage later means changing `store()` and `remove()` and rewriting the
 * stored URLs — nothing else here knows where a file physically is.
 */

const log = createLogger('V2Media');

/* Outside `src`, so a rebuild never touches it and it can be a volume. */
export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads', 'products');
export const PUBLIC_PREFIX = '/uploads/products';

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 10 * 1024 * 1024);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES ?? 200 * 1024 * 1024);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

export const ensureUploadDir = async (): Promise<void> => {
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
};

/* ---------------------------------------------------------------- store */

export interface StoredFile {
  id: string;
  kind: 'image' | 'video';
  url: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
}

/**
 * Writes one uploaded buffer to disk.
 *
 * The extension comes from the declared content type, never from the client's
 * filename — an uploaded `photo.jpg.exe` must not end up on disk with a name
 * anything will execute, and the stored name is a uuid regardless.
 */
export const store = async (
  buffer: Buffer,
  contentType: string,
  originalName?: string
): Promise<StoredFile> => {
  const isImage = IMAGE_TYPES.has(contentType);
  const isVideo = VIDEO_TYPES.has(contentType);

  if (!isImage && !isVideo) {
    throw new AppError(
      `'${contentType}' is not an accepted file type. Images: JPEG, PNG, WebP, GIF, AVIF. ` +
        `Videos: MP4, WebM, MOV.`,
      422
    );
  }

  const limit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (buffer.length > limit) {
    const mb = (n: number) => Math.round(n / (1024 * 1024));
    throw new AppError(
      `That ${isImage ? 'image' : 'video'} is ${mb(buffer.length)} MB. The limit is ${mb(limit)} MB.`,
      422
    );
  }

  await ensureUploadDir();

  const id = randomUUID();
  const filename = id + (EXTENSIONS[contentType] ?? '');
  await fs.writeFile(path.join(UPLOAD_ROOT, filename), buffer);

  log.log(`Stored ${filename} (${buffer.length} bytes)${originalName ? ` from ${originalName}` : ''}`);

  return {
    id,
    kind: isImage ? 'image' : 'video',
    url: `${PUBLIC_PREFIX}/${filename}`,
    filename,
    sizeBytes: buffer.length,
    contentType,
  };
};

/**
 * Deletes a stored file.
 *
 * A missing file is not an error: the record is what matters, and a file that
 * has already gone leaves nothing to clean up.
 */
export const remove = async (filename?: string): Promise<void> => {
  if (!filename) return;

  /* Never let a stored name escape the upload folder. */
  const safe = path.basename(filename);
  try {
    await fs.unlink(path.join(UPLOAD_ROOT, safe));
    log.debug(`Removed ${safe}`);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') log.warn(`Could not remove ${safe}: ${error?.message}`);
  }
};

/* ------------------------------------------------------------ normalise */

const LINK_PATTERN =
  /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|player\.vimeo\.com\/video\/|vimeo\.com\/)/i;

/**
 * Cleans an incoming media list.
 *
 * Does four things the client cannot be trusted to get right: renumbers `sort`
 * from the given order, guarantees **exactly one** thumbnail among the images,
 * refuses a video marked as one, and validates any pasted link.
 */
export const normaliseMedia = (raw: MediaAsset[] | undefined): MediaAsset[] => {
  const list = [...(raw ?? [])];

  /* The client's order is the intent; `sort` is just how it is recorded. */
  list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  const out = list.map((asset, index) => {
    if (asset.source === 'link') {
      if (!LINK_PATTERN.test(asset.url)) {
        throw new AppError(
          'A video link must be a YouTube or Vimeo URL. Upload the file instead if it is hosted elsewhere.',
          422
        );
      }
      if (asset.kind !== 'video') {
        throw new AppError('Only videos can be added as a link', 422);
      }
    }

    if (asset.kind === 'video' && asset.isThumbnail) {
      throw new AppError('A video cannot be the thumbnail', 422);
    }

    return {
      ...asset,
      id: asset.id || randomUUID(),
      sort: index,
      isThumbnail: asset.kind === 'image' ? Boolean(asset.isThumbnail) : false,
    };
  });

  const images = out.filter((a) => a.kind === 'image');
  const flagged = images.filter((a) => a.isThumbnail);

  /* Exactly one, always. Several would make the cover ambiguous; none would
     leave a product with pictures and no card image. */
  if (flagged.length !== 1 && images.length > 0) {
    const chosen = flagged[0] ?? images[0];
    for (const a of out) a.isThumbnail = a.kind === 'image' && a.id === chosen.id;
  }

  return out;
};

/** The thumbnail URL, for the derived `image` field. */
export const thumbnailUrl = (media: MediaAsset[] | undefined): string | undefined =>
  media?.find((a) => a.kind === 'image' && a.isThumbnail)?.url;

/* ------------------------------------------------------------ validate */

const EMPTY: MediaConfig = { images: { enabled: false }, videos: { enabled: false } };

export const mediaConfigOf = (type: ProductType): MediaConfig => type.media ?? EMPTY;

/**
 * Checks a media list against what the type allows.
 *
 * Refusing a disabled kind matters as much as requiring an enabled one: a
 * product that quietly kept images after its type turned them off would show
 * them on the storefront with nothing in the admin to explain why.
 */
export const assertMediaAllowed = (type: ProductType, media: MediaAsset[] | undefined): void => {
  const config = mediaConfigOf(type);
  const list = media ?? [];

  const images = list.filter((a) => a.kind === 'image');
  const videos = list.filter((a) => a.kind === 'video');

  if (images.length && !config.images.enabled) {
    throw new AppError(`'${type.name}' does not use images. Enable them under Catalog Setup.`, 422);
  }
  if (videos.length && !config.videos.enabled) {
    throw new AppError(`'${type.name}' does not use videos. Enable them under Catalog Setup.`, 422);
  }
  if (config.images.enabled && config.images.required && !images.length) {
    throw new AppError(`'${type.name}' requires at least one image`, 422);
  }
};

/** Files no longer referenced after an update, so they can be deleted. */
export const orphanedFiles = (before: MediaAsset[] | undefined, after: MediaAsset[]): string[] => {
  const kept = new Set(after.map((a) => a.id));
  return (before ?? [])
    .filter((a) => a.source === 'upload' && a.filename && !kept.has(a.id))
    .map((a) => a.filename as string);
};
