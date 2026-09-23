import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { ok } from '../utils/response.util.js';
import { perfoxFetch, UPLOAD_TIMEOUT_MS } from '../utils/perfox.util.js';
import { KbFileRefModel } from '../models/KbFileRef.model.js';
import { buildCatalogDocument } from '../services/catalogMarkdown.js';

const log = createLogger('KnowledgeBaseController');

/** A knowledge-base folder, reduced to what choosing one actually needs. */
interface KbFolder {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  /** How deep in the tree, 0 at the root. Drives indentation in a picker. */
  depth: number;
  /** Readable ancestry, e.g. 'Company Docs / Nested'. `path` is ids only. */
  displayPath: string;
  fileCount: number;
  /** Perfox's generated description of the folder's contents, when it has one. */
  summary: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Perfox answers in snake_case and carries a large `index` block — the full file
 * manifest, entity lists and hashes. Only the count and summary are useful for
 * picking a folder, so the rest is dropped at the boundary rather than pushed
 * to the browser.
 */
const toFolder = (raw: any): KbFolder => ({
  id: String(raw?.id ?? ''),
  name: String(raw?.name ?? 'Untitled folder'),
  parentId: raw?.parent_id ?? null,
  path: String(raw?.path ?? ''),
  /* Filled in by the tree walk, which is the only place ancestry is known. */
  depth: 0,
  displayPath: String(raw?.name ?? 'Untitled folder'),
  fileCount: Number(raw?.index?.file_count ?? 0),
  summary: String(raw?.index?.summary ?? ''),
  createdAt: String(raw?.created_at ?? ''),
  updatedAt: String(raw?.updated_at ?? ''),
});

const sortNewestFirst = (folders: KbFolder[]): KbFolder[] =>
  [...folders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

/** One level of the tree. `parentId` omitted is the root level, not everything. */
const fetchFolderLevel = async (parentId?: string): Promise<KbFolder[]> => {
  const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
  const payload = await perfoxFetch<{ data?: any[] }>(`/kb/folders${query}`);
  const raw = Array.isArray(payload?.data) ? payload.data : [];

  /* Newest first, matching the file list: a folder someone just made is the one
     they are looking for. Perfox returns them in its own order. */
  return sortNewestFirst(raw.map(toFolder));
};

/* A tree this deep is already unusable in a picker; the bound is here so a
   cycle or a pathological structure cannot spin forever. */
const MAX_FOLDER_DEPTH = 10;

/**
 * Every folder in the workspace, depth-first, parents before their children.
 *
 * `GET /kb/folders` with no parameters returns ONLY the root level — a nested
 * folder is invisible to it — so the tree is walked one level at a time through
 * `parent_id`. Each folder carries its `depth` and a readable `displayPath`, so
 * a picker can indent it without rebuilding the ancestry itself.
 *
 * Ids already seen are skipped: a parent cycle would otherwise recurse until
 * the request died.
 */
/*
 * The walked tree, cached briefly.
 *
 * Walking costs one request per folder that has children, and a single page
 * load asks for the tree three times over (the file list validates its folder,
 * the stats tile counts every folder, the picker lists them). Uncached that was
 * ~21 requests for one screen, which tripped Perfox's rate limit — it answers
 * 429 with `retry-after: 60` and publishes no quota headers, so staying well
 * under it is the only safe approach.
 *
 * 30s: long enough to collapse a page load into one walk, short enough that a
 * folder created in Perfox still shows up promptly. Every mutation here clears
 * it outright, so our own changes are never waited for.
 */
const TREE_TTL_MS = 30_000;
let treeCache: { folders: KbFolder[]; at: number } | null = null;

/* One page load fires three requests at once, all of which need the tree. A TTL
   alone does not help there — they all miss together and each starts its own
   walk. Sharing the in-flight promise collapses them into a single walk. */
let treeInFlight: Promise<KbFolder[]> | null = null;

const invalidateFolderTree = (): void => {
  treeCache = null;
  statsCache.clear();
};

const walkFolderTree = async (): Promise<KbFolder[]> => {
  const collected: KbFolder[] = [];
  const seen = new Set<string>();

  const walk = async (parent: string | undefined, depth: number, trail: string) => {
    if (depth > MAX_FOLDER_DEPTH) return;

    const level = await fetchFolderLevel(parent);
    for (const folder of level) {
      if (!folder.id || seen.has(folder.id)) continue;
      seen.add(folder.id);

      folder.depth = depth;
      folder.displayPath = trail ? `${trail} / ${folder.name}` : folder.name;
      collected.push(folder);

      await walk(folder.id, depth + 1, folder.displayPath);
    }
  };

  await walk(undefined, 0, '');
  treeCache = { folders: collected, at: Date.now() };
  return collected;
};

const fetchFolderTree = async (): Promise<KbFolder[]> => {
  if (treeCache && Date.now() - treeCache.at < TREE_TTL_MS) return treeCache.folders;
  if (treeInFlight) return treeInFlight;

  treeInFlight = walkFolderTree().finally(() => {
    treeInFlight = null;
  });
  return treeInFlight;
};

/**
 * Folders, from the cached tree.
 *
 * `parentId` is answered by filtering the tree rather than asking Perfox for
 * that level: the tree already holds it, and a second request would buy nothing
 * but another hit against the rate limit.
 */
const fetchFolders = async (parentId?: string): Promise<KbFolder[]> => {
  const tree = await fetchFolderTree();
  if (!parentId) return tree;
  return tree.filter((folder) => folder.parentId === parentId);
};


/**
 * GET /developer/kb/folders
 *
 * Read live on every request — a folder created in Perfox should appear here
 * without anyone refreshing a cache. The list is small and only read while
 * someone is on the configuration screen.
 */
export const listFolders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    /* Omitted lists every folder; `parentId` lists one level, which is how the
       browser drills into a folder. */
    const parentId = String(req.query.parentId ?? '').trim();
    const folders = await fetchFolders(parentId || undefined);

    log.debug(`Listed ${folders.length} knowledge-base folder(s)`);
    return res.status(200).json(ok({ folders }));
  } catch (error) {
    return next(toAppError(error, 'Could not list the knowledge-base folders', log));
  }
};

export const createFolderSchema = z.object({
  body: z.object({
    /* Trimmed before the length check: '   ' would otherwise pass min(1), reach
       Perfox and come back as a 502, blaming the platform for our bad input. */
    name: z.string().trim().min(1, 'Folder name is required').max(200),
    /* Omitted or empty means the root — Perfox expects null, not ''. */
    parentId: z.string().optional(),
  }),
});

/**
 * POST /developer/kb/folders
 *
 * Creates the folder in Perfox and selects it straight away: someone creating a
 * folder from the configuration screen wants to use it, so making them pick it
 * from the list afterwards would be a pointless second step.
 */
export const createFolder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.body.name).trim();
    const parentId = String(req.body.parentId ?? '').trim();

    const payload = await perfoxFetch<any>('/kb/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId || null }),
    });

    const created = toFolder(payload?.data ?? payload);
    if (!created.id) {
      throw new AppError('Perfox did not return the created folder', 502);
    }

    invalidateFolderTree();
    log.log(`Created knowledge-base folder "${created.name}" (${created.id})`);
    return res.status(201).json(ok({ folder: created }, `Folder "${created.name}" created`));
  } catch (error) {
    return next(toAppError(error, 'Could not create the knowledge-base folder', log));
  }
};

/** A knowledge-base file, reduced to what the list and detail views need. */
interface KbFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Perfox's ingestion state — `active` is indexed and searchable. */
  status: string;
  chunkCount: number;
  folderId: string;
  /** Where it lives, so a list spanning folders can say so. */
  folderName: string;
  uploadedAt: string;
  updatedAt: string;
}

const toFile = (raw: any, folderName = ''): KbFile => ({
  id: String(raw?.id ?? ''),
  name: String(raw?.name ?? 'Untitled file'),
  mimeType: String(raw?.mime_type ?? ''),
  sizeBytes: Number(raw?.file_size ?? 0),
  status: String(raw?.status ?? 'unknown'),
  chunkCount: Number(raw?.chunk_count ?? 0),
  folderId: String(raw?.folder_id ?? ''),
  folderName,
  uploadedAt: String(raw?.created_at ?? ''),
  updatedAt: String(raw?.updated_at ?? ''),
});

/**
 * The folder the Knowledge Base tab works against — the one chosen in the
 * Developer hub.
 *
 * Refused rather than defaulted to the first folder in the workspace: uploading
 * into a folder nobody selected would put the tenant's documents somewhere they
 * never asked for.
 */
/**
 * Resolves the destination for a write.
 *
 * Empty means the root of the knowledge base, which Perfox expects as `null`.
 * A named folder is checked against the live list, so a write cannot be sent to
 * a folder that no longer exists.
 */
const resolveTargetFolder = async (
  folderId?: string
): Promise<{ id: string | null; name: string }> => {
  const wanted = String(folderId ?? '').trim();
  if (!wanted) return { id: null, name: 'Root level' };

  const folders = await fetchFolders();
  const folder = folders.find((f) => f.id === wanted);
  if (!folder) {
    throw new AppError('That folder does not exist in the Perfox knowledge base', 404);
  }
  return { id: folder.id, name: folder.name };
};

export const renameFolderSchema = z.object({
  body: z.object({
    /* Trimmed before the length check: '   ' would otherwise pass min(1) and
       reach Perfox as a blank name. */
    name: z.string().trim().min(1, 'Folder name is required').max(200),
  }),
});

/**
 * PATCH /knowledge/folders/:id
 *
 * Renames the folder in Perfox. Only the display name changes — the id, and so
 * every file and agent pointing at it, is untouched.
 */
export const renameFolder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '').trim();
    const name = String(req.body.name).trim();

    let payload: any;
    try {
      payload = await perfoxFetch<any>(`/kb/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch (error) {
      /* The upstream 404 names our internal path, which means nothing to the
         caller — say what is actually missing. */
      if ((error as AppError)?.statusCode === 404) {
        throw new AppError('That folder no longer exists in the Perfox knowledge base', 404);
      }
      throw error;
    }

    const folder = toFolder(payload?.data ?? payload);
    invalidateFolderTree();
    log.log(`Renamed knowledge-base folder ${id} to "${name}"`);
    return res.status(200).json(ok({ folder }, `Folder renamed to "${name}"`));
  } catch (error) {
    return next(toAppError(error, 'Could not rename the folder', log));
  }
};

/**
 * DELETE /knowledge/folders/:id
 *
 * Perfox refuses to delete a folder that still holds anything, and does NOT
 * cascade — which is the behaviour we want: a folder delete must never take
 * documents with it silently. Its 409 carries the counts, so the refusal is
 * turned into a message that says what to clear out.
 *
 * Note the published Perfox spec documents only 200/401/403/404 for this route;
 * the 409 is real and observed, so it is handled from behaviour, not the spec.
 */
export const deleteFolder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '').trim();

    let payload: any;
    try {
      payload = await perfoxFetch<any>(`/kb/folders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      const detail = (error as any)?.details ?? (error as any)?.body ?? {};
      const files = Number(detail?.files ?? 0);
      const subfolders = Number(detail?.subfolders ?? 0);

      if ((error as AppError)?.statusCode === 404) {
        throw new AppError('That folder no longer exists in the Perfox knowledge base', 404);
      }

      if (detail?.error === 'folder_not_empty' || files || subfolders) {
        const parts: string[] = [];
        if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`);
        if (subfolders) parts.push(`${subfolders} subfolder${subfolders === 1 ? '' : 's'}`);
        throw new AppError(
          `This folder still contains ${parts.join(' and ')}. Delete its contents first — ` +
            `deleting a folder never removes what is inside it.`,
          409
        );
      }
      throw error;
    }

    /* Perfox names the agents that were drawing on this folder, so the caller
       can say what just lost a source rather than only that it worked. */
    const body = payload?.data ?? payload;
    const affectedAgents: string[] = Array.isArray(body?.affected_agents)
      ? body.affected_agents.map((a: any) => String(a?.name ?? a?.id ?? a))
      : [];

    invalidateFolderTree();
    log.log(
      `Deleted knowledge-base folder ${id}` +
        (affectedAgents.length ? `, affecting ${affectedAgents.join(', ')}` : '')
    );
    return res.status(200).json(ok({ id, deleted: true, affectedAgents }, 'Folder deleted'));
  } catch (error) {
    return next(toAppError(error, 'Could not delete the folder', log));
  }
};


/**
 * GET /knowledge/files?folderId=&status=&limit=&cursor=
 *
 * One level at a time: omitted `folderId` is the root, a folder id is that
 * folder's contents. This mirrors how the page is browsed — folders, then the
 * files inside the one that was opened.
 *
 * Perfox scopes `GET /kb/files` the same way: with no `folder_id` it answers
 * with the root only, which is why a bare call returns nothing in a workspace
 * whose files all live in folders.
 *
 * `status`, `limit` and `cursor` are passed straight through.
 *
 * Newest first — someone who has just uploaded a file is looking for it at the
 * top, and it is the row most likely to still be indexing.
 */
export const listFiles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const folderId = String(req.query.folderId ?? '').trim();
    const status = String(req.query.status ?? '').trim();
    const limit = String(req.query.limit ?? '').trim();
    const cursor = String(req.query.cursor ?? '').trim();

    /* Checked before listing so an unknown folder is a 404 rather than an empty
       list that reads as "this folder is empty". */
    const folders = await fetchFolders();
    const folder = folderId ? folders.find((f) => f.id === folderId) : undefined;
    if (folderId && !folder) {
      throw new AppError('That folder does not exist in the Perfox knowledge base', 404);
    }

    const query = new URLSearchParams();
    if (folderId) query.set('folder_id', folderId);
    if (status) query.set('status', status);
    if (limit) query.set('limit', limit);
    if (cursor) query.set('cursor', cursor);
    const suffix = query.toString() ? `?${query}` : '';

    const payload = await perfoxFetch<{ data?: any[]; next_cursor?: string }>(
      `/kb/files${suffix}`
    );
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const folderName = folder?.name ?? 'Root level';
    const files: KbFile[] = rows.map((row) => toFile(row, folderName));

    /* A file uploaded seconds ago can be absent from the listing while Perfox
       finishes ingesting it. Our own upload records cover that window, so it
       does not vanish from the page between upload and first index. */
    const known = new Set(files.map((f) => f.id));

    /* First page only. These rows are not part of the cursor's sequence, so
       merging them into every page would repeat the same file down the list. */
    const pending = cursor
      ? []
      : ((await KbFileRefModel.find(
          folderId ? { folderId } : { $or: [{ folderId: '' }, { folderId: null }] }
        ).lean()) as any[]);

    const missing: string[] = [];
    await Promise.all(
      pending
        .filter((row) => !known.has(String(row.fileId)))
        .map(async (row) => {
          try {
            const one = await perfoxFetch<any>(`/kb/files/${encodeURIComponent(row.fileId)}`);
            files.push(toFile(one?.data ?? one, folderName));
          } catch {
            /* Deleted upstream, or never readable — a stale pointer. */
            missing.push(String(row.fileId));
          }
        })
    );

    /* Clearing these stops the list retrying a dead id on every page load. */
    if (missing.length) {
      await KbFileRefModel.deleteMany({ fileId: { $in: missing } });
      log.warn(`Dropped ${missing.length} knowledge-base file(s) Perfox could not return`);
    }

    files.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));

    log.debug(`Listed ${files.length} knowledge-base file(s) in ${folderName}`);
    return res.status(200).json(
      ok({
        total: files.length,
        folderId,
        folderName,
        nextCursor: String(payload?.next_cursor ?? ''),
        files,
      })
    );
  } catch (error) {
    return next(toAppError(error, 'Could not list the knowledge-base files', log));
  }
};

export const uploadMarkdownSchema = z.object({
  body: z.object({
    /* Trimmed before the length check so '   ' cannot reach Perfox as a name. */
    name: z.string().trim().min(1, 'A file name is required').max(200),
    content: z.string().min(1, 'Markdown content is required'),
    /* Omitted or empty means the root of the knowledge base. */
    folderId: z.string().trim().optional(),
  }),
});

/* Reserved and control characters are stripped so the name is safe as a file on
   any platform, and the result is collapsed so a name of only punctuation
   cannot reduce to an empty string. */
const toMarkdownFileName = (name: string): string => {
  const cleaned = name
    .trim()
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim();

  const base = cleaned || 'untitled';
  return /\.md$/i.test(base) ? base : `${base}.md`;
};

/**
 * POST /knowledge/files
 *
 * Takes a file name and markdown content, writes them into a real `.md` file and
 * uploads it to the selected folder. The user never handles a file: the browser
 * sends text, and the multipart upload Perfox wants is assembled here, so the
 * API token stays server-side like every other Perfox call.
 */
export const uploadMarkdown = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await resolveTargetFolder(req.body.folderId);
    const fileName = toMarkdownFileName(String(req.body.name));
    const content = String(req.body.content);

    const form = new FormData();
    /* The content type goes on the part, never on the request: fetch has to
       write the multipart boundary itself. */
    form.append('file', new Blob([content], { type: 'text/markdown' }), fileName);
    form.append('name', fileName);
    /* Omitted entirely for the root — an empty folder_id is not the same as none. */
    if (target.id) form.append('folder_id', target.id);

    const payload = await perfoxFetch<any>(
      '/kb/files',
      { method: 'POST', body: form },
      UPLOAD_TIMEOUT_MS
    );

    const file = toFile(payload?.data ?? payload, target.name);
    if (!file.id) {
      throw new AppError('Perfox did not return the uploaded file', 502);
    }

    await KbFileRefModel.updateOne(
      { fileId: file.id },
      {
        fileId: file.id,
        folderId: target.id ?? '',
        name: file.name || fileName,
        uploadedAt: file.uploadedAt || new Date().toISOString(),
        uploadedBy: (req as any).user?.email ?? '',
      },
      { upsert: true }
    );

    invalidateFolderTree();
    log.log(`Uploaded "${fileName}" (${file.id}) to ${target.name}`);
    return res.status(201).json(
      ok(
        { file },
        /* Said plainly: the file exists, but it answers nothing until Perfox has
           indexed it, and the list shows that as its status. */
        `"${fileName}" uploaded — Perfox is indexing it, so it may take a moment to become searchable`
      )
    );
  } catch (error) {
    return next(toAppError(error, 'Could not upload the markdown file', log));
  }
};

/*
 * Counting the whole knowledge base means one file listing per folder, so the
 * tiles are cached for the same window as the tree. They are a summary, not a
 * live readout, and recomputing them on every page load is what makes a rate
 * limit with no published quota dangerous.
 */
const STATS_TTL_MS = 30_000;
const statsCache = new Map<string, { stats: Record<string, number>; at: number }>();

/**
 * GET /knowledge/stats
 *
 * Counted from the same list the tab shows, so the tiles and the table can never
 * disagree. `notIndexed` is the number worth acting on: those files are stored
 * but answer nothing.
 */
export const getKnowledgeStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const folderId = String(req.query.folderId ?? '').trim();

    const cached = statsCache.get(folderId);
    if (cached && Date.now() - cached.at < STATS_TTL_MS) {
      return res.status(200).json(ok(cached.stats));
    }

    /* Scoped to one folder when asked, otherwise the whole knowledge base —
       root plus every folder, since Perfox scopes a bare list to the root. */
    const folders = folderId ? [] : await fetchFolders();
    const scopes = folderId ? [folderId] : ['', ...folders.map((f) => f.id)];

    const settled = await Promise.allSettled(
      scopes.map((id) =>
        perfoxFetch<{ data?: any[] }>(`/kb/files${id ? `?folder_id=${encodeURIComponent(id)}` : ''}`)
      )
    );

    /* One unreadable folder should not zero the tiles for the rest. */
    const files = settled
      .filter((r): r is PromiseFulfilledResult<{ data?: any[] }> => r.status === 'fulfilled')
      .flatMap((r) => (Array.isArray(r.value?.data) ? r.value.data : []))
      .map((row) => toFile(row));

    const stats = {
      totalFiles: files.length,
      indexedFiles: files.filter((f) => f.status === 'active').length,
      notIndexed: files.filter((f) => f.status !== 'active').length,
      totalChunks: files.reduce((sum, f) => sum + f.chunkCount, 0),
      totalSizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    };

    statsCache.set(folderId, { stats, at: Date.now() });
    return res.status(200).json(ok(stats));
  } catch (error) {
    return next(toAppError(error, 'Could not compute knowledge statistics', log));
  }
};

/** Largest upload accepted. Enforced here as well as by the raw body parser. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * POST /knowledge/files/upload?name=&mime=
 *
 * The browser sends the file as a raw byte stream; this rebuilds the multipart
 * request Perfox expects.
 *
 * Done this way so the target folder is decided server-side. If the browser
 * posted multipart directly it would carry its own `folder_id`, and a caller
 * could write into any folder in the workspace regardless of what was
 * configured. It also avoids adding a multipart parser to the service.
 */
export const uploadFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await resolveTargetFolder(String(req.query.folderId ?? ''));

    const name = String(req.query.name ?? '').trim();
    const mime = String(req.query.mime ?? '').trim() || 'application/octet-stream';
    if (!name) throw new AppError('A file name is required', 400);

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError('The request carried no file content', 400);
    }
    if (body.length > MAX_UPLOAD_BYTES) {
      throw new AppError(`Files must be ${MAX_UPLOAD_BYTES / 1024 / 1024}MB or smaller`, 413);
    }

    /* Node builds the multipart body and its boundary — no Content-Type is set
       here, or the boundary would be missing and Perfox would reject it. */
    const form = new FormData();
    form.append('file', new Blob([body], { type: mime }), name);
    form.append('name', name);
    /* Omitted entirely for the root — an empty folder_id is not the same as none. */
    if (target.id) form.append('folder_id', target.id);

    const payload = await perfoxFetch<any>('/kb/files', { method: 'POST', body: form });
    const file = toFile(payload?.data ?? payload, target.name);
    if (!file.id) throw new AppError('Perfox did not return the uploaded file', 502);

    /* Recorded because a freshly uploaded file is not in the folder manifest
       until Perfox has indexed it — without this it would vanish from the list
       until then. */
    await KbFileRefModel.updateOne(
      { fileId: file.id },
      {
        $set: {
          fileId: file.id,
          folderId: target.id ?? '',
          name: file.name,
          uploadedAt: new Date().toISOString(),
          uploadedBy: (req as any).user?.email ?? '',
        },
      },
      { upsert: true }
    );

    invalidateFolderTree();
    log.log(`Uploaded "${name}" (${body.length} bytes) to ${target.name}`);
    return res.status(201).json(ok({ file }, `"${file.name}" uploaded`));
  } catch (error) {
    return next(toAppError(error, 'Could not upload the file', log));
  }
};

/**
 * DELETE /knowledge/files/:id
 *
 * Removes the file from Perfox, then drops our pointer to it. Perfox is the
 * authority, so its refusal stops the whole operation — clearing our row first
 * would hide a file that still exists and still answers queries.
 */
export const deleteFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    try {
      await perfoxFetch(`/kb/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      /* Already gone upstream: the caller's intent is satisfied, so drop our
         pointer and report success rather than an error they cannot act on. */
      if (error instanceof AppError && error.statusCode === 404) {
        await KbFileRefModel.deleteOne({ fileId: id });
        log.warn(`File ${id} was already absent from Perfox — cleared the local reference`);
        return res.status(200).json(ok({ id, deleted: true }, 'File already removed'));
      }
      throw error;
    }
    await KbFileRefModel.deleteOne({ fileId: id });

    invalidateFolderTree();
    log.log(`Deleted knowledge-base file ${id}`);
    return res.status(200).json(ok({ id, deleted: true }, 'File deleted'));
  } catch (error) {
    return next(toAppError(error, `Could not delete file ${req.params.id}`, log));
  }
};


export const generateCatalogSchema = z.object({
  body: z.object({
    /* Omitted or empty means the root of the knowledge base. */
    folderId: z.string().trim().optional(),
    includeProducts: z.boolean().optional(),
    includeCategories: z.boolean().optional(),
    template: z.enum(['qa', 'reference']).optional(),
    /* Off by default: removing someone's file is not a side effect to assume. */
    replaceExisting: z.boolean().optional(),
  }),
});

/**
 * POST /knowledge/catalog
 *
 * Compiles the product catalogue into one markdown document and uploads it.
 *
 * The document is built here rather than in the browser: the catalogue is
 * already on this side, the client could only ever page through part of it, and
 * which fields are excluded (price, stock, margin) is a policy decision that a
 * caller should not be able to opt out of.
 */
export const generateCatalog = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await resolveTargetFolder(req.body.folderId);

    /* No pagination: the whole catalogue goes in, or the document is a partial
       answer that reads as a complete one. */
    const [products, categories] = await Promise.all([
      store.getProducts(),
      store.getCategories(),
    ]);

    const doc = buildCatalogDocument(products, categories, {
      includeProducts: req.body.includeProducts,
      includeCategories: req.body.includeCategories,
      template: req.body.template,
    });

    if (!doc.productCount && !doc.categoryCount) {
      throw new AppError('Select products or categories to generate from', 400);
    }

    /* Perfox assigns a new id per upload, so re-importing would stack copies of
       the same document and leave the agent answering from whichever it matched.
       Asked for explicitly, the previous one is removed first. */
    let replaced = 0;
    if (req.body.replaceExisting) {
      const previous = await KbFileRefModel.find({
        name: doc.name,
        folderId: target.id ?? '',
      }).lean();

      for (const row of previous as any[]) {
        try {
          await perfoxFetch(`/kb/files/${encodeURIComponent(row.fileId)}`, { method: 'DELETE' });
        } catch (error) {
          /* Already gone upstream is fine; anything else is not worth failing
             the regeneration over. */
          log.warn(`Could not remove the previous catalog file ${row.fileId}: ${(error as Error).message}`);
        }
        await KbFileRefModel.deleteOne({ fileId: row.fileId });
        replaced += 1;
      }
    }

    const form = new FormData();
    form.append('file', new Blob([doc.content], { type: 'text/markdown' }), doc.name);
    form.append('name', doc.name);
    /* Omitted entirely for the root — an empty folder_id is not the same as none. */
    if (target.id) form.append('folder_id', target.id);

    const payload = await perfoxFetch<any>('/kb/files', { method: 'POST', body: form });
    const file = toFile(payload?.data ?? payload, target.name);
    if (!file.id) throw new AppError('Perfox did not return the uploaded file', 502);

    await KbFileRefModel.updateOne(
      { fileId: file.id },
      {
        $set: {
          fileId: file.id,
          folderId: target.id ?? '',
          name: file.name || doc.name,
          uploadedAt: new Date().toISOString(),
          uploadedBy: (req as any).user?.email ?? '',
        },
      },
      { upsert: true }
    );

    log.log(
      `Generated ${doc.name} (${doc.productCount} product(s), ${doc.categoryCount} ` +
        `categor(y/ies), ${doc.content.length} chars) into ${target.name}` +
        (replaced ? `, replacing ${replaced} previous copy(ies)` : '')
    );

    return res.status(201).json(
      ok(
        {
          file,
          productCount: doc.productCount,
          categoryCount: doc.categoryCount,
          replaced,
          sizeBytes: Buffer.byteLength(doc.content, 'utf8'),
        },
        `Catalog compiled from ${doc.productCount} product(s) and ${doc.categoryCount} categor(y/ies)`
      )
    );
  } catch (error) {
    return next(toAppError(error, 'Could not generate the catalog document', log));
  }
};
