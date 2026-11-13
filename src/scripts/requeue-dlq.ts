// Retries every failed notification job and clears the dead-letter queue.
// Usage: npm run requeue-dlq   (fix the cause first, e.g. Expo credentials)
import { Queue } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createRedis } from '../redis.js';

const connection = createRedis('requeue');
const queue = new Queue(config.QUEUE_NAME, { connection });
const dlq = new Queue(config.DLQ_NAME, { connection });

(async () => {
  const failed = await queue.getFailed(0, 10_000);
  let retried = 0;
  for (const job of failed) {
    try {
      await job.retry();
      retried++;
    } catch (err) {
      logger.warn('could not retry job', { jobId: job.id, err });
    }
  }
  await dlq.obliterate({ force: true });
  logger.info('dead-letter queue re-driven', { retried, failedFound: failed.length });
})()
  .catch((err) => {
    logger.error('requeue failed', { err });
    process.exitCode = 1;
  })
  .finally(async () => {
    await queue.close();
    await dlq.close();
    connection.disconnect();
  });
