import type { Server } from 'node:http';
import { config } from './config.js';
import { pool } from './db.js';
import { logger } from './logger.js';
import { createApp } from './api/server.js';
import { startScheduler } from './jobs/scheduler.js';
import { runMigrations } from './scripts/migrate-lib.js';
import { startWorker } from './worker/worker.js';
import { startCallWorker } from './calls/worker.js';

async function main() {
  if (config.MIGRATE_ON_START) await runMigrations();

  const closers: Array<() => Promise<void> | void> = [];

  if (config.RUN_API) {
    const api = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = api.app.listen(config.PORT, config.HOST, () => resolve(s));
    });
    logger.info('token API listening', { host: config.HOST, port: config.PORT });
    closers.push(() => new Promise<void>((r) => server.close(() => r())), api.close);
  }

  if (config.RUN_WORKER) {
    const calls = startCallWorker();
    closers.push(calls.close);
    const worker = startWorker();
    const scheduler = startScheduler();
    closers.push(() => scheduler.stop(), worker.close);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 15_000);
    try {
      for (const close of closers) await close();
      await pool.end();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', { err });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // PM2 on Windows sends a 'shutdown' message instead of signals.
  process.on('message', (msg) => {
    if (msg === 'shutdown') shutdown('pm2-shutdown');
  });
}

process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));

main().catch((err) => {
  logger.error('startup failed', { err });
  process.exit(1);
});
