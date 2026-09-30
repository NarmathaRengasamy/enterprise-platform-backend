import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /* The first run downloads a MongoDB binary for mongodb-memory-server. */
    testTimeout: 120_000,
    hookTimeout: 180_000,
    /* Each file gets its own process: tests set env vars (UPLOADS_DIR) before
       importing the app, and module state must not leak between files. */
    pool: 'forks',
    env: { NODE_ENV: 'test' },
  },
});
