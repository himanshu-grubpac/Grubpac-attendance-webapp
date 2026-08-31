/* Start the API server with an in-memory DB, seeded, on port 5000 —
   mirrors scripts/verify-api.mjs but binds the standard dev port. */
process.env.USE_MEMORY_DB = 'true';
process.env.PORT = '5000';
process.env.NODE_ENV = 'development';

const { startServer } = await import('./src/index.js');
const { seedDatabase } = await import('./src/seed.js');

await seedDatabase();
const server = await startServer();
console.log(`[dev-server] seeded + listening on http://localhost:${process.env.PORT}`);

const shutdown = async () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
