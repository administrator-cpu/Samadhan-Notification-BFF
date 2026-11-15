import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createRedis } from '../redis.js';
import { closeApns, isApnsConfigured } from '../push/apns.js';
import { isFcmConfigured, warmFcm } from '../push/fcm.js';
import { processCallJob } from './processor.js';

/**
 * Separate queue + worker so a burst of ticket notifications never delays a ringing phone.
 * Jobs are short-lived: an invite is useless after the ring timeout, so retries are few and fast.
 */
export function startCallWorker() {
  const connection = createRedis('calls-worker');

  if (!isApnsConfigured()) logger.warn('APNs is not configured: iPhones will not ring for calls');
  if (!isFcmConfigured()) logger.warn('FCM is not configured: Android phones will not ring for calls');
  void warmFcm();

  const worker = new Worker(config.CALLS_QUEUE_NAME, async (job: Job) => processCallJob(job.data), {
    connection,
    concurrency: config.CALLS_WORKER_CONCURRENCY,
    stalledInterval: 15_000,
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1) || err?.name === 'UnrecoverableError';
    logger.error('call job failed', { jobId: job.id, type: job.name, attempt: job.attemptsMade, final, err });
  });
  worker.on('error', (err) => logger.error('call worker error', { err }));
  logger.info('call worker started', { queue: config.CALLS_QUEUE_NAME, concurrency: config.CALLS_WORKER_CONCURRENCY });

  return {
    worker,
    async close() {
      await worker.close();
      closeApns();
      connection.disconnect();
    },
  };
}
