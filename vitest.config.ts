import fs from 'node:fs';
import { defineConfig } from 'vitest/config';

/* mongodb-memory-server downloads a ~600 MB MongoDB binary on first use. When
   MongoDB is already installed locally, use that binary instead — no download,
   and no stale half-finished download to wait on. Override with
   MONGOMS_SYSTEM_BINARY; other machines fall back to the download. */
const LOCAL_MONGOD = 'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe';
const systemBinary =
  process.env.MONGOMS_SYSTEM_BINARY || (fs.existsSync(LOCAL_MONGOD) ? LOCAL_MONGOD : undefined);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    /* Each file gets its own process: tests set env vars (UPLOADS_DIR) before
       importing the app, and module state must not leak between files. */
    pool: 'forks',
    /* Most files start their own mongod (one a replica set); too many at once
       and a start-up misses mongodb-memory-server's 10 s launch limit. */
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
    env: {
      NODE_ENV: 'test',
      ...(systemBinary ? { MONGOMS_SYSTEM_BINARY: systemBinary } : {}),
    },
  },
});
