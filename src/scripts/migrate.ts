import { pool } from '../db.js';
import { logger } from '../logger.js';
import { runMigrations } from './migrate-lib.js';

runMigrations()
  .then((applied) => logger.info('migrations complete', { applied }))
  .catch((err) => {
    logger.error('migrations failed', { err });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
