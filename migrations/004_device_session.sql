-- The backend session (access-token jti) a device registered under. Pushes go only to
-- devices whose session chain is still active, so a logged-out or expired device gets nothing
-- even if its token was never removed.
ALTER TABLE notif.device_tokens ADD COLUMN IF NOT EXISTS session_jti UUID;
