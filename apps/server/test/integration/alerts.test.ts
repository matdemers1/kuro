import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrSidecar } from '../../src/adapters/crunchyroll.js';
import { seal } from '../../src/crypto/secretbox.js';
import { createDb, type Db } from '../../src/db.js';
import { checkAlerts, syncHealth } from '../../src/jobs/alertsCheck.js';
import { Alerts, type PushTransport } from '../../src/push/sender.js';
import { runSync } from '../../src/sync/run.js';
import { SECRET_KEY } from './helpers.js';

/** Pushes that "arrived", by device endpoint. `gone` endpoints answer 410 once. */
const delivered: { endpoint: string; payload: string }[] = [];
const gone = new Set<string>();
const transport: PushTransport = {
  send(target, payload) {
    if (gone.has(target.endpoint)) return Promise.resolve('gone');
    delivered.push({ endpoint: target.endpoint, payload });
    return Promise.resolve('ok');
  },
};

let reply: 'expired' | 'blocked' = 'expired';
let server: Server;
let db: Db;
let alerts: Alerts;
const log = pino({ level: 'silent' });

async function owner(email: string, lastSuccessHoursAgo: number | null) {
  const user = await db.user.create({ data: { email, displayName: email } });
  const sealed = seal('rt', SECRET_KEY);
  const conn = await db.crConnection.create({
    data: {
      userId: user.id, accountId: '00000000-0000-4000-8000-0000000000ee', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n',
      ...(lastSuccessHoursAgo !== null ? { lastSuccessAt: new Date(Date.now() - lastSuccessHoursAgo * 3_600_000) } : {}),
    },
  });
  return { userId: user.id, connId: conn.id };
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.writeHead(reply === 'expired' ? 401 : 503).end(JSON.stringify({ error: reply, message: 'synthetic' }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  db = createDb(process.env['DATABASE_URL'] ?? '');
  alerts = new Alerts(db, transport, log);
  await db.pushSubscription.create({ data: { endpoint: 'https://push.example/device-1', p256dh: 'p', auth: 'a' } });
});

afterAll(async () => {
  server.close();
  await db.$disconnect();
});

const sidecarDeps = () => ({ db, sidecar: new CrSidecar(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`), secretKey: SECRET_KEY, log, pauseMs: 0 });
const pushesWith = (title: string) => delivered.filter((d) => d.payload.includes(title)).length;
/** Alerts recorded for one connection — other files leave connections behind, so never count globally. */
const alertsFor = (prefix: string, connId: string) => db.alert.findMany({ where: { key: { startsWith: `${prefix}:${connId}:` } } });

describe('alert dedupe (KURO-REQ-020)', () => {
  it('sends a key once, never twice', async () => {
    expect(await alerts.send({ key: 'k-1', title: 'Once', body: 'b' })).toBe(true);
    expect(await alerts.send({ key: 'k-1', title: 'Once', body: 'b' })).toBe(false);
    expect(pushesWith('Once')).toBe(1);
  });

  it('forgets a device the push service says is gone', async () => {
    await db.pushSubscription.create({ data: { endpoint: 'https://push.example/old-phone', p256dh: 'p', auth: 'a' } });
    gone.add('https://push.example/old-phone');
    await alerts.send({ key: 'k-2', title: 'Two', body: 'b' });
    expect(await db.pushSubscription.findUnique({ where: { endpoint: 'https://push.example/old-phone' } })).toBeNull();
  });
});

describe('the hourly health check (KURO-REQ-007, 008, 009)', () => {
  it('an expired session pauses sync, shows the re-link state, and pushes once', async () => {
    const { userId, connId } = await owner('a-expired@example.com', 1);
    reply = 'expired';
    expect((await runSync(sidecarDeps(), userId, 'delta')).status).toBe('failed');
    expect((await syncHealth(db, userId)).state).toBe('paused');
    await checkAlerts(db, alerts);
    await checkAlerts(db, alerts);
    const sent = await alertsFor('cr-expired', connId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delivered).toBe(1);
  });

  it('two blocked runs alert once; one does not', async () => {
    const { userId, connId } = await owner('a-blocked@example.com', 1);
    reply = 'blocked';
    await runSync(sidecarDeps(), userId, 'delta');
    await checkAlerts(db, alerts);
    expect(await alertsFor('cr-blocked', connId)).toHaveLength(0);
    await runSync(sidecarDeps(), userId, 'delta');
    await checkAlerts(db, alerts);
    await checkAlerts(db, alerts);
    expect(await alertsFor('cr-blocked', connId)).toHaveLength(1);
  });

  it('stale after 36 hours: 37 hours alerts once and shows the banner state; 35 does not', async () => {
    const fresh = await owner('a-35h@example.com', 35);
    expect((await syncHealth(db, fresh.userId)).stale).toBe(false);
    const stale = await owner('a-37h@example.com', 37);
    expect((await syncHealth(db, stale.userId)).stale).toBe(true);
    await checkAlerts(db, alerts);
    await checkAlerts(db, alerts);
    expect(await alertsFor('stale', stale.connId)).toHaveLength(1);
    expect(await alertsFor('stale', fresh.connId)).toHaveLength(0);
  });
});
