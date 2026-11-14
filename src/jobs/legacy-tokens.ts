import { withTransaction } from '../db.js';

/**
 * Mirrors the backend's public.push_tokens into notif.device_tokens as device_id 'legacy-<id>'.
 * Keeps app versions that still register with the backend reachable during rollout.
 * Only touches legacy rows: tokens registered directly with this service are never changed.
 * Tokens Expo reported dead (notif.pruned_tokens) are never re-imported.
 * The backend table is only read.
 */
export async function syncLegacyTokens(): Promise<{ upserted: number; removed: number }> {
  return withTransaction(async (tx) => {
    const exists = await tx.query(`SELECT to_regclass('public.push_tokens') AS t`);
    if (!exists.rows[0]?.t) return { upserted: 0, removed: 0 };

    const upserted = await tx.query(
      `INSERT INTO notif.device_tokens (user_id, device_id, platform, kind, token, created_at, last_seen_at)
       SELECT p.user_id, 'legacy-' || p.id, p.platform, 'expo', p.token, p.created_at, now()
         FROM public.push_tokens p
        WHERE NOT EXISTS (SELECT 1 FROM notif.pruned_tokens x WHERE x.token = p.token)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id, updated_at = now()
         WHERE notif.device_tokens.device_id LIKE 'legacy-%'
           AND notif.device_tokens.user_id IS DISTINCT FROM EXCLUDED.user_id`,
    );
    const removed = await tx.query(
      `DELETE FROM notif.device_tokens d
        WHERE d.device_id LIKE 'legacy-%'
          AND NOT EXISTS (SELECT 1 FROM public.push_tokens p WHERE p.token = d.token)`,
    );
    return { upserted: upserted.rowCount ?? 0, removed: removed.rowCount ?? 0 };
  });
}
