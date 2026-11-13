import { config } from '../config.js';
import { pool } from '../db.js';

export async function runMaintenance() {
  const q = async (sql: string, days: number) => (await pool.query(sql, [days])).rowCount ?? 0;
  return {
    processedEvents: await q(`DELETE FROM notif.processed_events WHERE processed_at < now() - make_interval(days => $1)`, config.PROCESSED_EVENT_RETENTION_DAYS),
    eventRecipients: await q(`DELETE FROM notif.event_recipients WHERE created_at < now() - make_interval(days => $1)`, config.PROCESSED_EVENT_RETENTION_DAYS),
    deliveryLog: await q(`DELETE FROM notif.delivery_log WHERE created_at < now() - make_interval(days => $1)`, config.DELIVERY_LOG_RETENTION_DAYS),
    // The app re-registers on every start; a token unseen this long belongs to an abandoned install.
    staleTokens: await q(`DELETE FROM notif.device_tokens WHERE last_seen_at < now() - make_interval(days => $1)`, config.STALE_TOKEN_DAYS),
  };
}
