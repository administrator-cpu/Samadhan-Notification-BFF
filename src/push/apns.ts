import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { logger } from '../logger.js';

type ApnsEnv = 'production' | 'sandbox';

const HOSTS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

export type ApnsResult =
  | { ok: true; env: ApnsEnv; apnsId: string | null }
  | { ok: false; env: ApnsEnv; apnsId: string | null; status: number; reason: string; retryable: boolean };

export interface ApnsSendOptions {
  /** Unix seconds. 0 = deliver once or drop. */
  expiration: number;
  priority?: 5 | 10;
  collapseId?: string;
}

/** Device token is gone for good: remove it. (DeviceTokenNotForTopic means our bundle id is wrong, not the token.) */
export const APNS_DEAD_REASONS = new Set(['Unregistered', 'BadDeviceToken', 'ExpiredToken']);

function loadKey(): string {
  if (config.APNS_KEY) return config.APNS_KEY.replace(/\\n/g, '\n');
  if (config.APNS_KEY_PATH) return readFileSync(config.APNS_KEY_PATH, 'utf8');
  return '';
}

let signingKey: string | null = null;
let providerToken: { value: string; issuedAt: number } | null = null;
const TOKEN_REFRESH_MS = 40 * 60 * 1000; // Apple: refresh between 20 and 60 minutes

export function isApnsConfigured(): boolean {
  return !!(config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_BUNDLE_ID && (config.APNS_KEY || config.APNS_KEY_PATH));
}

function getProviderToken(force = false): string {
  if (!force && providerToken && Date.now() - providerToken.issuedAt < TOKEN_REFRESH_MS) return providerToken.value;
  signingKey ??= loadKey();
  const value = jwt.sign({ iss: config.APNS_TEAM_ID }, signingKey, { algorithm: 'ES256', keyid: config.APNS_KEY_ID });
  providerToken = { value, issuedAt: Date.now() };
  return value;
}

class Http2Client {
  private session: http2.ClientHttp2Session | null = null;

  constructor(private readonly origin: string) {}

  private get(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const s = http2.connect(this.origin);
    s.on('error', (err) => logger.warn('apns session error', { origin: this.origin, err }));
    s.on('goaway', () => s.close());
    s.on('close', () => {
      if (this.session === s) this.session = null;
    });
    s.setTimeout(60 * 60 * 1000, () => s.close()); // idle sessions are dropped by Apple anyway
    s.unref();
    this.session = s;
    return s;
  }

  reset() {
    this.session?.destroy();
    this.session = null;
  }

  request(headers: http2.OutgoingHttpHeaders, body: string, timeoutMs: number): Promise<{ status: number; headers: http2.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = this.get().request(headers);
      } catch (err) {
        this.reset();
        reject(err);
        return;
      }
      let status = 0;
      let resHeaders: http2.IncomingHttpHeaders = {};
      let data = '';
      const timer = setTimeout(() => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      req.setEncoding('utf8');
      req.on('response', (h) => {
        resHeaders = h;
        status = Number(h[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        data += chunk;
      });
      req.on('end', () => {
        clearTimeout(timer);
        resolve({ status, headers: resHeaders, body: data });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        this.reset();
        reject(err);
      });
      req.end(body);
    });
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}

const clients: Record<ApnsEnv, Http2Client> = {
  production: new Http2Client(config.APNS_ORIGIN_OVERRIDE || HOSTS.production),
  sandbox: new Http2Client(config.APNS_ORIGIN_OVERRIDE || HOSTS.sandbox),
};

async function sendOnce(env: ApnsEnv, deviceToken: string, body: string, opts: ApnsSendOptions, refreshed = false): Promise<ApnsResult> {
  const headers: http2.OutgoingHttpHeaders = {
    ':method': 'POST',
    ':path': `/3/device/${deviceToken}`,
    authorization: `bearer ${getProviderToken(refreshed)}`,
    'apns-push-type': 'voip',
    'apns-topic': `${config.APNS_BUNDLE_ID}.voip`,
    'apns-priority': String(opts.priority ?? 10),
    'apns-expiration': String(opts.expiration),
    'content-type': 'application/json',
  };
  if (opts.collapseId) headers['apns-collapse-id'] = opts.collapseId.slice(0, 64);

  let res: Awaited<ReturnType<Http2Client['request']>>;
  try {
    res = await clients[env].request(headers, body, config.CALL_PROVIDER_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, env, apnsId: null, status: 0, reason: (err as Error).message, retryable: true };
  }

  const apnsId = (res.headers['apns-id'] as string | undefined) ?? null;
  if (res.status === 200) return { ok: true, env, apnsId };

  let reason = `HTTP ${res.status}`;
  try {
    reason = JSON.parse(res.body)?.reason ?? reason;
  } catch {
    /* empty body */
  }

  if (res.status === 403 && reason === 'ExpiredProviderToken' && !refreshed) {
    return sendOnce(env, deviceToken, body, opts, true);
  }
  if (res.status === 403 && reason === 'InvalidProviderToken') {
    logger.error('APNs rejected the provider token: check APNS_KEY_ID / APNS_TEAM_ID / key file', { env });
  }
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, env, apnsId, status: res.status, reason, retryable };
}

/** Sends one VoIP push. In 'auto' mode a token rejected by production is retried on sandbox (dev-client builds). */
export async function sendVoipPush(deviceToken: string, payload: Record<string, unknown>, opts: ApnsSendOptions): Promise<ApnsResult> {
  const body = JSON.stringify({ aps: {}, ...payload });
  const order: ApnsEnv[] = config.APNS_ENV === 'auto' ? ['production', 'sandbox'] : [config.APNS_ENV];
  let last: ApnsResult | null = null;
  for (const env of order) {
    last = await sendOnce(env, deviceToken, body, opts);
    if (last.ok || last.reason !== 'BadDeviceToken') return last;
  }
  return last!;
}

export function closeApns() {
  clients.production.close();
  clients.sandbox.close();
}
