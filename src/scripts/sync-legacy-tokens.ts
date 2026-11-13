import { pool } from '../db.js';
import { logger } from '../logger.js';
import { syncLegacyTokens } from '../jobs/legacy-tokens.js';

syncLegacyTokens()
  .then((r) => logger.info('legacy tokens synced', r))
  .catch((err) => {
    logger.error('legacy token sync failed', { err });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
