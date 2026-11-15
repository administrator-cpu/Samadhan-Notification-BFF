// Call pushes (Track 3). Unit tests always run; the delivery tests need Postgres, e.g.:
//   TEST_POSTGRES_PORT=5432 TEST_POSTGRES_DB=samadhan_test npm run test:calls
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

const enabled = !!process.env.TEST_POSTGRES_PORT;

// Fake APNs (h2c). Tokens starting with "dead" are Unregistered, "bad" BadDeviceToken, "flaky" fail once with 503.
const apnsSent: { token: string; headers: http2.IncomingHttpHeaders; body: any }[] = [];
const flakyOnce = new Set<string>();
const apns = http2.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const token = String(req.headers[':path']).split('/').pop()!;
    apnsSent.push({ token, headers: req.headers, body: JSON.parse(body) });
    const reply = (status: number, reason?: string) => {
      res.writeHead(status, { 'apns-id': randomUUID(), 'content-type': 'application/json' });
      res.end(reason ? JSON.stringify({ reason }) : '');
    };
    if (token.startsWith('dead')) return reply(410, 'Unregistered');
    if (token.startsWith('bad')) return reply(400, 'BadDeviceToken');
    if (token.startsWith('f1a')) {
      if (!flakyOnce.has(token)) {
        flakyOnce.add(token);
        return reply(503, 'ServiceUnavailable');
      }
    }
    reply(200);
  });
});

// Fake Google OAuth + FCM v1.
const fcmSent: any[] = [];
const fcm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
  if (req.url?.endsWith('/messages:send')) {
    const msg = JSON.parse(body).message;
    fcmSent.push(msg);
    if (msg.token.includes('deadfcm')) {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }));
    }
    return res.end(JSON.stringify({ name: `projects/p/messages/${randomUUID()}` }));
  }
  res.writeHead(404).end('{}');
});

const VOIP_OK = 'a'.repeat(64);
const VOIP_DEAD = 'dead' + 'b'.repeat(60);
const VOIP_FLAKY = 'f1a' + 'c'.repeat(61);
const FCM_OK = 'fcm_ok_' + 'x'.repeat(140);
const FCM_DEAD = 'deadfcm_' + 'y'.repeat(140);

let m: any = {};

before(async () => {
  m.contract = await import('../src/calls/contract.js');
  if (!enabled) return;
  const dbName = process.env.TEST_POSTGRES_DB ?? 'samadhan_test';
  if (!/test/i.test(dbName)) throw new Error(`Refusing to run: TEST_POSTGRES_DB "${dbName}" must contain "test" (tables are dropped).`);
  await new Promise<void>((r) => apns.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => fcm.listen(0, '127.0.0.1', () => r()));
  const fcmBase = `http://127.0.0.1:${(fcm.address() as AddressInfo).port}`;
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: process.env.TEST_POSTGRES_PORT,
    POSTGRES_DB: dbName,
    POSTGRES_USER: process.env.TEST_POSTGRES_USER ?? 'postgres',
    POSTGRES_PASSWORD: process.env.TEST_POSTGRES_PASSWORD ?? '',
    JWT_SECRET: 'test-secret',
    LOG_LEVEL: 'error',
    APNS_KEY_ID: 'KEY123',
    APNS_TEAM_ID: 'TEAM123',
    APNS_BUNDLE_ID: 'com.example.app',
    APNS_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    APNS_ENV: 'production',
    APNS_ORIGIN_OVERRIDE: `http://127.0.0.1:${(apns.address() as AddressInfo).port}`,
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'p',
      client_email: 'svc@p.iam.gserviceaccount.com',
      private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      token_uri: `${fcmBase}/token`,
    }),
    FCM_API_URL: fcmBase,
    EXPO_API_URL: `${fcmBase}/expo`,
  });
  m.db = await import('../src/db.js');
  m.migrate = await import('../src/scripts/migrate-lib.js');
  m.processor = await import('../src/calls/processor.js');
  m.apns = await import('../src/push/apns.js');

  await m.db.pool.query(await readFile(new URL('./fixtures/backend-schema.sql', import.meta.url), 'utf8'));
  await m.migrate.runMigrations();
  await m.db.pool.query(`UPDATE public.users SET email = 'user' || id || '@example.com'`);
  await m.db.pool.query(
    `INSERT INTO notif.device_tokens (user_id, device_id, platform, kind, token) VALUES
       (4, 'ios-1', 'ios', 'apns_voip', $1), (4, 'ios-2', 'ios', 'apns_voip', $2),
       (4, 'and-1', 'android', 'fcm', $3), (4, 'and-2', 'android', 'fcm', $4),
       (2, 'ios-3', 'ios', 'apns_voip', $5)`,
    [VOIP_OK, VOIP_DEAD, FCM_OK, FCM_DEAD, VOIP_FLAKY],
  );
});

after(async () => {
  if (!enabled) return;
  m.apns.closeApns();
  await m.db.pool.end();
  apns.close();
  fcm.close();
});

const job = (over: Record<string, unknown> = {}) => ({
  version: 1,
  jobId: randomUUID(),
  type: 'call_invite',
  toEmail: 'User4@Example.com',
  callId: 'call-1',
  ticketId: 42,
  ticketNumber: 'T-42',
  callerName: 'Ravi',
  fromEmail: 'user2@example.com',
  declineToken: 'secret',
  ttlSec: 50,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 50_000).toISOString(),
  ...over,
});

test('contract: payload is a flat string map', () => {
  const parsed = m.contract.callJobSchema.parse(job());
  assert.equal(parsed.toEmail, 'user4@example.com');
  const p = m.contract.callPayload(parsed);
  for (const v of Object.values(p)) assert.equal(typeof v, 'string');
  assert.equal(p.ticketId, '42');
  assert.equal(p.type, 'call_invite');
  assert.ok(Number(p.expiresAt) > Date.now());
  assert.equal(p.reason, undefined);
});

test('contract: rejects bad jobs', () => {
  assert.equal(m.contract.callJobSchema.safeParse(job({ type: 'call_ring' })).success, false);
  assert.equal(m.contract.callJobSchema.safeParse(job({ jobId: 'x' })).success, false);
});

test('invite: VoIP + FCM, dead tokens pruned, logged per device', { skip: !enabled }, async () => {
  const j = job();
  const r = await m.processor.processCallJob(j);
  assert.equal(r.sent, 2);
  assert.equal(r.pruned, 2);

  const voip = apnsSent.find((s) => s.token === VOIP_OK)!;
  assert.equal(voip.headers['apns-push-type'], 'voip');
  assert.equal(voip.headers['apns-topic'], 'com.example.app.voip');
  assert.equal(voip.headers['apns-priority'], '10');
  assert.ok(Number(voip.headers['apns-expiration']) > Date.now() / 1000);
  assert.match(String(voip.headers.authorization), /^bearer ey/);
  assert.equal(voip.body.callId, 'call-1');
  assert.equal(voip.body.callerName, 'Ravi');
  assert.deepEqual(voip.body.aps, {});

  const msg = fcmSent.find((s) => s.token === FCM_OK)!;
  assert.equal(msg.android.priority, 'HIGH');
  assert.match(msg.android.ttl, /^\d+s$/);
  assert.equal(msg.data.type, 'call_invite');
  assert.equal(msg.data.declineToken, 'secret');
  assert.equal(JSON.parse(msg.data.body).callId, 'call-1');
  assert.equal(msg.notification, undefined);

  const { rows } = await m.db.pool.query(`SELECT provider, status FROM notif.delivery_log WHERE event_id = $1 ORDER BY provider, status`, [j.jobId]);
  assert.deepEqual(rows.map((x: any) => `${x.provider}:${x.status}`), ['apns:failed', 'apns:sent', 'fcm:failed', 'fcm:sent']);
  const left = await m.db.pool.query(`SELECT token FROM notif.device_tokens WHERE user_id = 4 ORDER BY token`);
  assert.deepEqual(left.rows.map((x: any) => x.token).sort(), [VOIP_OK, FCM_OK].sort());
});

test('retry: a 503 throws, the next attempt skips devices that already got it', { skip: !enabled }, async () => {
  const j = job({ toEmail: 'user2@example.com', callId: 'call-2' });
  await assert.rejects(m.processor.processCallJob(j), /will retry/);
  const r = await m.processor.processCallJob(j);
  assert.equal(r.sent, 1);
  const again = await m.processor.processCallJob(j);
  assert.equal(again.status, 'duplicate');
});

test('expired invite is dropped; cancel still goes out', { skip: !enabled }, async () => {
  const before = apnsSent.length;
  const expired = await m.processor.processCallJob(job({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(expired.status, 'expired');
  assert.equal(apnsSent.length, before);

  const cancel = await m.processor.processCallJob(
    job({ type: 'call_cancel', reason: 'answered_elsewhere', ttlSec: 60, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  );
  assert.equal(cancel.sent, 2);
  assert.equal(apnsSent.at(-1)!.body.reason, 'answered_elsewhere');

  const excluded = await m.processor.processCallJob(
    job({ type: 'call_cancel', excludeDeviceId: 'ios-1', ttlSec: 60, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  );
  assert.equal(excluded.sent, 1);
  assert.equal(fcmSent.at(-1)!.data.type, 'call_cancel');
});

test('unknown user and receipts poller ignore call rows', { skip: !enabled }, async () => {
  const r = await m.processor.processCallJob(job({ toEmail: 'nobody@example.com' }));
  assert.equal(r.status, 'no_user');
  await m.db.pool.query(`UPDATE notif.delivery_log SET created_at = now() - interval '2 days' WHERE provider <> 'expo'`);
  const receipts = await import('../src/jobs/receipts.js');
  const res = await receipts.pollReceipts();
  assert.equal(res.missing, 0);
});
