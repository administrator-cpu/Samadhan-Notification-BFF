import type { Queryable } from '../db.js';
import { config } from '../config.js';
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
  sessionJti?: string | null;
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
      `INSERT INTO notif.device_tokens (user_id, device_id, platform, kind, token, app_version, session_jti)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (device_id, kind) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, token = EXCLUDED.token,
             app_version = EXCLUDED.app_version, session_jti = EXCLUDED.session_jti, updated_at = now(), last_seen_at = now()
       RETURNING id::text, user_id::text, device_id, platform, kind, token`,
      [input.userId, input.deviceId, input.platform, input.kind, input.token, input.appVersion, input.sessionJti ?? null],
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const asJti = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

/**
 * Tokens of these users that may receive a push right now.
 *
 * Device registered by the new app (session_jti set): its backend session, followed across
 * refresh rotations, must be active. The backend rotates a session inside one transaction, so the
 * successor's created_at equals the predecessor's revoked_at; a logout, deactivation or
 * password-change revoke has no successor and ends the chain.
 *
 * Device copied from the legacy push_tokens table (no session_jti): the user needs an active
 * non-browser session (web dashboard logins don't count for phones).
 */
export async function getDeliverableTokens(db: Queryable, userIds: string[], kind: TokenKind = 'expo'): Promise<DeviceToken[]> {
  if (userIds.length === 0) return [];
  const { rows } = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT dt.id AS token_id, s.user_id, s.revoked, s.revoked_at, s.expires_at, 0 AS depth
         FROM notif.device_tokens dt
         JOIN public.sessions s ON s.jti = dt.session_jti AND s.user_id = dt.user_id
        WHERE dt.user_id = ANY($1::bigint[]) AND dt.kind = $2 AND dt.session_jti IS NOT NULL
       UNION ALL
       SELECT c.token_id, n.user_id, n.revoked, n.revoked_at, n.expires_at, c.depth + 1
         FROM chain c
         JOIN public.sessions n ON n.user_id = c.user_id AND n.created_at = c.revoked_at
        WHERE c.revoked AND c.revoked_at IS NOT NULL AND c.depth < 100
     )
     SELECT dt.id::text, dt.user_id::text, dt.device_id, dt.platform, dt.kind, dt.token
       FROM notif.device_tokens dt
      WHERE dt.user_id = ANY($1::bigint[]) AND dt.kind = $2
        AND (
          (dt.session_jti IS NOT NULL AND EXISTS (
             SELECT 1 FROM chain c WHERE c.token_id = dt.id AND NOT c.revoked AND c.expires_at > now()))
          OR
          (dt.session_jti IS NULL AND EXISTS (
             SELECT 1 FROM public.sessions s
              WHERE s.user_id = dt.user_id AND NOT s.revoked AND s.expires_at > now()
                AND (s.user_agent IS NULL OR s.user_agent NOT ILIKE 'Mozilla%')))
        )`,
    [userIds, kind],
  );
  return rows.map(mapRow);
}

/** Tokens to push to now: session-gated unless REQUIRE_ACTIVE_SESSION=false. */
export async function getTokensForDelivery(db: Queryable, userIds: string[], kind: TokenKind = 'expo'): Promise<DeviceToken[]> {
  return config.REQUIRE_ACTIVE_SESSION ? getDeliverableTokens(db, userIds, kind) : getTokensForUsers(db, userIds, kind);
}

function mapRow(r: any): DeviceToken {
  return { id: r.id, userId: r.user_id, deviceId: r.device_id, platform: r.platform, kind: r.kind, token: r.token };
}
