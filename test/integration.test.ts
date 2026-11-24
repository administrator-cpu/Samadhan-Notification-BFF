// End-to-end against real Postgres + Redis and a fake Expo server.
// Runs only when TEST_POSTGRES_PORT is set, e.g.:
//   TEST_POSTGRES_PORT=5432 TEST_POSTGRES_DB=samadhan_test TEST_REDIS_PORT=6379 npm test
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

const enabled = !!process.env.TEST_POSTGRES_PORT;

// Fake Expo: records messages; tokens containing "dead" are DeviceNotRegistered.
const sent: any[] = [];
let failNext = 0;
let receiptSeq = 0;
const receiptErrors = new Set<string>();
const expo = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (failNext > 0) {
    failNext--;
    res.writeHead(503).end('busy');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/push/send') {
    const msgs = JSON.parse(body);
    sent.push(...msgs);
    res.end(JSON.stringify({
      data: msgs.map((m: any) => m.to.includes('dead')
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok', id: `rcpt-${++receiptSeq}` }),
    }));
  } else if (req.url === '/push/getReceipts') {
    const { ids } = JSON.parse(body);
    const data: Record<string, unknown> = {};
    for (const id of ids) data[id] = receiptErrors.has(id)
      ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
      : { status: 'ok' };
    res.end(JSON.stringify({ data }));
  } else res.writeHead(404).end();
});

let api: http.Server;
let base = '';
let m: any = {};

before(async () => {
  if (!enabled) return;
  const dbName = process.env.TEST_POSTGRES_DB ?? 'samadhan_test';
  if (!/test/i.test(dbName)) throw new Error(`Refusing to run: TEST_POSTGRES_DB "${dbName}" must contain "test" (tables are dropped).`);
  await new Promise<void>((r) => expo.listen(0, '127.0.0.1', () => r()));
  Object.assign(process.env, {
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: process.env.TEST_POSTGRES_PORT,
    POSTGRES_DB: process.env.TEST_POSTGRES_DB ?? 'samadhan_test',
    POSTGRES_USER: process.env.TEST_POSTGRES_USER ?? 'postgres',
    POSTGRES_PASSWORD: process.env.TEST_POSTGRES_PASSWORD ?? '',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: process.env.TEST_REDIS_PORT ?? '6379',
    JWT_SECRET: 'test-secret',
    EXPO_API_URL: `http://127.0.0.1:${(expo.address() as AddressInfo).port}`,
    QUEUE_NAME: 'notifications-test',
    DLQ_NAME: 'notifications-test-dlq',
    LOG_LEVEL: 'error',
  });
  m.db = await import('../src/db.js');
  m.jwt = (await import('jsonwebtoken')).default;
  m.migrate = await import('../src/scripts/migrate-lib.js');
  m.processor = await import('../src/worker/processor.js');
  m.server = await import('../src/api/server.js');
  m.receipts = await import('../src/jobs/receipts.js');
  m.legacy = await import('../src/jobs/legacy-tokens.js');
  m.worker = await import('../src/worker/worker.js');
  m.bull = await import('bullmq');
  m.redis = await import('../src/redis.js');

  await m.db.pool.query(await readFile(new URL('./fixtures/backend-schema.sql', import.meta.url), 'utf8'));
  await m.migrate.runMigrations();
  m.apiHandle = m.server.createApp();
  api = await new Promise((r) => { const s = m.apiHandle.app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  if (!enabled) return;
  await new Promise<void>((r) => api.close(() => r()));
  await m.apiHandle.close();
  await m.db.pool.end();
  expo.close();
});

const token = (userId: number, jti: string, role = 'USER') => m.jwt.sign({ userId: String(userId), role, email: 'x@y.z', jti }, 'test-secret', { expiresIn: '1h' });
const CUST = () => token(4, '11111111-1111-4111-8111-111111111111');
const AGENT_A = () => token(2, '33333333-3333-4333-8333-333333333333', 'SUPPORT_AGENT');
const AGENT_B = () => token(3, '44444444-4444-4444-8444-444444444444', 'SUPPORT_AGENT');
const ADMIN = () => token(1, '55555555-5555-4555-8555-555555555555', 'ADMIN');

async function call(method: string, path: string, auth?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}
const reg = (auth: string, deviceId: string, tok: string, platform = 'android') =>
  call('POST', '/v1/devices/register', auth, { token: `ExponentPushToken[${tok}]`, kind: 'expo', platform, deviceId, appVersion: '1.2.0' });
let n = 0;
const evt = (eventType: string, ticketId: number, actorUserId: number | null, meta: Record<string, unknown> = {}) => ({
  eventId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, version: 1, eventType, ticketId: String(ticketId),
  actorUserId: actorUserId === null ? null : String(actorUserId), occurredAt: new Date().toISOString(), meta,
});
const to = (frag: string) => sent.filter((s) => s.to.includes(frag));

test('token API: auth and validation', { skip: !enabled }, async () => {
  assert.equal((await call('POST', '/v1/devices/register', undefined, {})).status, 401);
  assert.equal((await call('POST', '/v1/devices/register', 'garbage', {})).status, 401);
  const revoked = token(4, '22222222-2222-4222-8222-222222222222');
  assert.equal((await reg(revoked, 'device-revoked', 'x')).status, 401);
  const bad = await call('POST', '/v1/devices/register', CUST(), { token: 'not-a-token', platform: 'android', deviceId: 'device-cust-1' });
  assert.equal(bad.status, 400);
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
});

test('register devices', { skip: !enabled }, async () => {
  for (const [auth, dev, tok, p] of [
    [CUST(), 'device-cust-1', 'cust-phone', 'android'],
    [CUST(), 'device-cust-2', 'cust-dead', 'ios'],
    [CUST(), 'device-cust-3', 'cust-tablet', 'ios'],
    [AGENT_A(), 'device-agentA', 'agentA', 'android'],
    [AGENT_B(), 'device-agentB', 'agentB', 'android'],
    [ADMIN(), 'device-admin', 'admin', 'ios'],
  ] as const) {
    const r = await reg(auth, dev, tok, p);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  // re-register same device is an update, not a duplicate
  await reg(CUST(), 'device-cust-1', 'cust-phone');
  const { rows } = await m.db.pool.query(`SELECT count(*)::int AS c FROM notif.device_tokens WHERE user_id = 4`);
  assert.equal(rows[0].c, 3);
});

test('agent reply → customer devices only, with deep-link data, badge and grouping; dead token pruned', { skip: !enabled }, async () => {
  sent.length = 0;
  const e = evt('ticket.reply', 100, 2, { ticketEventId: '500', replyType: 'AGENT_REPLY', actorRole: 'SUPPORT_AGENT' });
  const r = await m.processor.processEvent(e);
  assert.equal(r.recipients, 1);
  assert.equal(to('agentA').length, 0, 'actor must not be notified');
  assert.equal(sent.length, 3);
  const msg = to('cust-phone')[0];
  assert.equal(msg.title, 'Ravi Agent replied on TCK-1042');
  assert.match(msg.body, /reset the port/);
  assert.equal(msg.priority, 'high');
  assert.equal(msg.channelId, 'ticket_updates');
  assert.equal(msg.tag, 'ticket-100');
  assert.equal(msg.badge, 1);
  assert.deepEqual({ ticketId: msg.data.ticketId, role: msg.data.role, eventType: msg.data.eventType }, { ticketId: '100', role: 'USER', eventType: 'ticket.reply' });
  const dead = await m.db.pool.query(`SELECT 1 FROM notif.device_tokens WHERE token LIKE '%cust-dead%'`);
  assert.equal(dead.rowCount, 0, 'DeviceNotRegistered token pruned');

  sent.length = 0;
  const again = await m.processor.processEvent(e);
  assert.equal(again.status, 'duplicate');
  assert.equal(sent.length, 0);
});

test('reassign → new agent (assignments), previous agent, customer; previous via meta', { skip: !enabled }, async () => {
  sent.length = 0;
  await m.processor.processEvent(evt('ticket.reassigned', 100, 1, { previousEmployeeId: '10', newEmployeeId: '11' }));
  assert.equal(to('agentB')[0].title, 'Ticket TCK-1042 assigned to you');
  assert.equal(to('agentB')[0].channelId, 'assignments');
  assert.equal(to('agentB')[0].data.role, 'SUPPORT_AGENT');
  assert.match(to('agentA')[0].body, /Meera Agent/);
  assert.match(to('cust-phone')[0].body, /Meera Agent is now handling/);
  assert.equal(to('admin').length, 0, 'actor (admin) excluded');
  assert.equal(to('cust-phone')[0].badge, 2);
});

test('unassigned ticket created by customer → active admins only', { skip: !enabled }, async () => {
  sent.length = 0;
  await m.processor.processEvent(evt('ticket.created', 101, 4, { assignedEmployeeId: null }));
  assert.equal(sent.length, 1);
  assert.equal(to('admin')[0].title, 'New unassigned ticket TCK-1043');
  assert.equal(to('admin')[0].data.role, 'ADMIN');
});

test('unread count + mark read via API', { skip: !enabled }, async () => {
  assert.equal((await call('GET', '/v1/unread-count', CUST())).json.data.count, 2);
  const read = await call('POST', '/v1/read', CUST(), { ticketId: 100 });
  assert.equal(read.json.data.count, 0);
});

test('preferences mute an event type', { skip: !enabled }, async () => {
  const p = await call('PUT', '/v1/preferences', CUST(), { disabledEvents: ['ticket.status_changed'] });
  assert.equal(p.status, 200);
  sent.length = 0;
  await m.processor.processEvent(evt('ticket.status_changed', 100, 1, { oldStatus: 'IN_PROGRESS', requestedStatus: 'RESOLVED', newStatus: 'RESOLVED' }));
  assert.equal(to('cust').length, 0);
  assert.equal(to('agentA').length, 1);
  await call('PUT', '/v1/preferences', CUST(), { disabledEvents: [] });
});

test('transient Expo outage is retried', { skip: !enabled }, async () => {
  sent.length = 0;
  failNext = 1;
  const r = await m.processor.processEvent(evt('ticket.rca_added', 100, 2, { autoClosed: false }));
  assert.equal(r.delivery.sent, 2);
});

test('receipts: delivered + DeviceNotRegistered prunes', { skip: !enabled }, async () => {
  await m.db.pool.query(`UPDATE notif.delivery_log SET created_at = now() - interval '20 minutes' WHERE status = 'sent'`);
  const { rows } = await m.db.pool.query(`SELECT provider_ticket_id FROM notif.delivery_log WHERE status = 'sent' AND token LIKE '%cust-tablet%' LIMIT 1`);
  receiptErrors.add(rows[0].provider_ticket_id);
  const r = await m.receipts.pollReceipts();
  assert.ok(r.delivered > 0);
  assert.equal(r.errors, 1);
  assert.equal(r.pruned, 1);
  const left = await m.db.pool.query(`SELECT 1 FROM notif.device_tokens WHERE token LIKE '%cust-tablet%'`);
  assert.equal(left.rowCount, 0);
});

test('logout removes only this device', { skip: !enabled }, async () => {
  await reg(CUST(), 'device-cust-4', 'cust-laptop');
  const r = await call('POST', '/v1/devices/remove', CUST(), { deviceId: 'device-cust-1', token: 'ExponentPushToken[cust-phone]' });
  assert.equal(r.json.data.removed, 1);
  const { rows } = await m.db.pool.query(`SELECT device_id FROM notif.device_tokens WHERE user_id = 4`);
  assert.deepEqual(rows.map((x: any) => x.device_id), ['device-cust-4']);
  // another user cannot remove someone else's device
  const other = await call('POST', '/v1/devices/remove', AGENT_A(), { deviceId: 'device-cust-4' });
  assert.equal(other.json.data.removed, 0);
});

test('legacy push_tokens are mirrored and un-mirrored', { skip: !enabled }, async () => {
  await m.db.pool.query(`INSERT INTO public.push_tokens (user_id, token, platform) VALUES (3, 'ExponentPushToken[legacy-b]', 'android'), (2, 'ExponentPushToken[agentA]', 'android')`);
  const s1 = await m.legacy.syncLegacyTokens();
  assert.equal(s1.upserted, 1, 'token already registered directly is left alone');
  const owner = await m.db.pool.query(`SELECT device_id FROM notif.device_tokens WHERE token = 'ExponentPushToken[agentA]'`);
  assert.equal(owner.rows[0].device_id, 'device-agentA');
  const again = await m.legacy.syncLegacyTokens();
  assert.equal(again.upserted, 0, 'unchanged rows are not rewritten');
  await m.db.pool.query(`DELETE FROM public.push_tokens WHERE token = 'ExponentPushToken[legacy-b]'`);
  const s2 = await m.legacy.syncLegacyTokens();
  assert.equal(s2.removed, 1);
});

test('dead legacy tokens are not re-imported; re-registering revives them', { skip: !enabled }, async () => {
  await m.db.pool.query(`INSERT INTO public.push_tokens (user_id, token, platform) VALUES (4, 'ExponentPushToken[legacy-dead]', 'android')`);
  await m.legacy.syncLegacyTokens();
  sent.length = 0;
  const r = await m.processor.processEvent(evt('ticket.outage', 100, 2, { problemSide: 'ISP' }));
  assert.equal(r.delivery.pruned, 1, 'dead legacy token pruned on send');
  const s = await m.legacy.syncLegacyTokens();
  assert.equal(s.upserted, 0, 'pruned token not copied back');
  const gone = await m.db.pool.query(`SELECT 1 FROM notif.device_tokens WHERE token = 'ExponentPushToken[legacy-dead]'`);
  assert.equal(gone.rowCount, 0);
  // the app registering the same token directly clears the tombstone
  const reg = await call('POST', '/v1/devices/register', CUST(), { token: 'ExponentPushToken[legacy-dead]', platform: 'android', deviceId: 'device-cust-revived' });
  assert.equal(reg.status, 200);
  const tomb = await m.db.pool.query(`SELECT 1 FROM notif.pruned_tokens WHERE token = 'ExponentPushToken[legacy-dead]'`);
  assert.equal(tomb.rowCount, 0);
});

test('BullMQ worker consumes the queue; bad payload lands in DLQ', { skip: !enabled }, async () => {
  const conn = m.redis.createRedis('test');
  const q = new m.bull.Queue('notifications-test', { connection: conn });
  const dlq = new m.bull.Queue('notifications-test-dlq', { connection: conn });
  await q.obliterate({ force: true });
  await dlq.obliterate({ force: true });
  const w = m.worker.startWorker();
  try {
    const good = evt('ticket.sla_breach', 100, null, { reopened: false });
    await q.add(good.eventType, good, { jobId: good.eventId, attempts: 3 });
    await q.add('ticket.reply', { nonsense: true }, { jobId: 'bad-1', attempts: 3 });
    const deadline = Date.now() + 10_000;
    let processed = false;
    while (Date.now() < deadline) {
      const r = await m.db.pool.query(`SELECT 1 FROM notif.processed_events WHERE event_id = $1`, [good.eventId]);
      processed = (r.rowCount ?? 0) > 0;
      if (processed && (await dlq.count()) > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(processed, 'good event processed by worker');
    assert.equal(await dlq.count(), 1, 'invalid event moved to DLQ without retries');
  } finally {
    await w.close();
    await q.close();
    await dlq.close();
    conn.disconnect();
  }
});

// ── Session-gated delivery ──────────────────────────────────────────────────
const sql = (q: string, p: unknown[] = []) => m.db.pool.query(q, p);
const newSession = async (userId: number, jti: string, ua: string | null = 'okhttp/4.12.0') =>
  sql(`INSERT INTO public.sessions (user_id, jti, user_agent, expires_at) VALUES ($1, $2, $3, now() + interval '7 days')`, [userId, jti, ua]);
// What the backend does on refresh: revoke old + create new in ONE transaction (same now()).
const rotate = async (oldJti: string, newJti: string) => {
  const c = await m.db.pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`UPDATE public.sessions SET revoked = true, revoked_at = now() WHERE jti = $1 RETURNING user_id`, [oldJti]);
    await c.query(`INSERT INTO public.sessions (user_id, jti, user_agent, expires_at) VALUES ($1, $2, 'okhttp/4.12.0', now() + interval '7 days')`, [rows[0].user_id, newJti]);
    await c.query('COMMIT');
  } finally { c.release(); }
};
const logoutSession = (jti: string) => sql(`UPDATE public.sessions SET revoked = true, revoked_at = now() WHERE jti = $1`, [jti]);
const pushTo = async (frag: string) => {
  sent.length = 0;
  await m.processor.processEvent(evt('ticket.reassigned', 100, 1, { previousEmployeeId: '10', newEmployeeId: '11' }));
  return to(frag).length;
};

test('session gate: logout stops pushes to that device only; refresh rotation keeps them', { skip: !enabled }, async () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
  const A3 = 'aaaaaaaa-0000-4000-8000-000000000003';
  await newSession(3, A);
  const r = await call('POST', '/v1/devices/register', token(3, A, 'SUPPORT_AGENT'), { token: 'ExponentPushToken[meera-phone2]', platform: 'android', deviceId: 'device-meera-2' });
  assert.equal(r.status, 200);
  assert.equal(await pushTo('meera-phone2'), 1, 'logged-in device receives');

  await rotate(A, A2);
  await rotate(A2, A3);
  assert.equal(await pushTo('meera-phone2'), 1, 'still receives after two token refreshes');

  await logoutSession(A3);
  assert.equal(await pushTo('meera-phone2'), 0, 'logged-out device receives nothing');
  assert.equal(await pushTo('agentB'), 1, "the user's other logged-in phone still receives");
});

test('session gate: expired session stops pushes', { skip: !enabled }, async () => {
  const E = 'eeeeeeee-0000-4000-8000-000000000001';
  await newSession(3, E);
  await call('POST', '/v1/devices/register', token(3, E, 'SUPPORT_AGENT'), { token: 'ExponentPushToken[meera-phone3]', platform: 'android', deviceId: 'device-meera-3' });
  assert.equal(await pushTo('meera-phone3'), 1);
  await sql(`UPDATE public.sessions SET expires_at = now() - interval '1 minute' WHERE jti = $1`, [E]);
  assert.equal(await pushTo('meera-phone3'), 0);
});

test('session gate: legacy (old app) tokens need an active non-browser session', { skip: !enabled }, async () => {
  await sql(`INSERT INTO public.push_tokens (user_id, token, platform) VALUES (3, 'ExponentPushToken[meera-oldapp]', 'android')`);
  await m.legacy.syncLegacyTokens();
  // Meera still has active app sessions → old-app phone gets it
  assert.equal(await pushTo('meera-oldapp'), 1);
  // log out every app session; leave only a web dashboard login
  await sql(`UPDATE public.sessions SET revoked = true, revoked_at = now() WHERE user_id = 3 AND NOT revoked`);
  await newSession(3, 'bbbbbbbb-0000-4000-8000-000000000001', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0');
  assert.equal(await pushTo('meera-oldapp'), 0, 'web login does not keep a logged-out phone subscribed');
});
