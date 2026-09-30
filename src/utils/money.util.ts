import { AppError } from '../middlewares/errorHandler.js';

/**
 * Money is stored as whole minor units (paise) — never as a decimal.
 *
 * `0.1 + 0.2` is `0.30000000000000004` in floating point; summing prices as
 * rupees drifts, and a stored 1499.99 can read back as 1499.9899999. Integers
 * are exact, so every stored amount is `amount_minor` plus a `currency`.
 */

/** Rupees (as typed by a person) to paise. Rounds to the nearest paisa. */
export const toMinor = (major: number): number => {
  if (typeof major !== 'number' || !Number.isFinite(major)) {
    throw new AppError('Amount must be a finite number', 422);
  }
  /* Rounding the product, not the input: 1.005 * 100 is 100.49999999999999,
     so the epsilon nudge keeps half-paisa values rounding the way a person expects. */
  return Math.round((major + Number.EPSILON * Math.sign(major)) * 100);
};

/** Paise to rupees, for display or for a client that has not moved to minor units yet. */
export const fromMinor = (minor: number): number => {
  assertMinor(minor, true);
  return minor / 100;
};

/**
 * Guards a value that is about to be stored as money.
 *
 * `allowNegative` exists for deltas (a refund, a price reduction); stored prices
 * are never negative.
 */
export function assertMinor(minor: unknown, allowNegative = false): asserts minor is number {
  if (typeof minor !== 'number' || !Number.isInteger(minor)) {
    throw new AppError('Amount must be a whole number of minor units (paise)', 422);
  }
  if (!allowNegative && minor < 0) {
    throw new AppError('Amount cannot be negative', 422);
  }
  if (!Number.isSafeInteger(minor)) {
    throw new AppError('Amount is too large', 422);
  }
}
