import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { store } from '../data/store.js';
import { config } from '../config/index.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { ok } from '../utils/response.util.js';
import { assertSafeUrl, mask } from '../utils/outbound.util.js';
import { PlatformConnection, PlatformOperatorSite } from '../types/index.js';

const log = createLogger('PlatformController');

const VERIFY_TIMEOUT_MS = 8000;
/* The lightest authenticated read the Perfox API offers — it proves the base URL
   is right and the token is accepted, without changing anything. */
const VERIFY_PATH = '/kb/folders';

/* The shipped .env.example placeholders. Treating one as "configured" would put
   the Developer Hub in front of a connection that cannot possibly work. */
const PLACEHOLDERS = [
  'bearer sk_replace_me',
  'bearer sk_....',
  'sk_replace_me',
];

const isPlaceholder = (value?: string): boolean =>
  !value ||
  PLACEHOLDERS.includes(value.trim().toLowerCase()) ||
  value.includes('<your-workspace>');

/** Perfox expects `Authorization: Bearer <key>`; the stored value may already carry the scheme. */
const authHeader = (token: string): string =>
  /^(bearer|basic)\s/i.test(token.trim()) ? token.trim() : `Bearer ${token.trim()}`;

/** `https://pradeepworkspace-api.perfox.ai/api/v1` -> `pradeepworkspace`. */
const workspaceFrom = (apiUrl: string): string => {
  try {
    const label = new URL(apiUrl).hostname.split('.')[0] ?? '';
    return label.replace(/-api$/, '');
  } catch {
    return '';
  }
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * The connection in force, whether it came from the Developer Hub or the
 * environment.
 *
 * A stored row always wins: the environment is a deployment-time bootstrap so a
 * self-hosted instance can come up already connected, but once a developer has
 * saved credentials in the UI those are the tenant's own.
 */
export const resolvePlatformConnection = async (): Promise<
  (PlatformConnection & { source: 'stored' | 'env' }) | undefined
> => {
  const stored = await store.getPlatformConnection(true);
  if (stored?.apiUrl && stored?.apiToken) return { ...stored, source: 'stored' };

  if (isPlaceholder(config.perfoxApiUrl) || isPlaceholder(config.perfoxApiToken)) return undefined;

  return {
    id: 'perfox',
    apiUrl: trimTrailingSlash(config.perfoxApiUrl),
    apiToken: config.perfoxApiToken,
    workspace: workspaceFrom(config.perfoxApiUrl),
    /* Unverified rather than Connected — nothing has called Perfox yet. */
    status: 'Unverified',
    source: 'env',
  };
};

/** True when the Developer Hub may show agents and webhook endpoints. */
export const isPlatformConfigured = async (): Promise<boolean> =>
  Boolean(await resolvePlatformConnection());

/** The shape the UI reads. Never carries the token — only a masked hint. */
const present = (connection: (PlatformConnection & { source?: string }) | undefined) => {
  if (!connection) {
    return {
      configured: false,
      apiUrl: '',
      apiTokenMasked: '',
      workspace: '',
      status: 'Unverified' as const,
      lastVerifiedAt: '',
      lastError: '',
      connectedBy: '',
      updatedAt: '',
      source: 'none',
      verifyPath: VERIFY_PATH,
      ...presentOperatorSite(undefined),
    };
  }
  return {
    configured: true,
    apiUrl: connection.apiUrl,
    apiTokenMasked: mask(connection.apiToken.replace(/^bearer\s+/i, '')),
    workspace: connection.workspace || workspaceFrom(connection.apiUrl),
    status: connection.status,
    lastVerifiedAt: connection.lastVerifiedAt || '',
    lastError: connection.lastError || '',
    connectedBy: connection.connectedBy || '',
    updatedAt: connection.updatedAt || '',
    source: connection.source ?? 'stored',
    verifyPath: VERIFY_PATH,
    ...presentOperatorSite(connection.operatorSite),
  };
};

/**
 * The operator site as the browser may see it — everything except the secret.
 *
 * `operatorConfigured` is what the UI gates on: without a site there is nobody
 * to sign, so the Call button cannot work.
 */
const presentOperatorSite = (site?: PlatformOperatorSite) => ({
  operatorConfigured: Boolean(site?.apiHost && site?.siteId && site?.siteSecret),
  operatorSite: {
    apiHost: site?.apiHost ?? '',
    siteId: site?.siteId ?? '',
    siteSecretMasked: site?.siteSecret ? mask(site.siteSecret) : '',
    workflowId: site?.workflowId ?? '',
    configuredAt: site?.configuredAt ?? '',
    configuredBy: site?.configuredBy ?? '',
  },
});

/**
 * Calls Perfox with the given credentials and reports what came back.
 *
 * Never throws for a rejected connection — an unreachable host or a stale token
 * is a result to show the developer, not a server error.
 */
const probe = async (
  apiUrl: string,
  apiToken: string
): Promise<{ reachable: boolean; httpStatus: number | null; message: string; latencyMs: number }> => {
  const target = `${trimTrailingSlash(apiUrl)}${VERIFY_PATH}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { Authorization: authHeader(apiToken), Accept: 'application/json' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;

    if (response.ok) {
      return { reachable: true, httpStatus: response.status, message: '', latencyMs };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        reachable: false,
        httpStatus: response.status,
        message: 'Perfox rejected the API token. Check that it is current and has not been revoked.',
        latencyMs,
      };
    }
    if (response.status === 404) {
      return {
        reachable: false,
        httpStatus: 404,
        message: `The host answered, but ${VERIFY_PATH} was not found — check the base URL ends with /api/v1.`,
        latencyMs,
      };
    }
    return {
      reachable: false,
      httpStatus: response.status,
      message: `Perfox answered ${response.status} ${response.statusText}.`,
      latencyMs,
    };
  } catch (error) {
    const err = error as Error;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      reachable: false,
      httpStatus: null,
      message: timedOut
        ? `Perfox did not answer within ${VERIFY_TIMEOUT_MS / 1000}s.`
        : `Could not reach Perfox: ${err.message}`,
      latencyMs: Date.now() - startedAt,
    };
  }
};

export const savePlatformConnectionSchema = z.object({
  body: z.object({
    apiUrl: z.string().url('A valid Perfox API base URL is required'),
    /* Optional on an update: an empty token means "keep the one already saved",
       which lets a developer correct the URL without re-typing the secret. */
    apiToken: z.string().optional(),
  }),
});

/** GET /developer/platform */
export const getPlatformConnection = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const connection = await resolvePlatformConnection();
    log.debug(`Platform connection read: ${connection ? connection.source : 'not configured'}`);
    return res.status(200).json(ok(present(connection)));
  } catch (error) {
    return next(toAppError(error, 'Failed to read the platform connection', log));
  }
};

/**
 * PUT /developer/platform — saves the credentials and verifies them in one step.
 *
 * A failed verification does not reject the save: the credentials are stored
 * with `status: 'Error'` and the reason, so the developer can see what Perfox
 * said and correct it rather than losing what they typed.
 */
export const savePlatformConnection = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiUrl = trimTrailingSlash(String(req.body.apiUrl).trim());
    const submitted = String(req.body.apiToken ?? '').trim();

    const existing = await store.getPlatformConnection(true);
    const apiToken = submitted || existing?.apiToken || '';
    if (!apiToken) {
      throw new AppError('apiToken is required the first time the platform is connected', 400);
    }
    if (isPlaceholder(apiUrl) || isPlaceholder(apiToken)) {
      throw new AppError(
        'Replace the placeholder values with your real Perfox workspace URL and API token',
        400
      );
    }

    /* The server will fetch this URL on the tenant's behalf, so it gets the same
       SSRF guard as any other user-supplied outbound target. */
    await assertSafeUrl(apiUrl);

    const result = await probe(apiUrl, apiToken);
    const saved = await store.savePlatformConnection({
      apiUrl,
      apiToken,
      workspace: workspaceFrom(apiUrl),
      status: result.reachable ? 'Connected' : 'Error',
      lastVerifiedAt: new Date().toISOString(),
      lastError: result.message,
      connectedBy: (req as any).user?.email ?? '',
    });

    log.log(
      `Platform connection saved for workspace "${saved.workspace}" — ` +
        (result.reachable ? 'verified' : `unverified (${result.message})`)
    );

    return res.status(200).json(
      ok(
        {
          ...present({ ...saved, source: 'stored' }),
          verification: { ...result, ok: result.reachable },
        },
        result.reachable ? 'Perfox platform connected' : 'Saved, but Perfox could not be reached'
      )
    );
  } catch (error) {
    return next(toAppError(error, 'Failed to save the platform connection', log));
  }
};

/** POST /developer/platform/test — re-verifies what is already configured. */
export const testPlatformConnection = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const connection = await resolvePlatformConnection();
    if (!connection) {
      throw new AppError('No Perfox connection is configured yet', 409);
    }

    const result = await probe(connection.apiUrl, connection.apiToken);

    /* Only a stored connection is updated — an env-provided one is not ours to rewrite. */
    if (connection.source === 'stored') {
      await store.savePlatformConnection({
        status: result.reachable ? 'Connected' : 'Error',
        lastVerifiedAt: new Date().toISOString(),
        lastError: result.message,
      });
    }

    log.log(
      `Platform connection test: ${result.reachable ? 'ok' : result.message} (${result.latencyMs} ms)`
    );
    return res.status(200).json(ok({ ...result, ok: result.reachable }));
  } catch (error) {
    return next(toAppError(error, 'Failed to test the platform connection', log));
  }
};

/** DELETE /developer/platform — disconnects, hiding agents and endpoints again. */
export const disconnectPlatform = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const removed = await store.deletePlatformConnection();
    if (!removed) throw new AppError('No Perfox connection is configured', 404);

    log.warn(`Platform connection removed by ${(req as any).user?.email ?? 'an unknown user'}`);

    /* An env-provided connection reappears after this — say so, rather than
       letting the UI look as though the delete silently failed. */
    const fallback = await resolvePlatformConnection();
    return res.status(200).json(
      ok(
        {
          disconnected: true,
          fellBackToEnvironment: Boolean(fallback),
          connection: present(fallback),
        },
        'Perfox platform disconnected'
      )
    );
  } catch (error) {
    return next(toAppError(error, 'Failed to disconnect the platform', log));
  }
};

/**
 * Blocks the agent and webhook routes until the platform is connected.
 *
 * Enforced server-side as well as in the UI: an agent is only meaningful against
 * a Perfox workspace, so creating one without a connection would leave rows the
 * platform knows nothing about.
 */
export const requirePlatformConnection = async (
  _req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    if (await isPlatformConfigured()) return next();
    return next(
      new AppError(
        'Configure the Perfox API URL and API token before managing agents or endpoints',
        409
      )
    );
  } catch (error) {
    return next(toAppError(error, 'Failed to check the platform connection', log));
  }
};

/* ------------------------------------------------------- operator site */

/**
 * The API host the operator SDK talks to.
 *
 * Two mistakes are easy here and both surface as an unexplained CORS error in
 * the browser, so they are refused at the door with a message that says which
 * value is wanted:
 *
 *  - the Studio host (`https://acme.perfox.ai`) instead of the API host
 *    (`https://acme-api.perfox.ai`), which answers 405 with no CORS headers;
 *  - our workspace `apiUrl`, which carries a `/api/v1` suffix the SDK adds
 *    itself.
 */
const OPERATOR_HOST_HINT =
  'Use the API host from Perfox Studio -> Sites, e.g. https://acme-api.perfox.ai — not the Studio host, and without the /api/v1 suffix';

export const saveOperatorSiteSchema = z.object({
  body: z.object({
    apiHost: z
      .string()
      .trim()
      .min(1, 'The API host is required')
      .refine((value) => /^https?:\/\//i.test(value), 'The API host must start with http:// or https://')
      .refine((value) => !/\/api\/v\d/i.test(value), `The API host must not include a path. ${OPERATOR_HOST_HINT}`)
      .refine((value) => /-api\./i.test(value), `That looks like the Studio host. ${OPERATOR_HOST_HINT}`),
    siteId: z.string().trim().min(1, 'The site ID is required'),
    /* Optional on update: an empty secret means "keep the stored one", so the
       masked field in the UI does not have to be retyped to change the host. */
    siteSecret: z.string().trim().optional(),
    workflowId: z.string().trim().optional(),
  }),
});

/**
 * PUT /developer/platform/operator
 *
 * Stores the Perfox Site a human operator signs in against. Nested inside the
 * platform connection row: it belongs to the same tenant, and keeping it there
 * means one place to look and one place to clear.
 */
export const saveOperatorSite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await store.getPlatformConnection(true);
    if (!existing) {
      throw new AppError(
        'Configure the Perfox workspace connection before the operator site',
        409
      );
    }

    const submitted = String(req.body.siteSecret ?? '').trim();
    const stored = existing.operatorSite?.siteSecret ?? '';
    const siteSecret = submitted || stored;
    if (!siteSecret) {
      throw new AppError('The site secret is required', 400);
    }

    const operatorSite: PlatformOperatorSite = {
      apiHost: trimTrailingSlash(String(req.body.apiHost).trim()),
      siteId: String(req.body.siteId).trim(),
      siteSecret,
      workflowId: String(req.body.workflowId ?? '').trim(),
      configuredAt: new Date().toISOString(),
      configuredBy: (req as any).user?.email ?? '',
    };

    const saved = await store.savePlatformConnection({ ...existing, operatorSite });

    log.log(
      `Operator site saved: ${operatorSite.siteId} on ${operatorSite.apiHost}` +
        (submitted ? ' (secret replaced)' : ' (secret unchanged)')
    );
    return res.status(200).json(ok(present(saved), 'Operator site saved'));
  } catch (error) {
    return next(toAppError(error, 'Could not save the operator site', log));
  }
};

/**
 * POST /developer/platform/operator/sign
 *
 * Mints the operator identity the SDK needs. The site secret never leaves this
 * function: it signs, and only the signature goes back.
 *
 *   userHash = HMAC_SHA256(siteSecret, `${siteId}.${externalId}`)
 *
 * `externalId` is derived from the authenticated session, never from the
 * request — taking it from the body would let any signed-in user ask us to
 * vouch for somebody else's operator identity.
 */
export const signOperator = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connection = await store.getPlatformConnection(true);
    const site = connection?.operatorSite;

    if (!site?.apiHost || !site?.siteId || !site?.siteSecret) {
      throw new AppError(
        'The Perfox operator site is not configured — add it in the Developer hub',
        409
      );
    }

    const user = (req as any).user ?? {};
    const userId = String(user.userId ?? '').trim();
    if (!userId) throw new AppError('No authenticated user to sign', 401);

    const externalId = `op_${userId}`;
    const userHash = createHmac('sha256', site.siteSecret)
      .update(`${site.siteId}.${externalId}`)
      .digest('hex');

    log.debug(`Signed operator ${externalId} for site ${site.siteId}`);
    return res.status(200).json(
      ok({
        apiHost: site.apiHost,
        siteId: site.siteId,
        workflowId: site.workflowId || null,
        externalId,
        name: String(user.email ?? externalId),
        userHash,
      })
    );
  } catch (error) {
    return next(toAppError(error, 'Could not sign the operator', log));
  }
};
