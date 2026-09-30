import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is acting on the current request.
 *
 * Set once by `authenticateJWT` and readable anywhere below it — a service or a
 * Mongoose hook — without threading `req` through every call. That is what lets
 * the base schema plugin stamp created_by / updated_by on its own.
 */
export interface RequestContext {
  user_id: string;
  role: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

/** The acting user's id, or `system` for work done outside a request (scripts, boot). */
export const currentUserId = (): string => storage.getStore()?.user_id ?? 'system';
