# Samadhan Notification Service

Delivers ticket push notifications to the Samadhan mobile app when it is backgrounded, killed or the phone is locked, and makes incoming calls ring natively (CallKit on iPhone, full-screen call on Android).

```
tool-samadhan backend ──publish──▶ Redis (BullMQ "notifications") ──▶ this service ──▶ Expo Push ──▶ FCM / APNs ──▶ phone
                                                                        ▲
mobile app ──HTTPS (register / remove / unread)──▶ nginx ──▶ token API ──┘
```

One Node process runs three things:

| Part | What it does |
|---|---|
| **Queue worker** | Reads each ticket event, works out who should be notified, drops the person who caused it and anyone who muted that event type, builds the message, sends it through Expo, and logs every attempt. Retries are safe: an event is never sent twice to the same device. Events that keep failing go to the `notifications-dlq` queue. |
| **Token API** | `https://samadhan-notify.fab5connect.com/v1/...` — the app registers and removes its device token here. Uses the same login token as the backend. |
| **Background jobs** | Every 5 min: checks Expo delivery receipts and deletes dead tokens. Every 10 min: copies tokens that older app versions still register with the backend (tokens Expo reported dead are never copied back). Every 6 h: deletes old log rows and tokens unseen for 90 days. |

The backend never decides who gets notified. It only says *what happened* (see `tool-samadhan/apps/backend/NOTIFICATION_EVENTS.md`).

## Who gets what

| Event | Customer | Assigned agent | Others |
|---|---|---|---|
| Ticket created | ✓ (unless they created it) | ✓ if auto-assigned | Admins, if nobody was assigned |
| Reassigned | ✓ | New agent ✓ | Previous agent ✓ |
| Reply | ✓ if staff replied | ✓ if the customer (or an admin) replied | Admins, if a customer replies on an unassigned ticket |
| Internal note | ✗ | ✓ | |
| Status changed / reopened | ✓ | ✓ | |
| RCA added, outage update, auto-close, automated update | ✓ | | |
| Rated | | ✓ | Admins |
| SLA breach (4 h escalation) | | ✓ | Admins |

The person who caused the event is never notified. Inactive users are skipped.

A device only receives pushes (tickets and calls) while it is still logged in: its backend session, followed across token refreshes, must be active. Logout, password change, deactivation or session expiry stops pushes to that device even if its token was never removed. Tokens copied from old app versions need the user to have an active app (non-browser) session. Turn off with `REQUIRE_ACTIVE_SESSION=false`.

Each push carries `data: { ticketId, ticketNo, role, eventType, eventId }`. `role` is the **recipient's** role, so a tap opens the right screen. Android channels: `ticket_updates`, `assignments` (matches the app). Notifications for the same ticket replace each other in the Android tray and group together on iOS. The iOS badge is the user's unread count.

## Calls

```
backend call signaling ──enqueue──▶ Redis (BullMQ "calls") ──▶ call worker ─┬─ APNs HTTP/2, push type voip ──▶ PushKit ──▶ CallKit ring
                                                                           └─ FCM HTTP v1, high-priority data ──▶ full-screen call
```

- Separate `calls` queue and worker, so ticket traffic never delays a ring. Few, fast retries; an invite past its ring timeout is dropped.
- `call_invite` / `call_cancel` go to `apns_voip` and `fcm` device tokens. `call_missed` is a normal visible push through Expo on the `missed_call` channel.
- Cancel carries `reason` (`caller_cancelled`, `answered_elsewhere`, `declined_elsewhere`) and skips `excludeDeviceId`, the device that answered or declined.
- Every attempt is a row in `notif.delivery_log` (`provider` = `apns` / `fcm`, `call_id`, `provider_message_id`, `error`). Dead tokens (`Unregistered`, `BadDeviceToken`, FCM `UNREGISTERED`) are deleted.
- APNs: `APNS_ENV=auto` tries production, then sandbox if the token is a dev-client token.

| Env | Value |
|---|---|
| `APNS_KEY_ID`, `APNS_TEAM_ID` | From the Apple Developer key page |
| `APNS_KEY_PATH` (or `APNS_KEY`) | Path to the `.p8` file, e.g. `C:\apps\secrets\AuthKey_XXXX.p8` |
| `APNS_BUNDLE_ID` | `com.harshjha047.samadhan` (topic becomes `<bundle>.voip`) |
| `APNS_ENV` | `auto` (default), `production` or `sandbox` |
| `FCM_SERVICE_ACCOUNT_PATH` (or `FCM_SERVICE_ACCOUNT_JSON`) | Firebase service account JSON with the FCM v1 role |
| `FCM_PROJECT_ID` | Optional; defaults to `project_id` in the JSON |
| `CALLS_QUEUE_NAME`, `CALLS_WORKER_CONCURRENCY` | `calls`, `10` |

Keep the `.p8` and service account JSON outside the repo folder; never commit them. `/health` shows `callsQueue` and whether each provider is configured.

| Task | How |
|---|---|
| Ring a user's phones | `npm run send-test-call -- <userId>` then `npm run send-test-call -- <userId> cancel <callId>` |
| "Phone didn't ring" | `SELECT created_at, event_type, provider, status, error FROM notif.delivery_log WHERE call_id = '<callId>' ORDER BY created_at;` and check `notif.device_tokens WHERE user_id = X AND kind IN ('apns_voip','fcm')` |

## Database

The service uses the same Postgres database as the backend:

- It **creates and owns** the schema `notif`: `device_tokens`, `pruned_tokens`, `preferences`, `delivery_log`, `processed_events`, `event_recipients`, `unread`, `schema_migrations`.
- It **only reads** these backend tables: `tickets`, `customers`, `employees`, `users`, `issue_categories`, `ticket_events`, `sessions`, `push_tokens`.

Migrations in `migrations/` run automatically on start (`MIGRATE_ON_START=true`).

## Setup on the Windows VPS

Prerequisites already on the server: Node.js 20+, PM2, nginx, Postgres, Redis (the ones tool-samadhan uses).

1. **DNS** — add an A record `samadhan-notify.fab5connect.com` → the VPS public IP.

2. **Code** — clone this repo, e.g. `C:\apps\samadhan-notification-service`, then:
   ```powershell
   cd C:\apps\samadhan-notification-service
   npm ci
   npm run build
   ```

3. **Config** — `copy .env.example .env` and fill in:
   - `POSTGRES_*` and `REDIS_*` — same values as tool-samadhan's `.env`.
   - `JWT_SECRET` — **exactly** the backend's `JWT_SECRET`.
   - `EXPO_ACCESS_TOKEN` — only if Enhanced push security is on in the Expo dashboard.
   - Optional: a least-privilege DB user — run `deploy/sql/create-service-role.sql` and use it instead of the backend's DB user.

4. **Database** — `npm run migrate` (creates schema `notif`). Then `npm run sync-legacy-tokens` to copy existing `push_tokens`.

5. **Start with PM2**
   ```powershell
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 install pm2-logrotate   # once per server, if not already installed
   ```
   PM2 restarts it on crash and, with your existing PM2 startup setup, on reboot.

6. **nginx** — copy `deploy/nginx/samadhan-notify.conf` into your nginx config, add the `limit_req_zone` line to the `http {}` block, set the certificate paths (same tool you use for `samadhan-api`), then `nginx -t` and `nginx -s reload`.

7. **Firewall** — nothing new to open: port 4100 listens on `127.0.0.1` only; nginx already serves 80/443.

8. **Check it**
   ```powershell
   curl http://127.0.0.1:4100/health          # {"status":"ok", ...}
   pm2 logs samadhan-notify --lines 50
   ```
   After a phone with the new app build logs in:
   ```powershell
   npm run send-test -- <userId>              # sends a test push to that user's devices
   ```

## Turning it on (backend flags in tool-samadhan `.env`)

1. `NOTIFICATION_QUEUE_ENABLED=true`, `NOTIFICATION_QUEUE_EVENTS=ticket.created,ticket.reassigned` — runs alongside the old push. Compare in `notif.delivery_log`.
2. `LEGACY_TICKET_PUSH_ENABLED=false` — old ticket push off.
3. `NOTIFICATION_QUEUE_EVENTS=*` — all events.
4. Once every user runs the new app version: `LEGACY_TOKEN_SYNC_INTERVAL_SEC=0` here.

Restart the backend after changing its `.env`.

## Mobile app

The app reads `extra.notifUrl` (`https://samadhan-notify.fab5connect.com`, or the `NOTIFICATION_SERVICE_URL` build env). If the service can't be reached, the app falls back to the backend's `/users/push-token`.

## API

All `/v1` routes need `Authorization: Bearer <backend access token>`. Responses: `{ success, data }`.

| Method & path | Body | Result |
|---|---|---|
| `POST /v1/devices/register` | `{ token, kind: "expo"\|"apns_voip"\|"fcm", platform: "ios"\|"android", deviceId, appVersion? }` | Saves/updates this device (one row per device and kind). `apns_voip` is iOS only, `fcm` Android only. A device switching accounts moves to the new user. |
| `POST /v1/devices/remove` | `{ deviceId?, token? }` | Removes **this device** only, and only if it belongs to the caller. |
| `GET /v1/unread-count` | — | `{ count }` |
| `POST /v1/read` | `{ ticketId }` (omit to clear all) | Clears unread for that ticket, returns new `{ count }` |
| `GET /v1/preferences` | — | `{ disabledEvents: [] }` |
| `PUT /v1/preferences` | `{ disabledEvents: ["ticket.status_changed", ...] }` | Mutes those event types for the caller |
| `GET /health` | — | DB, Redis, queue depth, dead-letter count. 503 if DB or Redis is down. |

## Operations

| Task | How |
|---|---|
| Logs | `pm2 logs samadhan-notify` (JSON lines; files in `logs/`) |
| Why didn't user X get a push? | `SELECT * FROM notif.delivery_log WHERE user_id = X ORDER BY created_at DESC LIMIT 20;` and `SELECT * FROM notif.device_tokens WHERE user_id = X;` |
| Dead-letter jobs | `/health` → `deadLetters`. Fix the cause, then `npm run requeue-dlq` |
| Expo says `InvalidCredentials` / `MismatchSenderId` | Logged as errors. Re-upload the FCM V1 key in Expo, or run `eas credentials` for iOS |
| Deploy a new version | `git pull && npm ci && npm run build && pm2 restart samadhan-notify` |

## Development

```bash
npm ci
npm run dev                 # watch mode, reads .env
npm test                    # unit tests (recipient rules, messages, call contract)
TEST_POSTGRES_PORT=5432 TEST_POSTGRES_DB=samadhan_test npm run test:calls   # call delivery against fake APNs/FCM
TEST_POSTGRES_PORT=5432 TEST_POSTGRES_DB=samadhan_test TEST_REDIS_PORT=6379 npm run test:e2e
```

The end-to-end test **drops and recreates** tables in the test database — never point it at the real one.

| Path | Contents |
|---|---|
| `src/worker/recipients.ts` | Who gets notified per event |
| `src/worker/messages.ts` | Notification text and channel per event |
| `src/worker/processor.ts` | One event → recipients → tokens → send |
| `src/push/` | Expo client, APNs (VoIP), FCM v1, sending, dead-token pruning |
| `src/calls/` | Call queue worker, job contract, call delivery |
| `src/api/` | Token API and auth |
| `src/jobs/` | Receipts, cleanup, legacy token sync |
| `migrations/` | `notif` schema |
