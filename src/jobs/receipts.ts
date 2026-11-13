import { pool } from '../db.js';
import { logger } from '../logger.js';
import { getReceipts } from '../push/expo-client.js';
import { deleteTokens } from '../repo/tokens.js';

/**
 * Expo recommends checking receipts ~15 minutes after sending; they are kept for 24 hours.
 * Marks deliveries delivered/receipt_error and prunes DeviceNotRegistered tokens.
 */
export async function pollReceipts(): Promise<{ checked: number; delivered: number; errors: number; pruned: number; missing: number }> {
  const { rows } = await pool.query<{ id: string; provider_ticket_id: string; token: string }>(
    `SELECT id::text, provider_ticket_id, token FROM notif.delivery_log
      WHERE status = 'sent' AND provider_ticket_id IS NOT NULL
        AND created_at < now() - interval '15 minutes' AND created_at > now() - interval '23 hours'
      ORDER BY created_at LIMIT 5000`,
  );

  const missing = await pool.query(
    `UPDATE notif.delivery_log SET status = 'receipt_missing', updated_at = now()
      WHERE status = 'sent' AND created_at <= now() - interval '23 hours'`,
  );

  const result = { checked: rows.length, delivered: 0, errors: 0, pruned: 0, missing: missing.rowCount ?? 0 };
  if (rows.length === 0) return result;

  const receipts = await getReceipts(rows.map((r) => r.provider_ticket_id));
  const okIds: string[] = [];
  const errIds: string[] = [];
  const errMsgs: string[] = [];
  const dead: string[] = [];

  for (const row of rows) {
    const receipt = receipts[row.provider_ticket_id];
    if (!receipt) continue; // not ready yet; try next round
    if (receipt.status === 'ok') {
      okIds.push(row.id);
    } else {
      const code = receipt.details?.error ?? 'Unknown';
      errIds.push(row.id);
      errMsgs.push(`${code}: ${receipt.message}`);
      if (code === 'DeviceNotRegistered') dead.push(row.token);
      if (code === 'InvalidCredentials' || code === 'MismatchSenderId') {
        logger.error('push credentials problem reported by Expo', { code, message: receipt.message });
      }
    }
  }

  if (okIds.length) {
    await pool.query(`UPDATE notif.delivery_log SET status = 'delivered', updated_at = now() WHERE id = ANY($1::bigint[])`, [okIds]);
  }
  if (errIds.length) {
    await pool.query(
      `UPDATE notif.delivery_log d SET status = 'receipt_error', error = e.msg, updated_at = now()
         FROM unnest($1::bigint[], $2::text[]) AS e(id, msg) WHERE d.id = e.id`,
      [errIds, errMsgs],
    );
  }
  result.delivered = okIds.length;
  result.errors = errIds.length;
  result.pruned = await deleteTokens(pool, dead);
  return result;
}
