// Usage: npm run send-test-call -- <userId> [invite|cancel] [callId]
// Rings (or stops ringing) every iOS/Android device of the user directly through APNs/FCM.
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { closeApns } from '../push/apns.js';
import { processCallJob } from '../calls/processor.js';

const [userId, mode = 'invite', callIdArg] = process.argv.slice(2);
if (!userId || !/^\d+$/.test(userId) || !['invite', 'cancel'].includes(mode)) {
  console.error('Usage: npm run send-test-call -- <userId> [invite|cancel] [callId]');
  process.exit(1);
}

const ttlSec = mode === 'invite' ? 45 : 60;
const callId = callIdArg || `test-${Date.now()}`;

(async () => {
  const result = await processCallJob({
    version: 1,
    jobId: randomUUID(),
    type: mode === 'invite' ? 'call_invite' : 'call_cancel',
    toEmail: 'test@invalid',
    toUserId: userId,
    callId,
    callerName: 'Samadhan test call',
    reason: mode === 'cancel' ? 'caller_cancelled' : null,
    ttlSec,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
  });
  logger.info('test call result', { callId, mode, result });
  if (mode === 'invite') console.log(`Stop it with: npm run send-test-call -- ${userId} cancel ${callId}`);
})()
  .catch((err) => {
    logger.error('test call failed', { err });
    process.exitCode = 1;
  })
  .finally(async () => {
    closeApns();
    await pool.end();
  });
