import { v7 as uuidv7 } from 'uuid';

/**
 * Every new record id is a UUIDv7.
 *
 * v7 leads with a millisecond timestamp, so ids sort in creation order and
 * index well — unlike v4 — while staying unguessable. Never derive an id from a
 * business value (the old product id WAS its SKU, so renaming a SKU broke every
 * reference to the product).
 */
export const newId = (): string => uuidv7();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuidV7 = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V7.test(value);
