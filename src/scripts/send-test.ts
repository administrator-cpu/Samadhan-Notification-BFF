// Usage: npm run send-test -- <userId> [message]
// Only devices that are still logged in (same rule as real notifications). Add --all to ignore that.
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { sendPush } from '../push/expo-client.js';
import { getDeliverableTokens, getTokensForUsers } from '../repo/tokens.js';
import { CHANNELS } from '../worker/messages.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const [userId, ...rest] = args.filter((a) => a !== '--all');
if (!userId || !/^\d+$/.test(userId)) {
  console.error('Usage: npm run send-test -- <userId> [message]');
  process.exit(1);
}

(async () => {
  const tokens = all ? await getTokensForUsers(pool, [userId]) : await getDeliverableTokens(pool, [userId]);
  if (tokens.length === 0) {
    logger.warn(all ? 'user has no registered devices' : 'user has no logged-in devices (use --all to include logged-out ones)', { userId });
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
