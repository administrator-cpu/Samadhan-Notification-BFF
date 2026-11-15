-- Track 3: call pushes go straight to APNs / FCM, not through Expo.
ALTER TABLE notif.delivery_log
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'expo',
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS call_id TEXT;

ALTER TABLE notif.delivery_log DROP CONSTRAINT IF EXISTS delivery_log_provider_chk;
ALTER TABLE notif.delivery_log
  ADD CONSTRAINT delivery_log_provider_chk CHECK (provider IN ('expo', 'apns', 'fcm'));

CREATE INDEX IF NOT EXISTS delivery_log_call_idx ON notif.delivery_log (call_id, created_at) WHERE call_id IS NOT NULL;

DROP INDEX IF EXISTS notif.delivery_log_pending_receipts_idx;
CREATE INDEX IF NOT EXISTS delivery_log_pending_receipts_idx
  ON notif.delivery_log (created_at) WHERE status = 'sent' AND provider = 'expo' AND provider_ticket_id IS NOT NULL;
