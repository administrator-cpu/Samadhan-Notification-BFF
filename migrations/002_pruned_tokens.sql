-- Tokens Expo reported as DeviceNotRegistered. The legacy sync skips these so a dead
-- token deleted here is not copied back from public.push_tokens every few minutes.
CREATE TABLE IF NOT EXISTS notif.pruned_tokens (
  token      TEXT        PRIMARY KEY,
  reason     TEXT        NOT NULL,
  pruned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
