import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seal } from '../../src/crypto/secretbox.js';
import { createDb, type Db } from '../../src/db.js';
import { NIGHTLY_CRON, nightlyPlan } from '../../src/jobs/queue.js';
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
  await db.crConnection.create({ data: { userId: user.id, accountId: '00000000-0000-4000-8000-0000000000cc', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n', ...data } });
  return user.id;
}

describe('nightly sync (KURO-REQ-005)', () => {
  it('runs at 03:00', () => {
    expect(NIGHTLY_CRON).toBe('0 3 * * *');
  });

  it('queues a delta once a backfill has finished, a backfill before that, and nothing while paused', async () => {
    const synced = await connection('n-synced@example.com', { lastSuccessAt: new Date() });
    const fresh = await connection('n-fresh@example.com', {});
    const paused = await connection('n-paused@example.com', { state: 'paused', lastSuccessAt: new Date() });
    const blocked = await connection('n-blocked@example.com', { state: 'blocked', lastSuccessAt: new Date() });
    const plan = new Map((await nightlyPlan({ db })).map((p) => [p.userId, p.kind]));
    expect(plan.get(synced)).toBe('delta');
    expect(plan.get(fresh)).toBe('backfill');
    expect(plan.has(paused)).toBe(false);
    // Blocked is retried: a block is usually temporary, and the alert fires after two nights.
    expect(plan.get(blocked)).toBe('delta');
  });
});
