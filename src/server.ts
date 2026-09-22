import { createApp } from './app.js';
import { config } from './config/index.js';
import { connectDB, disconnectDB } from './config/db.js';
import { runMigrations } from './data/migrations.js';

const startServer = async () => {
  // Attempt to connect to local/configured MongoDB
  await connectDB();
  /* No auto-seeding. Re-inserting demo rows whenever a collection reached zero
     meant a collection you had deliberately emptied filled itself back up on
     the next restart. Run `npm run seed` to load the demo data on purpose. */
  /* Repairs unusable password hashes and backfills the categoryId foreign key.
     Both are idempotent and safe to run on every boot. */
  await runMigrations();

  const app = createApp();

  const server = app.listen(config.port, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Perfox Enterprise Platform Backend is running!`);
    console.log(`📡 URL: http://localhost:${config.port}`);
    console.log(`🩺 Health check: http://localhost:${config.port}/api/health`);
    console.log(`🌍 Environment: ${config.nodeEnv}`);
    console.log(`🗄️  MongoDB URI: ${config.mongodbUri}`);
    console.log(`=======================================================`);
  });

  // Handle graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    console.log(`Received ${signal}. Gracefully shutting down...`);
    await disconnectDB();
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
};

startServer().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
