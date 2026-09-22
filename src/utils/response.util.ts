import { Request } from 'express';

/**
 * Shared response/query helpers, ported from the NestJS service so both
 * backends answer in exactly the same shape.
 */

export interface ApiResponse<T> {
  success: true;
  message?: string;
  data: T;
}

export interface PaginatedResponse<T> {
  success: true;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  data: T[];
}

export const ok = <T>(data: T, message?: string): ApiResponse<T> =>
  message ? { success: true, message, data } : { success: true, data };

export const paginated = <T>(
  data: T[],
  total: number,
  page: number,
  limit: number
): PaginatedResponse<T> => ({
  success: true,
  total,
  page,
  limit,
  totalPages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
  data,
});

export interface PageParams {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Clamps paging from the query string.
 *
 * This is what closes the `page=0` hole: the old code ran `parseInt` straight
 * into `(page - 1) * limit`, so a zero or negative page produced a negative
 * offset and silently returned the wrong slice.
 */
export const getPageParams = (req: Request, defaultLimit = 20, maxLimit = 100): PageParams => {
  const rawPage = parseInt(String(req.query.page ?? ''), 10);
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;

  return { page, limit, skip: (page - 1) * limit };
};

/** Escapes regex metacharacters so a search for "c++" cannot blow up the query. */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive OR filter across the given fields. */
export const searchFilter = (search: string | undefined, fields: string[]): Record<string, unknown> => {
  if (!search || !search.trim()) return {};
  const rx = new RegExp(escapeRegex(search.trim()), 'i');
  return { $or: fields.map((field) => ({ [field]: rx })) };
};

/** Sorts only on whitelisted fields — raw query input is never interpolated. */
export const buildSort = (
  sortBy: unknown,
  sortOrder: unknown,
  allowed: string[],
  fallback: Record<string, 1 | -1> = { createdAt: -1 }
): Record<string, 1 | -1> => {
  const field = String(sortBy ?? '');
  if (!field || !allowed.includes(field)) return fallback;
  return { [field]: String(sortOrder) === 'asc' ? 1 : -1 };
};

/**
 * Collision-safe id with a module prefix.
 *
 * Replaces the old `prefix-${array.length + 1}` scheme, which reused a retired
 * id after a delete — for categories that silently re-pointed products.
 */
export const generateId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Applies paging to an already-filtered in-memory array. */
export const paginateArray = <T>(rows: T[], { skip, limit }: PageParams): T[] =>
  rows.slice(skip, skip + limit);
