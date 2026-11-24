import { UnrecoverableError } from 'bullmq';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { APNS_DEAD_REASONS, isApnsConfigured, sendVoipPush } from '../push/apns.js';
import { FCM_DEAD_CODES, isFcmConfigured, sendFcmData } from '../push/fcm.js';
import { deliver, type Outgoing, type SendSummary } from '../push/sender.js';
import { getAlreadySentTokens } from '../repo/state.js';
import { getTokensForDelivery, pruneDeadTokens, type DeviceToken } from '../repo/tokens.js';
import { CHANNELS } from '../worker/messages.js';
import { callJobSchema, callPayload, CALL_SUPPORTED_VERSIONS, type CallJob } from './contract.js';
import { logCallDeliveries, resolveUserId, type CallDeliveryRow } from './repo.js';

export class RetryableCallError extends Error {
  override name = 'RetryableCallError';
}

export interface CallProcessResult {
  status: 'sent' | 'expired' | 'no_user' | 'no_devices' | 'duplicate';
  sent: number;
  failed: number;
  pruned: number;
  skipped: number;
}

const EVENT_TYPE: Record<CallJob['type'], string> = {
  call_invite: 'call.invite',
  call_cancel: 'call.cancel',
  call_missed: 'call.missed',
};

const empty = (status: CallProcessResult['status']): CallProcessResult => ({ status, sent: 0, failed: 0, pruned: 0, skipped: 0 });

export function parseCallJob(data: unknown): CallJob {
  const parsed = callJobSchema.safeParse(data);
  if (!parsed.success) throw new UnrecoverableError(`Invalid call job: ${parsed.error.message}`);
  if (!CALL_SUPPORTED_VERSIONS.includes(parsed.data.version)) {
    throw new UnrecoverableError(`Unsupported call contract version ${parsed.data.version}`);
  }
  return parsed.data;
}

function expiresAtMs(job: CallJob): number {
  return Date.parse(job.expiresAt) || Date.parse(job.createdAt) + job.ttlSec * 1000;
}

type Attempt = { row: CallDeliveryRow; dead: boolean; retryable: boolean };

async function sendNative(job: CallJob, userId: string, tokens: DeviceToken[]): Promise<Attempt[]> {
  const payload = callPayload(job);
  const expMs = expiresAtMs(job);
  const ttlSec = Math.max(1, Math.ceil((expMs - Date.now()) / 1000));
  const eventType = EVENT_TYPE[job.type];
  const apnsReady = isApnsConfigured();
  const fcmReady = isFcmConfigured();

  return Promise.all(
    tokens.map(async (t): Promise<Attempt> => {
      const base = {
        jobId: job.jobId,
        eventType,
        ticketId: job.ticketId,
        callId: job.callId,
        userId,
        deviceTokenId: t.id,
        token: t.token,
      };

      if (t.kind === 'apns_voip') {
        if (!apnsReady) {
          return { row: { ...base, provider: 'apns', status: 'failed', providerMessageId: null, error: 'APNs not configured' }, dead: false, retryable: false };
        }
        const r = await sendVoipPush(t.token, payload, { expiration: Math.floor(expMs / 1000), priority: 10 });
        if (r.ok) return { row: { ...base, provider: 'apns', status: 'sent', providerMessageId: r.apnsId, error: null }, dead: false, retryable: false };
        return {
          row: { ...base, provider: 'apns', status: 'failed', providerMessageId: r.apnsId, error: `${r.env} ${r.status} ${r.reason}` },
          dead: APNS_DEAD_REASONS.has(r.reason),
          retryable: r.retryable,
        };
      }

      if (!fcmReady) {
        return { row: { ...base, provider: 'fcm', status: 'failed', providerMessageId: null, error: 'FCM not configured' }, dead: false, retryable: false };
      }
      // `body` mirrors Expo's FCM layout so expo-notifications exposes the same data object to JS.
      const r = await sendFcmData(t.token, { ...payload, body: JSON.stringify(payload) }, { ttlSec });
      if (r.ok) return { row: { ...base, provider: 'fcm', status: 'sent', providerMessageId: r.messageId, error: null }, dead: false, retryable: false };
      return {
        row: { ...base, provider: 'fcm', status: 'failed', providerMessageId: null, error: `${r.status} ${r.code}: ${r.message}`.slice(0, 500) },
        dead: FCM_DEAD_CODES.has(r.code),
        retryable: r.retryable,
      };
    }),
  );
}

async function sendMissedCall(job: CallJob, userId: string): Promise<SendSummary> {
  const tokens = await getTokensForDelivery(pool, [userId], 'expo');
  const caller = job.callerName || 'Someone';
  const outgoing: Outgoing[] = tokens.map((token) => ({
    userId,
    token,
    message: {
      to: token.token,
      title: 'Missed call',
      body: job.ticketNumber ? `${caller} · Ticket #${job.ticketNumber}` : `Missed call from ${caller}`,
      data: { type: 'call_missed', callId: job.callId, ticketId: job.ticketId, ticketNo: job.ticketNumber },
      priority: 'high',
      channelId: CHANNELS.MISSED_CALL,
      sound: 'default',
      tag: `call_${job.callId}`,
      threadId: 'missed_calls',
    },
  }));
  return deliver(job.jobId, EVENT_TYPE.call_missed, job.ticketId && /^\d+$/.test(job.ticketId) ? job.ticketId : null, outgoing);
}

export async function processCallJob(raw: unknown): Promise<CallProcessResult> {
  const job = parseCallJob(raw);
  const log = { jobId: job.jobId, type: job.type, callId: job.callId };

  if (job.type === 'call_invite' && Date.now() >= expiresAtMs(job)) {
    logger.warn('call invite expired before delivery; dropped', log);
    return empty('expired');
  }

  const userId = await resolveUserId(pool, job.toUserId, job.toEmail);
  if (!userId) {
    logger.warn('call recipient not found or inactive', { ...log, toEmail: job.toEmail });
    return empty('no_user');
  }

  if (job.type === 'call_missed') {
    const summary = await sendMissedCall(job, userId);
    logger.info('missed-call notification', { ...log, userId, ...summary });
    return { status: summary.sent || summary.skipped ? 'sent' : 'no_devices', ...summary };
  }

  const tokens = [
    ...(await getTokensForDelivery(pool, [userId], 'apns_voip')),
    ...(await getTokensForDelivery(pool, [userId], 'fcm')),
  ].filter((t) => !(job.type === 'call_cancel' && job.excludeDeviceId && t.deviceId === job.excludeDeviceId));
  if (tokens.length === 0) {
    logger.warn('no VoIP/FCM tokens for call recipient', { ...log, userId });
    return empty('no_devices');
  }

  const already = await getAlreadySentTokens(pool, job.jobId);
  const todo = tokens.filter((t) => !already.has(t.token));
  const skipped = tokens.length - todo.length;
  if (todo.length === 0) return { ...empty('duplicate'), skipped };

  const attempts = await sendNative(job, userId, todo);
  await logCallDeliveries(pool, attempts.map((a) => a.row));

  const dead = attempts.filter((a) => a.dead).map((a) => a.row.token);
  const pruned = dead.length ? await pruneDeadTokens(dead, 'CallProviderRejected') : 0;
  const sent = attempts.filter((a) => a.row.status === 'sent').length;
  const failed = attempts.length - sent;

  const result: CallProcessResult = { status: 'sent', sent, failed, pruned, skipped };
  logger.info('call push', {
    ...log,
    userId,
    ...result,
    devices: attempts.map((a) => ({ provider: a.row.provider, status: a.row.status, error: a.row.error })),
  });

  // A provider hiccup might clear: let BullMQ retry. Devices that already got it are skipped on the next attempt.
  if (attempts.some((a) => a.retryable && a.row.status === 'failed')) {
    throw new RetryableCallError(`call push failed on ${failed} device(s); will retry`);
  }
  return result;
}
