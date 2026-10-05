import mongoose, { ClientSession } from 'mongoose';
import { createLogger } from './logger.js';

const log = createLogger('Transactions');

/**
 * Several writes that must succeed or fail together (a product, its items and
 * their stock rows).
 *
 * On a replica set they run in a real MongoDB transaction. A standalone server
 * (local development) cannot run transactions, so the same writes run in order
 * and each registers an `undo`; if a later step fails, the undo steps run in
 * reverse and the error is re-thrown — nothing half-written is left behind.
 * Production must run a replica set (Release checklist).
 */

export interface Tx {
  /** Pass to every write: `{ session: tx.session }`. Undefined on a standalone server. */
  session?: ClientSession;
  /** Registers how to reverse a write if a later step fails (standalone only; ignored in a transaction). */
  undo(fn: () => Promise<unknown>): void;
}

let supported: boolean | undefined;

/** True when the connected server can run transactions (a replica set or sharded cluster). */
export const transactionsSupported = async (): Promise<boolean> => {
  if (supported !== undefined) return supported;
  const db = mongoose.connection.db;
  if (!db) return false;
  try {
    const hello = await db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    supported = false;
  }
  return supported;
};

/** For tests that switch servers within one process. */
export const resetTransactionSupport = (): void => {
  supported = undefined;
};

/** Logged once at start-up, so a standalone database is never a surprise. */
export const warnIfTransactionsUnavailable = async (): Promise<void> => {
  if (!mongoose.connection.db) return;
  if (await transactionsSupported()) {
    log.log('MongoDB supports transactions (replica set)');
  } else {
    log.warn(
      'MongoDB is standalone — transactions are unavailable. Product writes fall back to ordered writes with ' +
        'automatic clean-up on failure. Run a replica set in production.'
    );
  }
};

export const withTransaction = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
  if (await transactionsSupported()) {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn({ session, undo: () => undefined });
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  const undos: (() => Promise<unknown>)[] = [];
  try {
    return await fn({ session: undefined, undo: (u) => undos.push(u) });
  } catch (error) {
    for (const u of undos.reverse()) {
      try {
        await u();
      } catch (cleanup) {
        log.error(`Clean-up after a failed write did not complete: ${(cleanup as Error).message}`);
      }
    }
    throw error;
  }
};
