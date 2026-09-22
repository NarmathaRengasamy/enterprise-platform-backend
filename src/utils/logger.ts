import { inspect } from 'util';

/**
 * Structured application logger, ported from the NestJS service.
 *
 * - Development: coloured, aligned, human-readable.
 * - Production (`NODE_ENV=production`): one JSON object per line, which is what
 *   log collectors expect.
 *
 * `LOG_LEVEL` is checked before anything is formatted, so debug logging costs
 * nothing once it is switched off.
 */

const LEVEL_ORDER: Record<string, number> = {
  error: 0,
  warn: 1,
  log: 2,
  debug: 3,
};

const COLORS: Record<string, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  log: '\x1b[32m',
  debug: '\x1b[35m',
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const isProduction = () => process.env.NODE_ENV === 'production';
const threshold = () => LEVEL_ORDER[(process.env.LOG_LEVEL || 'debug').toLowerCase()] ?? LEVEL_ORDER.debug;

/** Never let a credential reach the log, even on a 500. */
const REDACTED_KEYS = [
  'password',
  'secretKey',
  'token',
  'apiKeyValue',
  'bearerToken',
  'basicAuth',
  'authorization',
];

export const redact = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(clone)) {
    if (REDACTED_KEYS.includes(key)) clone[key] = '[redacted]';
  }
  return clone;
};

const write = (level: string, context: string, message: unknown, meta?: unknown, trace?: unknown): void => {
  if (LEVEL_ORDER[level] > threshold()) return;

  const timestamp = new Date().toISOString();
  const text = typeof message === 'string' ? message : inspect(message, { depth: 4 });

  if (isProduction()) {
    const line: Record<string, unknown> = { timestamp, level, context, message: text };
    if (meta !== undefined) line.meta = redact(meta);
    if (trace) line.trace = String(trace);
    process.stdout.write(`${JSON.stringify(line)}\n`);
    return;
  }

  const colour = COLORS[level] ?? '';
  let line = `${DIM}${timestamp}${RESET} ${colour}${level.toUpperCase().padEnd(5)}${RESET} ${BOLD}[${context}]${RESET} ${text}`;
  if (meta !== undefined) line += ` ${DIM}${inspect(redact(meta), { depth: 4 })}${RESET}`;

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
  if (trace) stream.write(`${DIM}${String(trace)}${RESET}\n`);
};

export interface Logger {
  log: (message: unknown, meta?: unknown) => void;
  error: (message: unknown, trace?: unknown, meta?: unknown) => void;
  warn: (message: unknown, meta?: unknown) => void;
  debug: (message: unknown, meta?: unknown) => void;
}

/** One logger per module, so every line says where it came from. */
export const createLogger = (context: string): Logger => ({
  log: (message, meta) => write('log', context, message, meta),
  error: (message, trace, meta) => write('error', context, message, meta, trace),
  warn: (message, meta) => write('warn', context, message, meta),
  debug: (message, meta) => write('debug', context, message, meta),
});

export const logger = createLogger('App');
