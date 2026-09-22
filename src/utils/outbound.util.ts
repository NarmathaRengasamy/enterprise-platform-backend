import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { AppError } from '../middlewares/errorHandler.js';

/**
 * Guards for outbound requests to user-supplied URLs.
 *
 * A webhook endpoint is a URL a user types in and the server then fetches, which
 * is a textbook SSRF vector: without this, anyone with an account could point an
 * endpoint at the cloud metadata service or an internal admin port and have the
 * server fetch it for them.
 */

const BLOCKED_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
];

export const assertSafeUrl = async (rawUrl: string): Promise<void> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('url must be a valid absolute URL', 400);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('url must use http or https', 400);
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new AppError('url must not point at an internal host', 400);
  }

  const addresses: string[] = isIP(host) ? [host] : [];
  if (!addresses.length) {
    try {
      const resolved = await lookup(host, { all: true });
      addresses.push(...resolved.map((r) => r.address));
    } catch {
      throw new AppError(`url host "${host}" could not be resolved`, 400);
    }
  }

  for (const address of addresses) {
    const privateV4 = BLOCKED_V4.some((pattern) => pattern.test(address));
    const privateV6 = address === '::1' || address.startsWith('fc') || address.startsWith('fd');
    if (privateV4 || privateV6) {
      throw new AppError('url must not point at a private or loopback address', 400);
    }
  }
};

/** Masks a secret for display: first 3 and last 4 characters only. */
export const mask = (value?: string): string => {
  if (!value) return '';
  return value.length <= 8 ? '****' : `${value.slice(0, 3)}****${value.slice(-4)}`;
};

/** Strips the plaintext secret from an agent and adds a masked hint. */
export const maskAgent = (agent: any) => {
  if (!agent) return agent;
  const { secretKey, ...rest } = agent;
  return { ...rest, secretKeyMasked: mask(secretKey) };
};

/** Masks every credential inside an endpoint's authConfig. */
export const maskEndpoint = (endpoint: any) => {
  if (!endpoint) return endpoint;
  const config = endpoint.authConfig ?? {};
  return {
    ...endpoint,
    authConfig: {
      ...(config.headerName ? { headerName: config.headerName } : {}),
      ...(config.bearerToken ? { bearerToken: mask(config.bearerToken) } : {}),
      ...(config.apiKeyValue ? { apiKeyValue: mask(config.apiKeyValue) } : {}),
      ...(config.basicAuth ? { basicAuth: mask(config.basicAuth) } : {}),
    },
  };
};

/** Builds the auth header an endpoint's configuration asks for. */
export const authHeadersFor = (endpoint: any): Record<string, string> => {
  const config = endpoint.authConfig ?? {};
  switch (endpoint.authType) {
    case 'bearer':
      return config.bearerToken ? { Authorization: `Bearer ${config.bearerToken}` } : {};
    case 'apiKey':
      return config.apiKeyValue ? { [config.headerName || 'X-API-Key']: config.apiKeyValue } : {};
    case 'basic':
      return config.basicAuth
        ? { Authorization: `Basic ${Buffer.from(config.basicAuth).toString('base64')}` }
        : {};
    default:
      return {};
  }
};
