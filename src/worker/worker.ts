import { Queue, Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createRedis } from '../redis.js';
import { processEvent } from './processor.js';

export function startWorker() {
  const connection = createRedis('worker');
  const dlqConnection = createRedis('dlq');
  const dlq = new Queue(config.DLQ_NAME, { connection: dlqConnection });

  const worker = new Worker(config.QUEUE_NAME, async (job: Job) => processEvent(job.data), {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= maxAttempts || err?.name === 'UnrecoverableError';
    logger.error('notification job failed', {
      jobId: job.id,
      eventType: job.name,
      attempt: job.attemptsMade,
      maxAttempts,
      final: exhausted,
      err,
    });
    if (!exhausted) return;
    await dlq
      .add(job.name, { event: job.data, failedReason: err?.message ?? 'unknown', failedAt: new Date().toISOString() }, {
        jobId: job.id,
        removeOnComplete: true,
      })
      .catch((e) => logger.error('could not move job to dead-letter queue', { jobId: job.id, err: e }));
  });

  worker.on('error', (err) => logger.error('worker error', { err }));
  logger.info('worker started', { queue: config.QUEUE_NAME, concurrency: config.WORKER_CONCURRENCY });

  return {
    worker,
    dlq,
    async close() {
      await worker.close();
      await dlq.close();
      dlqConnection.disconnect();
      connection.disconnect();
    },
  };
}
