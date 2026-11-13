import type { Queryable } from '../db.js';

export async function isEventProcessed(db: Queryable, eventId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM notif.processed_events WHERE event_id = $1`, [eventId]);
  return rows.length > 0;
}

export async function markEventProcessed(db: Queryable, eventId: string, eventType: string, ticketId: string, recipients: number) {
  await db.query(
    `INSERT INTO notif.processed_events (event_id, event_type, ticket_id, recipients)
     VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, eventType, ticketId, recipients],
  );
}

/** Returns the user ids that had not yet been recorded for this event (first attempt). */
export async function recordRecipients(db: Queryable, eventId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { rows } = await db.query(
    `INSERT INTO notif.event_recipients (event_id, user_id)
     SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING RETURNING user_id::text`,
    [eventId, userIds],
  );
  return new Set(rows.map((r) => r.user_id));
}

export async function getDisabledEvents(db: Queryable, userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (userIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT user_id::text, disabled_events FROM notif.preferences WHERE user_id = ANY($1::bigint[])`,
    [userIds],
  );
  for (const r of rows) out.set(r.user_id, new Set(r.disabled_events));
  return out;
}

export async function getPreferences(db: Queryable, userId: string): Promise<{ disabledEvents: string[] }> {
  const { rows } = await db.query(`SELECT disabled_events FROM notif.preferences WHERE user_id = $1`, [userId]);
  return { disabledEvents: rows[0]?.disabled_events ?? [] };
}

export async function setPreferences(db: Queryable, userId: string, disabledEvents: string[]) {
  await db.query(
    `INSERT INTO notif.preferences (user_id, disabled_events) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET disabled_events = EXCLUDED.disabled_events, updated_at = now()`,
    [userId, disabledEvents],
  );
}

export async function incrementUnread(db: Queryable, userIds: string[], ticketId: string) {
  if (userIds.length === 0) return;
  await db.query(
    `INSERT INTO notif.unread (user_id, ticket_id, count)
     SELECT unnest($1::bigint[]), $2, 1
     ON CONFLICT (user_id, ticket_id) DO UPDATE SET count = notif.unread.count + 1, updated_at = now()`,
    [userIds, ticketId],
  );
}

export async function getUnreadCounts(db: Queryable, userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT user_id::text, COALESCE(SUM(count), 0)::int AS total
       FROM notif.unread WHERE user_id = ANY($1::bigint[]) GROUP BY user_id`,
    [userIds],
  );
  for (const r of rows) out.set(r.user_id, r.total);
  return out;
}

export async function markTicketRead(db: Queryable, userId: string, ticketId: string | null) {
  if (ticketId) await db.query(`DELETE FROM notif.unread WHERE user_id = $1 AND ticket_id = $2`, [userId, ticketId]);
  else await db.query(`DELETE FROM notif.unread WHERE user_id = $1`, [userId]);
}

export interface DeliveryRow {
  eventId: string;
  eventType: string;
  ticketId: string;
  userId: string;
  deviceTokenId: string | null;
  token: string;
  status: 'sent' | 'failed';
  providerTicketId: string | null;
  error: string | null;
}

export async function getAlreadySentTokens(db: Queryable, eventId: string): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT token FROM notif.delivery_log WHERE event_id = $1 AND status <> 'failed'`,
    [eventId],
  );
  return new Set(rows.map((r) => r.token));
}

export async function logDeliveries(db: Queryable, rows: DeliveryRow[]) {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO notif.delivery_log
       (event_id, event_type, ticket_id, user_id, device_token_id, token, status, provider_ticket_id, error)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::text[], $7::text[], $8::text[], $9::text[])
     ON CONFLICT (event_id, token) DO UPDATE
       SET status = EXCLUDED.status, provider_ticket_id = EXCLUDED.provider_ticket_id,
           error = EXCLUDED.error, updated_at = now()`,
    [
      rows.map((r) => r.eventId),
      rows.map((r) => r.eventType),
      rows.map((r) => r.ticketId),
      rows.map((r) => r.userId),
      rows.map((r) => r.deviceTokenId),
      rows.map((r) => r.token),
      rows.map((r) => r.status),
      rows.map((r) => r.providerTicketId),
      rows.map((r) => r.error),
    ],
  );
}
