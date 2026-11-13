-- Notification Service schema. The service only READS backend tables in "public".
CREATE SCHEMA IF NOT EXISTS notif;

CREATE TABLE IF NOT EXISTS notif.device_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT      NOT NULL,
  device_id     TEXT        NOT NULL,
  platform      TEXT,
  kind          TEXT        NOT NULL DEFAULT 'expo' CHECK (kind IN ('expo', 'fcm', 'apns_voip')),
  token         TEXT        NOT NULL,
  app_version   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_tokens_device_kind_uq UNIQUE (device_id, kind),
  CONSTRAINT device_tokens_token_uq UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON notif.device_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS notif.preferences (
  user_id         BIGINT      PRIMARY KEY,
  disabled_events TEXT[]      NOT NULL DEFAULT '{}',
  quiet_hours     JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notif.processed_events (
  event_id     UUID        PRIMARY KEY,
  event_type   TEXT        NOT NULL,
  ticket_id    BIGINT,
  recipients   INT         NOT NULL DEFAULT 0,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processed_events_time_idx ON notif.processed_events (processed_at);

-- One row per (event, user): makes unread counting and retries idempotent.
CREATE TABLE IF NOT EXISTS notif.event_recipients (
  event_id   UUID        NOT NULL,
  user_id    BIGINT      NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_recipients_time_idx ON notif.event_recipients (created_at);

CREATE TABLE IF NOT EXISTS notif.delivery_log (
  id                 BIGSERIAL   PRIMARY KEY,
  event_id           UUID        NOT NULL,
  event_type         TEXT        NOT NULL,
  ticket_id          BIGINT,
  user_id            BIGINT      NOT NULL,
  device_token_id    BIGINT,
  token              TEXT        NOT NULL,
  status             TEXT        NOT NULL CHECK (status IN ('sent', 'failed', 'delivered', 'receipt_error', 'receipt_missing')),
  provider_ticket_id TEXT,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_log_event_token_uq UNIQUE (event_id, token)
);
CREATE INDEX IF NOT EXISTS delivery_log_pending_receipts_idx
  ON notif.delivery_log (created_at) WHERE status = 'sent' AND provider_ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_log_ticket_idx ON notif.delivery_log (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS delivery_log_user_idx ON notif.delivery_log (user_id, created_at);

CREATE TABLE IF NOT EXISTS notif.unread (
  user_id    BIGINT      NOT NULL,
  ticket_id  BIGINT      NOT NULL,
  count      INT         NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticket_id)
);
