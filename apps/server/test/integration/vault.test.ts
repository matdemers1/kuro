import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';

const url = process.env['DATABASE_URL'] ?? '';
let db: Db;
let syncRunId = '';

beforeAll(async () => {
  db = createDb(url);
  const user = await db.user.create({ data: { email: 'vault-owner@example.com', displayName: 'Vault owner' } });
  const conn = await db.crConnection.create({
    data: {
      userId: user.id,
      accountId: '00000000-0000-4000-8000-000000000001',
      deviceId: '00000000-0000-4000-8000-0000000000d1',
      refreshTokenCiphertext: 'ciphertext',
      refreshTokenNonce: 'nonce',
    },
  });
  syncRunId = (await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill' } })).id;
});

afterAll(async () => {
  await db.$disconnect();
});

/** Prisma wraps the driver error; the trigger's own message is kept in `meta`. */
async function refused(op: Promise<unknown>): Promise<string> {
  try {
    await op;
  } catch (err) {
    return JSON.stringify(err, Object.getOwnPropertyNames(err));
  }
  throw new Error('expected the vault to refuse this');
}

function play(episode: string, datePlayed: string) {
  return {
    crEpisodeId: episode,
    crParentId: 'GSERIES01',
    crParentType: 'series' as const,
    datePlayed: new Date(datePlayed),
    playheadS: 1400,
    fullyWatched: true,
    raw: { id: episode },
    syncRunId,
  };
}

describe('the History Vault (KURO-REQ-004)', () => {
  it('stores a play and a later replay of the same episode as two rows', async () => {
    await db.play.create({ data: play('GEP001', '2024-03-03T21:00:00Z') });
    await db.play.create({ data: play('GEP001', '2025-06-01T21:00:00Z') });
    expect(await db.play.count({ where: { crEpisodeId: 'GEP001' } })).toBe(2);
  });

  it('refuses a duplicate observation of the same play', async () => {
    await expect(db.play.create({ data: play('GEP001', '2024-03-03T21:00:00Z') })).rejects.toThrow();
  });

  it('refuses UPDATE', async () => {
    expect(await refused(db.play.updateMany({ where: { crEpisodeId: 'GEP001' }, data: { playheadS: 1 } }))).toMatch(/append-only/);
  });

  it('refuses DELETE', async () => {
    expect(await refused(db.play.deleteMany({ where: { crEpisodeId: 'GEP001' } }))).toMatch(/append-only/);
  });

  it('refuses TRUNCATE', async () => {
    expect(await refused(db.$executeRawUnsafe('TRUNCATE "play"'))).toMatch(/append-only/);
  });

  it('still has both plays afterwards', async () => {
    expect(await db.play.count({ where: { crEpisodeId: 'GEP001' } })).toBe(2);
  });
});
