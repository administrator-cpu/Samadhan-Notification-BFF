import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type FcmResult =
  | { ok: true; messageId: string | null }
  | { ok: false; status: number; code: string; message: string; retryable: boolean };

export interface FcmSendOptions {
  ttlSec: number;
  collapseKey?: string;
}

/** Token is gone for good: remove it. */
export const FCM_DEAD_CODES = new Set(['UNREGISTERED', 'INVALID_REGISTRATION_TOKEN']);

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

let account: ServiceAccount | null | undefined;
let accessToken: { value: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

function loadAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  const raw = config.FCM_SERVICE_ACCOUNT_JSON || (config.FCM_SERVICE_ACCOUNT_PATH ? readFileSync(config.FCM_SERVICE_ACCOUNT_PATH, 'utf8') : '');
  if (!raw) return (account = null);
  const parsed = JSON.parse(raw) as ServiceAccount;
  if (!parsed.client_email || !parsed.private_key) throw new Error('FCM service account JSON is missing client_email/private_key');
  return (account = parsed);
}

export function isFcmConfigured(): boolean {
  try {
    return !!loadAccount();
  } catch (err) {
    logger.error('FCM service account could not be loaded', { err });
    return false;
  }
}

function projectId(): string {
  return config.FCM_PROJECT_ID || loadAccount()!.project_id;
}

async function fetchAccessToken(): Promise<string> {
  const sa = loadAccount()!;
  const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(config.CALL_PROVIDER_TIMEOUT_MS),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    throw new Error(`FCM OAuth token request failed: HTTP ${res.status} ${json?.error ?? ''} ${json?.error_description ?? ''}`.trim());
  }
  accessToken = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in ?? 3600) - 120) * 1000 };
  return accessToken.value;
}

async function getAccessToken(force = false): Promise<string> {
  if (!force && accessToken && Date.now() < accessToken.expiresAt) return accessToken.value;
  tokenInFlight ??= fetchAccessToken().finally(() => {
    tokenInFlight = null;
  });
  return tokenInFlight;
}

/** Warms the OAuth token at startup so the first call does not pay for it. */
export async function warmFcm(): Promise<void> {
  if (isFcmConfigured()) await getAccessToken().catch((err) => logger.error('FCM token warm-up failed', { err }));
}

/** Sends one high-priority data-only message. Values must be strings (FCM rule). */
export async function sendFcmData(token: string, data: Record<string, string>, opts: FcmSendOptions, retried = false): Promise<FcmResult> {
  let bearer: string;
  try {
    bearer = await getAccessToken(retried);
  } catch (err) {
    return { ok: false, status: 0, code: 'AUTH', message: (err as Error).message, retryable: true };
  }

  const body = {
    message: {
      token,
      data,
      android: {
        priority: 'HIGH',
        ttl: `${Math.max(0, Math.floor(opts.ttlSec))}s`,
        ...(opts.collapseKey ? { collapse_key: opts.collapseKey } : {}),
      },
    },
  };

  let res: Response;
  try {
    res = await fetch(`${config.FCM_API_URL}/v1/projects/${projectId()}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.CALL_PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, code: 'NETWORK', message: (err as Error).message, retryable: true };
  }

  const json: any = await res.json().catch(() => null);
  if (res.ok) return { ok: true, messageId: json?.name ?? null };

  if (res.status === 401 && !retried) return sendFcmData(token, data, opts, true);

  const detailCode: string | undefined = json?.error?.details?.find((d: any) => d?.errorCode)?.errorCode;
  const status: string = json?.error?.status ?? '';
  const message: string = json?.error?.message ?? `HTTP ${res.status}`;
  // An unknown/invalid token comes back as UNREGISTERED, or INVALID_ARGUMENT mentioning the registration token.
  const code =
    detailCode === 'INVALID_ARGUMENT' && /registration token/i.test(message) ? 'INVALID_REGISTRATION_TOKEN' : detailCode ?? (status || `HTTP_${res.status}`);
  if (code === 'SENDER_ID_MISMATCH' || code === 'THIRD_PARTY_AUTH_ERROR') {
    logger.error('FCM credentials problem: service account project does not match the app', { code, message });
  }
  const retryable = res.status === 429 || res.status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL' || code === 'QUOTA_EXCEEDED';
  return { ok: false, status: res.status, code, message, retryable };
}
