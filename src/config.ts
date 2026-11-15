import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().default('127.0.0.1'),

  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().default('samadhandb'),
  POSTGRES_USER: z.string().default('postgres'),
  POSTGRES_PASSWORD: z.string().default(''),
  POSTGRES_SSL: bool(false),
  PG_POOL_MAX: z.coerce.number().int().positive().default(5),

  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().default(''),

  // Must equal the backend's JWT_SECRET (access tokens are verified here).
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  // Reject access tokens whose session is revoked/expired or whose user is inactive.
  AUTH_CHECK_SESSION: bool(true),

  EXPO_ACCESS_TOKEN: z.string().default(''),
  EXPO_API_URL: z.string().url().default('https://exp.host/--/api/v2'),

  QUEUE_NAME: z.string().default('notifications'),
  DLQ_NAME: z.string().default('notifications-dlq'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),

  RECEIPT_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(300),
  MAINTENANCE_INTERVAL_SEC: z.coerce.number().int().positive().default(6 * 3600),
  LEGACY_TOKEN_SYNC_INTERVAL_SEC: z.coerce.number().int().min(0).default(600),
  STALE_TOKEN_DAYS: z.coerce.number().int().positive().default(90),
  DELIVERY_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  PROCESSED_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DLQ_ALERT_THRESHOLD: z.coerce.number().int().min(0).default(1),

  // Calls (Track 3): high-priority queue, delivered directly through APNs (VoIP) and FCM v1.
  CALLS_QUEUE_NAME: z.string().default('calls'),
  CALLS_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  CALL_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  // APNs token auth (.p8). Provide the key as a file path or inline PEM (\n escaped allowed).
  APNS_KEY_ID: z.string().default(''),
  APNS_TEAM_ID: z.string().default(''),
  APNS_KEY_PATH: z.string().default(''),
  APNS_KEY: z.string().default(''),
  APNS_BUNDLE_ID: z.string().default(''),
  // production | sandbox | auto (production first, sandbox on BadDeviceToken: dev-client builds use sandbox tokens).
  APNS_ENV: z.enum(['production', 'sandbox', 'auto']).default('auto'),
  // Tests only: send every APNs request to this origin instead of Apple.
  APNS_ORIGIN_OVERRIDE: z.string().default(''),

  // FCM HTTP v1. Service account JSON as a file path or inline JSON.
  FCM_SERVICE_ACCOUNT_PATH: z.string().default(''),
  FCM_SERVICE_ACCOUNT_JSON: z.string().default(''),
  FCM_PROJECT_ID: z.string().default(''),
  FCM_API_URL: z.string().url().default('https://fcm.googleapis.com'),

  MIGRATE_ON_START: bool(true),
  // Run the token API and the queue worker in this process. Set one false to split them later.
  RUN_API: bool(true),
  RUN_WORKER: bool(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
