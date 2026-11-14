import { pool } from '../db.js';
import { logger } from '../logger.js';
import { pruneDeadTokens, type DeviceToken } from '../repo/tokens.js';
import { getAlreadySentTokens, logDeliveries, type DeliveryRow } from '../repo/state.js';
import { sendPush, type ExpoMessage } from './expo-client.js';

export interface Outgoing {
  userId: string;
  token: DeviceToken;
  message: ExpoMessage;
}

export interface SendSummary {
  sent: number;
  failed: number;
  pruned: number;
  skipped: number;
}

/**
 * Sends one event's pushes. Tokens already sent for this event (earlier attempt) are skipped.
 * Per-token errors are logged; dead tokens are pruned. A request-level failure throws so the job retries.
 */
export async function deliver(eventId: string, eventType: string, ticketId: string, outgoing: Outgoing[]): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, failed: 0, pruned: 0, skipped: 0 };
  if (outgoing.length === 0) return summary;

  const already = await getAlreadySentTokens(pool, eventId);
  const todo = outgoing.filter((o) => !already.has(o.token.token));
  summary.skipped = outgoing.length - todo.length;
  if (todo.length === 0) return summary;

  const tickets = await sendPush(todo.map((o) => o.message));

  const rows: DeliveryRow[] = [];
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    const o = todo[i]!;
    const base = { eventId, eventType, ticketId, userId: o.userId, deviceTokenId: o.token.id, token: o.token.token };
    if (t.status === 'ok') {
      rows.push({ ...base, status: 'sent', providerTicketId: t.id, error: null });
      summary.sent++;
    } else {
      const code = t.details?.error ?? 'Unknown';
      rows.push({ ...base, status: 'failed', providerTicketId: null, error: `${code}: ${t.message}` });
      summary.failed++;
      if (code === 'DeviceNotRegistered') dead.push(o.token.token);
    }
  });

  await logDeliveries(pool, rows);
  if (dead.length) {
    summary.pruned = await pruneDeadTokens(dead);
    logger.info('pruned dead tokens', { eventId, count: summary.pruned });
  }
  return summary;
}
