import { config } from '../config.js';
import { pool } from '../db.js';

// A tombstone is only needed while the dead token still sits in the backend's push_tokens.
async function forgetPrunedTokens(): Promise<number> {
  const legacy = (await pool.query(`SELECT to_regclass('public.push_tokens') AS t`)).rows[0]?.t;
  const sql = legacy
    ? `DELETE FROM notif.pruned_tokens x WHERE x.pruned_at < now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM public.push_tokens p WHERE p.token = x.token)`
    : `DELETE FROM notif.pruned_tokens WHERE pruned_at < now() - interval '30 days'`;
  return (await pool.query(sql)).rowCount ?? 0;
}

export async function runMaintenance() {
  const q = async (sql: string, days: number) => (await pool.query(sql, [days])).rowCount ?? 0;
  return {
    processedEvents: await q(`DELETE FROM notif.processed_events WHERE processed_at < now() - make_interval(days => $1)`, config.PROCESSED_EVENT_RETENTION_DAYS),
    eventRecipients: await q(`DELETE FROM notif.event_recipients WHERE created_at < now() - make_interval(days => $1)`, config.PROCESSED_EVENT_RETENTION_DAYS),
    deliveryLog: await q(`DELETE FROM notif.delivery_log WHERE created_at < now() - make_interval(days => $1)`, config.DELIVERY_LOG_RETENTION_DAYS),
    // The app re-registers on every start; a token unseen this long belongs to an abandoned install.
    prunedTokens: await forgetPrunedTokens(),
    staleTokens: await q(`DELETE FROM notif.device_tokens WHERE last_seen_at < now() - make_interval(days => $1)`, config.STALE_TOKEN_DAYS),
  };
}
