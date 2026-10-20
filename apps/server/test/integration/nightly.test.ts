import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seal } from '../../src/crypto/secretbox.js';
import { createDb, type Db } from '../../src/db.js';
import { pino } from 'pino';
import { CrSidecar } from '../../src/adapters/crunchyroll.js';
import { NIGHTLY_CRON, nightlyPlan, resumeInterrupted, type SyncQueue } from '../../src/jobs/queue.js';
import { SECRET_KEY } from './helpers.js';

let db: Db;
beforeAll(() => {
  db = createDb(process.env['DATABASE_URL'] ?? '');
});
afterAll(async () => {
  await db.$disconnect();
});

async function connection(email: string, data: { state?: 'linked' | 'paused' | 'blocked'; lastSuccessAt?: Date }) {
  const user = await db.user.create({ data: { email, displayName: email } });
  const sealed = seal('rt', SECRET_KEY);
  const conn = await db.crConnection.create({ data: { userId: user.id, accountId: '00000000-0000-4000-8000-0000000000cc', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n', ...data } });
  return { userId: user.id, connId: conn.id };
}

describe('nightly sync (KURO-REQ-005)', () => {
  it('runs at 03:00', () => {
    expect(NIGHTLY_CRON).toBe('0 3 * * *');
  });

  it('queues a delta once a backfill has finished, a backfill before that, and nothing while paused', async () => {
    const { userId: synced } = await connection('n-synced@example.com', { lastSuccessAt: new Date() });
    const { userId: fresh } = await connection('n-fresh@example.com', {});
    const { userId: paused } = await connection('n-paused@example.com', { state: 'paused', lastSuccessAt: new Date() });
    const { userId: blocked } = await connection('n-blocked@example.com', { state: 'blocked', lastSuccessAt: new Date() });
    const plan = new Map((await nightlyPlan({ db })).map((p) => [p.userId, p.kind]));
    expect(plan.get(synced)).toBe('delta');
    expect(plan.get(fresh)).toBe('backfill');
    expect(plan.has(paused)).toBe(false);
    // Blocked is retried: a block is usually temporary, and the alert fires after two nights.
    expect(plan.get(blocked)).toBe('delta');
  });
});

async function bootRequests(): Promise<[string, string][]> {
  const requests: [string, string][] = [];
  const queue: SyncQueue = { request: (userId, kind) => { requests.push([userId, kind]); return Promise.resolve(); }, stop: () => Promise.resolve() };
  await resumeInterrupted({ db, sidecar: new CrSidecar('http://127.0.0.1:9'), secretKey: SECRET_KEY, log: pino({ level: 'silent' }) }, queue);
  return requests;
}

describe('at boot', () => {
  it('resumes a cut-short backfill, and finishes a derivation a restart interrupted — on the sync queue', async () => {
    const midImport = await connection('b-mid@example.com', {});
    const underived = await connection('b-underived@example.com', { lastSuccessAt: new Date() });
    const settled = await connection('b-settled@example.com', { lastSuccessAt: new Date() });
    await db.syncRun.create({ data: { crConnectionId: midImport.connId, kind: 'backfill', status: 'running', lastPage: 3 } });
    await db.syncRun.create({ data: { crConnectionId: underived.connId, kind: 'backfill', status: 'succeeded' } });
    await db.syncRun.create({ data: { crConnectionId: settled.connId, kind: 'backfill', status: 'succeeded', derivedAt: new Date() } });

    // Shows exist, so the boot rebuild has nothing to do here (the next test covers it).
    await db.show.create({ data: { showKey: 'cr:BOOTSHOW', title: 'Boot', franchiseKey: 'fr:cr:BOOTSHOW', seriesIds: [], derivedAt: new Date() } });
    try {
      const mine = (await bootRequests()).filter(([u]) => [midImport.userId, underived.userId, settled.userId].includes(u));
      expect(mine).toEqual([[midImport.userId, 'backfill'], [underived.userId, 'derive']]);
    } finally {
      await db.show.delete({ where: { showKey: 'cr:BOOTSHOW' } });
    }
  });

  it('rebuilds at boot when there are no Shows yet — the first deploy of a new derived table', async () => {
    const owner = await connection('b-noshows@example.com', { lastSuccessAt: new Date() });
    await db.syncRun.create({ data: { crConnectionId: owner.connId, kind: 'backfill', status: 'succeeded', derivedAt: new Date() } });
    await db.show.deleteMany();
    expect((await bootRequests()).filter(([u]) => u === owner.userId)).toEqual([[owner.userId, 'match']]);
  });
});
