import type { Queryable } from '../db.js';
import { withTransaction } from '../db.js';

export type TokenKind = 'expo' | 'fcm' | 'apns_voip';

export interface DeviceToken {
  id: string;
  userId: string;
  deviceId: string;
  platform: string | null;
  kind: TokenKind;
  token: string;
}

export interface RegisterInput {
  userId: string;
  deviceId: string;
  platform: string;
  kind: TokenKind;
  token: string;
  appVersion: string | null;
}

/**
 * One row per (device, kind). Re-registering moves the row to the current user
 * (shared device / account switch). A token can only belong to one device.
 */
export async function registerToken(input: RegisterInput): Promise<DeviceToken> {
  return withTransaction(async (tx) => {
    // The app just proved this token is live (e.g. Expo re-issued the same token after reinstall).
    await tx.query(`DELETE FROM notif.pruned_tokens WHERE token = $1`, [input.token]);
    await tx.query(
      `DELETE FROM notif.device_tokens WHERE token = $1 AND NOT (device_id = $2 AND kind = $3)`,
      [input.token, input.deviceId, input.kind],
    );
    const { rows } = await tx.query(
      `INSERT INTO notif.device_tokens (user_id, device_id, platform, kind, token, app_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (device_id, kind) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, token = EXCLUDED.token,
             app_version = EXCLUDED.app_version, updated_at = now(), last_seen_at = now()
       RETURNING id::text, user_id::text, device_id, platform, kind, token`,
      [input.userId, input.deviceId, input.platform, input.kind, input.token, input.appVersion],
    );
    return mapRow(rows[0]);
  });
}

/** Removes only this device's tokens for this user (by device id, or by token as a fallback). */
export async function removeDeviceTokens(db: Queryable, userId: string, deviceId: string | null, token: string | null): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM notif.device_tokens
      WHERE user_id = $1 AND (($2::text IS NOT NULL AND device_id = $2) OR ($3::text IS NOT NULL AND token = $3))`,
    [userId, deviceId, token],
  );
  return rowCount ?? 0;
}

export async function getTokensForUsers(db: Queryable, userIds: string[], kind: TokenKind = 'expo'): Promise<DeviceToken[]> {
  if (userIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id::text, user_id::text, device_id, platform, kind, token
       FROM notif.device_tokens WHERE user_id = ANY($1::bigint[]) AND kind = $2`,
    [userIds, kind],
  );
  return rows.map(mapRow);
}

/** Deletes tokens Expo reported dead and remembers them so the legacy sync never re-imports them. */
export async function pruneDeadTokens(tokens: string[], reason = 'DeviceNotRegistered'): Promise<number> {
  if (tokens.length === 0) return 0;
  return withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO notif.pruned_tokens (token, reason) SELECT unnest($1::text[]), $2
       ON CONFLICT (token) DO UPDATE SET reason = EXCLUDED.reason, pruned_at = now()`,
      [tokens, reason],
    );
    const { rowCount } = await tx.query(`DELETE FROM notif.device_tokens WHERE token = ANY($1::text[])`, [tokens]);
    return rowCount ?? 0;
  });
}

function mapRow(r: any): DeviceToken {
  return { id: r.id, userId: r.user_id, deviceId: r.device_id, platform: r.platform, kind: r.kind, token: r.token };
}
