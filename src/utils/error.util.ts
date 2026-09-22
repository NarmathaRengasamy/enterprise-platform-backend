import { Error as MongooseError } from 'mongoose';
import { AppError } from '../middlewares/errorHandler.js';
import { Logger } from './logger.js';

/**
 * Turns anything a controller catches into an AppError with the right status.
 *
 * Without this a database constraint surfaces as a generic 500 — a duplicate
 * SKU is a 409, and a client needs to be able to tell those apart.
 */
export const toAppError = (error: unknown, message: string, log: Logger): AppError => {
  // Already deliberate — pass it through untouched.
  if (error instanceof AppError) return error;

  // Unique index violation: duplicate SKU, email or category code.
  if (isDuplicateKey(error)) {
    const field = Object.keys(error.keyPattern ?? {})[0] ?? 'value';
    const value = Object.values(error.keyValue ?? {})[0];
    log.debug(`Duplicate key on "${field}"${value ? ` (${value})` : ''}`);
    return new AppError(
      `A record with that ${field}${value ? ` ("${value}")` : ''} already exists`,
      409
    );
  }

  if (error instanceof MongooseError.ValidationError) {
    const details = Object.values(error.errors).map((e) => e.message);
    log.debug(`Schema validation failed: ${details.join('; ')}`);
    return new AppError(`Validation failed: ${details.join('; ')}`, 422);
  }

  if (error instanceof MongooseError.CastError) {
    log.debug(`Cast failed for "${error.path}"`);
    return new AppError(`Invalid value for '${error.path}'`, 400);
  }

  log.error(`${message}: ${(error as Error)?.message}`, (error as Error)?.stack);
  return new AppError(message, 500);
};

interface DuplicateKeyError {
  code: number;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
}

const isDuplicateKey = (error: unknown): error is DuplicateKeyError =>
  Boolean(error) && (error as DuplicateKeyError).code === 11000;
