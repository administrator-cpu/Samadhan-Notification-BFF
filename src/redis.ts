import { Redis, type RedisOptions } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const redisOptions: RedisOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // required by BullMQ workers
};

export function createRedis(name: string): Redis {
  const client = new Redis(redisOptions);
  client.on('error', (err) => logger.error('redis error', { connection: name, err }));
  return client;
}
