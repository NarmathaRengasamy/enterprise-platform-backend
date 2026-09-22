import { NextFunction, Request, Response } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('HTTP');

/**
 * One line in, one line out, with the elapsed time.
 *
 * Replaces `morgan('dev')`, which writes an unstructured line that no log
 * collector can parse. Failures are not logged here — the error handler
 * already logs them with the status it chose.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = Date.now();
  log.debug(`--> ${req.method} ${req.originalUrl}`);

  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    log.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });

  next();
};
