import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// bigint ids come back as strings; keep them as strings end to end.
export const pool = new pg.Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  ssl: config.POSTGRES_SSL ? { rejectUnauthorized: false } : undefined,
  max: config.PG_POOL_MAX,
  application_name: 'samadhan-notification-service',
});

pool.on('error', (err) => logger.error('postgres pool error', { err }));

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
