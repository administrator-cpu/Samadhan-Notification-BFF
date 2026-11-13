// Usage: npm run send-test -- <userId> [message]
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { sendPush } from '../push/expo-client.js';
import { getTokensForUsers } from '../repo/tokens.js';
import { CHANNELS } from '../worker/messages.js';

const [userId, ...rest] = process.argv.slice(2);
if (!userId || !/^\d+$/.test(userId)) {
  console.error('Usage: npm run send-test -- <userId> [message]');
  process.exit(1);
}

(async () => {
  const tokens = await getTokensForUsers(pool, [userId]);
  if (tokens.length === 0) {
    logger.warn('user has no registered devices', { userId });
    return;
  }
  const tickets = await sendPush(
    tokens.map((t) => ({
      to: t.token,
      title: 'Samadhan test notification',
      body: rest.join(' ') || 'If you can read this, push delivery works.',
      priority: 'high' as const,
      channelId: CHANNELS.TICKET_UPDATES,
      sound: 'default' as const,
    })),
  );
  tickets.forEach((t, i) => logger.info('test push result', { deviceId: tokens[i]!.deviceId, platform: tokens[i]!.platform, result: t }));
})()
  .catch((err) => {
    logger.error('test push failed', { err });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
