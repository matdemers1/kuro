import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEEP_NIGHTLY, nightlyBackup, restoreCheck, rotate, upNextOf } from '../../src/backup/nightly.js';
import { dumpDatabase } from '../../src/boot.js';
import { seal } from '../../src/crypto/secretbox.js';
import type { Db } from '../../src/db.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { freshDatabase, SECRET_KEY } from './helpers.js';

/**
 * KURO-T-6.2: the nightly dump, its rotation to fourteen, and the restore check — last night's dump
 * restored into a scratch database gives the same Up Next as the live one. In a database of its own,
 * since a restore check expects Kurō's one owner.
 */

let fresh: { url: string; db: Db; drop(): Promise<void> };
let dir = '';
const log = pino({ level: 'silent' });

beforeAll(async () => {
  fresh = await freshDatabase('kuro_backup_test');
  const db = fresh.db;
  dir = await mkdtemp(join(tmpdir(), 'kuro-backups-'));
  const user = await db.user.create({ data: { email: 'backup@example.com', displayName: 'B' } });
  const sealed = seal('rt', SECRET_KEY);
  const conn = await db.crConnection.create({ data: { userId: user.id, accountId: '00000000-0000-4000-8000-0000000000f7', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } });
  for (const id of ['GBKA', 'GBKB']) {
    await db.crSeries.create({ data: { id, title: `Backup ${id}`, raw: {} } });
    await db.crSeason.create({ data: { id: `${id}S1`, seriesId: id, title: 'Season 1', seasonNumber: 1, raw: {} } });
    await db.crEpisode.createMany({ data: [1, 2, 3].map((n) => ({ id: `${id}E${String(n)}`, seasonId: `${id}S1`, title: `E${String(n)}`, episodeNumber: n, sequenceNumber: n, durationS: 1420, canonicalId: `${id}E${String(n)}`, raw: {} })) });
  }
  const play = (ep: string, series: string, hoursAgo: number) => ({ crEpisodeId: ep, crParentId: series, crParentType: 'series' as const, datePlayed: new Date(Date.now() - hoursAgo * 3_600_000), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: run.id });
  await db.play.createMany({ data: [play('GBKAE1', 'GBKA', 5), play('GBKBE1', 'GBKB', 3), play('GBKBE2', 'GBKB', 2)] });
  await db.showPreference.create({ data: { showKey: 'cr:GBKA', pinned: true } });
  await rebuildShows(db, user.id);
}, 60_000);

afterAll(async () => {
  await fresh.drop();
});

describe('the nightly backup (KURO-T-6.2)', () => {
  it('keeps the newest fourteen nightly dumps and leaves other dumps alone', async () => {
    const d = await mkdtemp(join(tmpdir(), 'kuro-rotate-'));
    for (let i = 0; i < 17; i += 1) await writeFile(join(d, `2026-10-${String(i + 1).padStart(2, '0')}T04-30-00-000Z-nightly.dump`), '');
    await writeFile(join(d, '2026-01-01T00-00-00-000Z-manual.dump'), '');
    expect(await rotate(d, 'nightly', KEEP_NIGHTLY)).toHaveLength(3);
    const left = (await readdir(d)).sort();
    expect(left.filter((f) => f.endsWith('-nightly.dump'))).toHaveLength(14);
    expect(left[0]).toBe('2026-01-01T00-00-00-000Z-manual.dump');
    expect(left).not.toContain('2026-10-01T04-30-00-000Z-nightly.dump');
  });

  it('restoring last night’s dump into a scratch database gives the identical Up Next', async () => {
    const out = await nightlyBackup(fresh.db, { databaseUrl: fresh.url, backupDir: dir, log });
    expect(out).toMatchObject({ check: 'ok' });
    expect(out.detail).toMatch(/3 plays; Up Next identical \(2 shows\)/);
    const row = await fresh.db.backupRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    expect(row).toMatchObject({ check: 'ok', file: out.file });
    expect(Number(row.sizeBytes)).toBeGreaterThan(0);
    expect((await upNextOf(fresh.db)).map((u) => u.showKey)).toEqual(['cr:GBKA', 'cr:GBKB']);
  });

  it('a dump that has fallen behind the live database fails the check', async () => {
    const stale = await dumpDatabase(fresh.url, dir, 'manual');
    const run = await fresh.db.syncRun.findFirstOrThrow();
    await fresh.db.play.create({ data: { crEpisodeId: 'GBKAE2', crParentId: 'GBKA', crParentType: 'series', datePlayed: new Date(), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: run.id } });
    expect(await restoreCheck(fresh.db, fresh.url, stale)).toMatchObject({ ok: false, detail: expect.stringMatching(/the restore has 3 plays; live has 4/) as string });
  });
});
