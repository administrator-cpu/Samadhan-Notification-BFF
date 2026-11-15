import express, { type NextFunction, type Request, type Response } from 'express';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { createRedis } from '../redis.js';
import { isExpoPushToken } from '../push/expo-client.js';
import { isApnsConfigured } from '../push/apns.js';
import { isFcmConfigured } from '../push/fcm.js';
import { getPreferences, getUnreadCounts, markTicketRead, setPreferences } from '../repo/state.js';
import { registerToken, removeDeviceTokens } from '../repo/tokens.js';
import { EVENT_TYPES } from '../contract.js';
import { requireAuth } from './auth.js';

const registerSchema = z
  .object({
    token: z.string().min(10).max(512),
    kind: z.enum(['expo', 'fcm', 'apns_voip']).default('expo'),
    platform: z.enum(['ios', 'android']),
    deviceId: z.string().min(8).max(128),
    appVersion: z.string().max(32).optional().nullable(),
  })
  .refine((v) => v.kind !== 'expo' || isExpoPushToken(v.token), { message: 'Not a valid Expo push token', path: ['token'] })
  .refine((v) => v.kind !== 'apns_voip' || (v.platform === 'ios' && /^[0-9a-fA-F]{64,200}$/.test(v.token)), {
    message: 'Not a valid PushKit VoIP token',
    path: ['token'],
  })
  .refine((v) => v.kind !== 'fcm' || (v.platform === 'android' && /^[\w\-:.]{100,}$/.test(v.token)), {
    message: 'Not a valid FCM registration token',
    path: ['token'],
  })
  .transform((v) => (v.kind === 'apns_voip' ? { ...v, token: v.token.toLowerCase() } : v));

const removeSchema = z
  .object({
    deviceId: z.string().min(1).max(128).optional().nullable(),
    token: z.string().min(1).max(512).optional().nullable(),
  })
  .refine((v) => !!v.deviceId || !!v.token, { message: 'deviceId or token is required' });

const readSchema = z.object({ ticketId: z.union([z.string().regex(/^\d+$/), z.number().int()]).transform(String).optional().nullable() });

const prefsSchema = z.object({ disabledEvents: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length) });

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function badRequest(res: Response, err: z.ZodError) {
  return res.status(400).json({ success: false, message: 'Validation failed', errors: z.flattenError(err).fieldErrors });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // behind nginx on the same host
  app.use(express.json({ limit: '16kb' }));

  const healthRedis = createRedis('health');
  const queue = new Queue(config.QUEUE_NAME, { connection: healthRedis });
  const callsQueue = new Queue(config.CALLS_QUEUE_NAME, { connection: healthRedis });
  const dlq = new Queue(config.DLQ_NAME, { connection: healthRedis });

  app.get('/health', wrap(async (_req, res) => {
    const checks: Record<string, unknown> = {};
    let ok = true;
    try {
      await pool.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (err) {
      ok = false;
      checks.postgres = (err as Error).message;
    }
    try {
      await healthRedis.ping();
      checks.redis = 'ok';
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      const deadLetters = await dlq.count();
      checks.queue = counts;
      checks.callsQueue = await callsQueue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      checks.callProviders = { apns: isApnsConfigured(), fcm: isFcmConfigured() };
      checks.deadLetters = deadLetters;
      if (deadLetters >= config.DLQ_ALERT_THRESHOLD && config.DLQ_ALERT_THRESHOLD > 0) checks.alert = 'dead-letter queue has jobs';
    } catch (err) {
      ok = false;
      checks.redis = (err as Error).message;
    }
    res.status(ok ? 200 : 503).json({ status: ok ? (checks.alert ? 'degraded' : 'ok') : 'down', uptimeSec: Math.round(process.uptime()), checks });
  }));

  const v1 = express.Router();
  v1.use(requireAuth);

  v1.post('/devices/register', wrap(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const row = await registerToken({ ...parsed.data, appVersion: parsed.data.appVersion ?? null, userId: req.auth!.userId });
    res.json({ success: true, data: { id: row.id, deviceId: row.deviceId, kind: row.kind } });
  }));

  v1.post('/devices/remove', wrap(async (req, res) => {
    const parsed = removeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const removed = await removeDeviceTokens(pool, req.auth!.userId, parsed.data.deviceId ?? null, parsed.data.token ?? null);
    res.json({ success: true, data: { removed } });
  }));

  v1.get('/unread-count', wrap(async (req, res) => {
    const counts = await getUnreadCounts(pool, [req.auth!.userId]);
    res.json({ success: true, data: { count: counts.get(req.auth!.userId) ?? 0 } });
  }));

  v1.post('/read', wrap(async (req, res) => {
    const parsed = readSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    await markTicketRead(pool, req.auth!.userId, parsed.data.ticketId ?? null);
    const counts = await getUnreadCounts(pool, [req.auth!.userId]);
    res.json({ success: true, data: { count: counts.get(req.auth!.userId) ?? 0 } });
  }));

  v1.get('/preferences', wrap(async (req, res) => {
    res.json({ success: true, data: await getPreferences(pool, req.auth!.userId) });
  }));

  v1.put('/preferences', wrap(async (req, res) => {
    const parsed = prefsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    await setPreferences(pool, req.auth!.userId, parsed.data.disabledEvents);
    res.json({ success: true, data: parsed.data });
  }));

  app.use('/v1', v1);

  app.use((_req, res) => res.status(404).json({ success: false, message: 'Not found' }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Malformed JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Payload too large' });
    logger.error('request failed', { err });
    res.status(500).json({ success: false, message: 'Internal error' });
  });

  return {
    app,
    async close() {
      await queue.close();
      await callsQueue.close();
      await dlq.close();
      healthRedis.disconnect();
    },
  };
}
