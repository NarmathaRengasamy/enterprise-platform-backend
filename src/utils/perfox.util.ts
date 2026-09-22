import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { resolvePlatformConnection } from '../controllers/platform.controller.js';

const log = createLogger('PerfoxClient');

const REQUEST_TIMEOUT_MS = 12000;
/* Uploads carry a body and are indexed on arrival, so they need far longer than
   a read before we are entitled to call the platform unresponsive. */
export const UPLOAD_TIMEOUT_MS = 60000;

/** Perfox expects `Authorization: Bearer <key>`; the stored value may already carry the scheme. */
const authHeader = (token: string): string =>
  /^(bearer|basic)\s/i.test(token.trim()) ? token.trim() : `Bearer ${token.trim()}`;

/**
 * Calls the Perfox platform with the tenant's configured credentials.
 *
 * Every call goes through here so the API token stays server-side — it is never
 * sent to the browser, and no route has to know how it is stored.
 *
 * Upstream failures are translated into AppErrors that say plainly that Perfox
 * refused, rather than surfacing as an opaque 500 from our own service.
 */
export const perfoxFetch = async <T = any>(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> => {
  const connection = await resolvePlatformConnection();
  if (!connection) {
    throw new AppError('No Perfox connection is configured', 409);
  }

  const url = `${connection.apiUrl.replace(/\/+$/, '')}${path}`;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader(connection.apiToken),
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const err = error as Error;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    log.error(`Perfox ${path} failed: ${err.message}`);
    /* 502/504: the failure is upstream, not in this request. */
    throw new AppError(
      timedOut
        ? `Perfox did not answer within ${timeoutMs / 1000}s`
        : `Could not reach Perfox: ${err.message}`,
      timedOut ? 504 : 502
    );
  }

  const elapsed = Date.now() - startedAt;

  if (!response.ok) {
    log.warn(`Perfox ${path} -> ${response.status} in ${elapsed}ms`);
    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        'Perfox rejected the configured API token. Check it in the platform connection.',
        502
      );
    }
    if (response.status === 404) {
      /* 404 is about the thing asked for, not about us: a deleted file or an
         unknown id. Passing it through as 404 lets the caller say so, instead of
         a 502 blaming the base URL — which only made sense for the connection
         probe, and that has its own check. */
      throw new AppError(`Perfox has no ${path}`, 404);
    }
    throw new AppError(`Perfox answered ${response.status} ${response.statusText}`, 502);
  }

  log.debug(`Perfox ${path} -> ${response.status} in ${elapsed}ms`);

  /* A 204, or any response without a JSON body, is a success with nothing to
     read — POST /agents/{id}/publish answers that way. Calling .json() on it
     would throw and turn a successful publish into an error. */
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    const text = await response.text();
    return (text ? (text as unknown as T) : (undefined as T));
  }

  return (await response.json()) as T;
};

/** One agent as it exists in the Perfox workspace. */
export interface WorkspaceAgent {
  id: string;
  name: string;
  description: string;
  /** Perfox's own vocabulary: published | paused | draft. Passed through unchanged. */
  status: string;
  channels: string[];
  activeVersion: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Perfox answers in snake_case; the rest of this API is camelCase, so the
 * boundary is normalised here rather than leaving both conventions in the UI.
 */
export const toWorkspaceAgent = (raw: any): WorkspaceAgent => ({
  id: String(raw?.id ?? ''),
  name: String(raw?.name ?? 'Untitled agent'),
  description: String(raw?.description ?? ''),
  status: String(raw?.status ?? 'unknown'),
  channels: Array.isArray(raw?.channels) ? raw.channels.map(String) : [],
  activeVersion: Number(raw?.active_version ?? 0),
  nodeCount: Number(raw?.node_count ?? 0),
  createdAt: String(raw?.created_at ?? ''),
  updatedAt: String(raw?.updated_at ?? ''),
});
