import { describe, expect, it } from 'vitest';
import { isUuidV7, newId } from '../../src/utils/id.util.js';

describe('id.util', () => {
  it('produces a UUIDv7', () => {
    const id = newId();
    expect(id).toHaveLength(36);
    expect(id[14]).toBe('7');
    expect(isUuidV7(id)).toBe(true);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });

  it('sorts in creation order', async () => {
    const first = newId();
    await new Promise((r) => setTimeout(r, 5));
    const second = newId();
    expect(first < second).toBe(true);
  });

  it('rejects non-v7 values', () => {
    expect(isUuidV7('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(false); // v4
    expect(isUuidV7('PROD001')).toBe(false);
    expect(isUuidV7(undefined)).toBe(false);
  });
});
