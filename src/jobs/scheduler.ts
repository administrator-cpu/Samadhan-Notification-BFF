import { config } from '../config.js';
import { logger } from '../logger.js';
import { syncLegacyTokens } from './legacy-tokens.js';
import { runMaintenance } from './maintenance.js';
import { pollReceipts } from './receipts.js';

type Task = { name: string; everySec: number; run: () => Promise<unknown> };

export function startScheduler() {
  const tasks: Task[] = [
    { name: 'receipts', everySec: config.RECEIPT_POLL_INTERVAL_SEC, run: pollReceipts },
    { name: 'maintenance', everySec: config.MAINTENANCE_INTERVAL_SEC, run: runMaintenance },
  ];
  if (config.LEGACY_TOKEN_SYNC_INTERVAL_SEC > 0) {
    tasks.push({ name: 'legacy-token-sync', everySec: config.LEGACY_TOKEN_SYNC_INTERVAL_SEC, run: syncLegacyTokens });
  }

  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();

  const exec = async (t: Task) => {
    if (running.has(t.name)) return; // never overlap the same task
    running.add(t.name);
    try {
      const result = await t.run();
      logger.info('scheduled task done', { task: t.name, result });
    } catch (err) {
      logger.error('scheduled task failed', { task: t.name, err });
    } finally {
      running.delete(t.name);
    }
  };

  for (const t of tasks) {
    timers.push(setTimeout(() => exec(t), 5_000));
    timers.push(setInterval(() => exec(t), t.everySec * 1000));
  }

  return {
    stop() {
      timers.forEach((t) => clearTimeout(t));
    },
  };
}
