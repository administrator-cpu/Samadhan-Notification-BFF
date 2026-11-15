import type { Queryable } from '../db.js';

export interface CallDeliveryRow {
  jobId: string;
  eventType: string;
  ticketId: string | null;
  callId: string;
  userId: string;
  deviceTokenId: string;
  token: string;
  provider: 'apns' | 'fcm';
  status: 'sent' | 'failed';
  providerMessageId: string | null;
  error: string | null;
}

export async function resolveUserId(db: Queryable, toUserId: string | null, email: string): Promise<string | null> {
  if (toUserId && /^\d+$/.test(toUserId)) {
    const { rows } = await db.query(`SELECT id::text FROM public.users WHERE id = $1 AND is_active`, [toUserId]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await db.query(
    `SELECT id::text FROM public.users WHERE lower(email) = lower($1) AND is_active ORDER BY id LIMIT 1`,
    [email],
  );
  return rows[0]?.id ?? null;
}

export async function logCallDeliveries(db: Queryable, rows: CallDeliveryRow[]) {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO notif.delivery_log
       (event_id, event_type, ticket_id, call_id, user_id, device_token_id, token, provider, status, provider_message_id, error)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::bigint[], $4::text[], $5::bigint[], $6::bigint[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
     ON CONFLICT (event_id, token) DO UPDATE
       SET status = EXCLUDED.status, provider_message_id = EXCLUDED.provider_message_id,
           error = EXCLUDED.error, updated_at = now()`,
    [
      rows.map((r) => r.jobId),
      rows.map((r) => r.eventType),
      rows.map((r) => (r.ticketId && /^\d+$/.test(r.ticketId) ? r.ticketId : null)),
      rows.map((r) => r.callId),
      rows.map((r) => r.userId),
      rows.map((r) => r.deviceTokenId),
      rows.map((r) => r.token),
      rows.map((r) => r.provider),
      rows.map((r) => r.status),
      rows.map((r) => r.providerMessageId),
      rows.map((r) => r.error),
    ],
  );
}
