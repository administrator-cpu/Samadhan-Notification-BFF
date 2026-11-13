import { config } from '../config.js';
import { logger } from '../logger.js';

export interface ExpoMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
  sound?: 'default' | null;
  badge?: number;
  ttl?: number;
  tag?: string;
  threadId?: string;
}

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type ExpoReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error?: string } };

export const SEND_CHUNK = 100; // Expo max messages per request
export const RECEIPT_CHUNK = 1000; // Expo max receipt ids per request

export class ExpoRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ExpoRequestError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };
  if (config.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${config.EXPO_ACCESS_TOKEN}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${config.EXPO_API_URL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body */
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new ExpoRequestError(`Expo ${path} HTTP ${res.status}`, res.status);
      } else if (!res.ok || json?.errors?.length) {
        const detail = json?.errors?.map((e: any) => `${e.code}: ${e.message}`).join('; ') ?? text.slice(0, 300);
        throw new ExpoRequestError(`Expo ${path} rejected request: ${detail}`, res.status);
      } else {
        return json as T;
      }
    } catch (err) {
      if (err instanceof ExpoRequestError && err.status && err.status < 500 && err.status !== 429) throw err;
      lastErr = err as Error;
    }
    const wait = 1000 * 2 ** attempt;
    logger.warn('expo request failed, retrying', { path, attempt: attempt + 1, waitMs: wait, err: lastErr });
    await sleep(wait);
  }
  throw lastErr ?? new ExpoRequestError(`Expo ${path} failed`);
}

export async function sendPush(messages: ExpoMessage[]): Promise<ExpoTicket[]> {
  const out: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += SEND_CHUNK) {
    const chunk = messages.slice(i, i + SEND_CHUNK);
    const res = await post<{ data: ExpoTicket[] }>('/push/send', chunk);
    if (!Array.isArray(res?.data) || res.data.length !== chunk.length) {
      throw new ExpoRequestError('Expo /push/send returned an unexpected response');
    }
    out.push(...res.data);
  }
  return out;
}

export async function getReceipts(ids: string[]): Promise<Record<string, ExpoReceipt>> {
  const out: Record<string, ExpoReceipt> = {};
  for (let i = 0; i < ids.length; i += RECEIPT_CHUNK) {
    const res = await post<{ data: Record<string, ExpoReceipt> }>('/push/getReceipts', { ids: ids.slice(i, i + RECEIPT_CHUNK) });
    Object.assign(out, res?.data ?? {});
  }
  return out;
}

export function isExpoPushToken(token: string): boolean {
  return /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token);
}
