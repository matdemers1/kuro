import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CrSidecar } from '../../src/adapters/crunchyroll.js';
import { seal } from '../../src/crypto/secretbox.js';
import { createDb, type Db } from '../../src/db.js';
import { runSync, type SyncDeps } from '../../src/sync/run.js';
import { SECRET_KEY } from './helpers.js';

/**
 * KURO-T-1.2: a paced, resumable backfill. The fake sidecar serves a synthetic history — 5 pages of
 * 2, newest first — and can be told to fail a page once, which is what a crash or a block mid-run
 * looks like from the vault's side.
 */

const PAGE = 2;
const PAGES = 5;
const day = (n: number) => new Date(Date.UTC(2024, 0, 1 + n, 21)).toISOString();
let history = Array.from({ length: PAGE * PAGES }, (_, i) => ({ id: `GSY${String(i).padStart(3, '0')}`, parent_id: 'GSER1', parent_type: 'series', date_played: day(100 - i), playhead: 1400, fully_watched: true }));
let failOnce: number | null = null;
let failKind: 'upstream' | 'expired' | 'blocked' = 'upstream';
let tokensSeen: string[] = [];

let server: Server;
let db: Db;
let deps: SyncDeps;
let userId = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const b = JSON.parse(body) as { page: number; pageSize: number; refreshToken: string };
      tokensSeen.push(b.refreshToken);
      res.setHeader('content-type', 'application/json');
      if (failOnce === b.page) {
        failOnce = null;
        res.writeHead(failKind === 'expired' ? 401 : failKind === 'blocked' ? 503 : 502).end(JSON.stringify({ error: failKind, message: 'synthetic failure' }));
        return;
      }
      const items = history.slice((b.page - 1) * b.pageSize, b.page * b.pageSize);
      res.end(JSON.stringify({ refreshToken: `rt-after-page-${String(b.page)}`, total: history.length, items }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  db = createDb(process.env['DATABASE_URL'] ?? '');
  deps = { db, sidecar: new CrSidecar(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`), secretKey: SECRET_KEY, log: pino({ level: 'silent' }), pauseMs: 0, pageSize: PAGE };
  const user = await db.user.create({ data: { email: 'sync-owner@example.com', displayName: 'Sync owner' } });
  userId = user.id;
  const sealed = seal('rt-initial', SECRET_KEY);
  await db.crConnection.create({ data: { userId, accountId: '00000000-0000-4000-8000-0000000000bb', deviceId: 'device-1', refreshTokenCiphertext: sealed, refreshTokenNonce: sealed.split('.')[0] ?? '' } });
});

afterAll(async () => {
  server.close();
  await db.$disconnect();
});

beforeEach(() => {
  tokensSeen = [];
});

const playsFor = () => db.play.count({ where: { crParentId: 'GSER1' } });

describe('backfill (KURO-REQ-003, KURO-REQ-004)', () => {
  it('stops at a failure mid-run with the pages before it stored and checkpointed', async () => {
    failOnce = 3;
    const out = await runSync(deps, userId, 'backfill');
    expect(out.status).toBe('failed');
    const run = await db.syncRun.findFirstOrThrow({ where: { kind: 'backfill' }, orderBy: { startedAt: 'desc' } });
    expect(run.lastPage).toBe(2);
    expect(await playsFor()).toBe(4);
  });

  it('resumes from the next page — same run, nothing re-fetched before it — and ends with every play', async () => {
    const out = await runSync(deps, userId, 'backfill');
    expect(out.status).toBe('succeeded');
    expect(await playsFor()).toBe(PAGE * PAGES);
    const runs = await db.syncRun.findMany({ where: { kind: 'backfill' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.lastPage).toBe(PAGES);
    // The first request of the resumed run asked for page 3, carrying the token page 2 returned.
    expect(tokensSeen[0]).toBe('rt-after-page-2');
  });

  it('persists every rotated token, and sets the high-water mark to the newest play', async () => {
    const conn = await db.crConnection.findUniqueOrThrow({ where: { userId } });
    expect(conn.highWaterMark?.toISOString()).toBe(day(100));
    expect(conn.lastSuccessAt).not.toBeNull();
    expect(conn.refreshTokenCiphertext).not.toContain('rt-after');
  });

  it('stores nothing twice when a page is fetched again', async () => {
    await runSync(deps, userId, 'backfill');
    expect(await playsFor()).toBe(PAGE * PAGES);
  });
});

describe('delta (KURO-REQ-006)', () => {
  it('stores what is new and stops at the first page older than the mark', async () => {
    history = [
      { id: 'GSYNEW1', parent_id: 'GSER1', parent_type: 'series', date_played: day(200), playhead: 1400, fully_watched: true },
      { id: 'GSY000', parent_id: 'GSER1', parent_type: 'series', date_played: day(100), playhead: 1400, fully_watched: true },
      ...history.slice(1),
    ];
    const out = await runSync(deps, userId, 'delta');
    expect(out).toMatchObject({ status: 'succeeded', pages: 1, playsNew: 1 });
    expect(await playsFor()).toBe(PAGE * PAGES + 1);
  });

  it('records a later replay of an episode as a new play — rewatches are visible', async () => {
    history = [{ id: 'GSY005', parent_id: 'GSER1', parent_type: 'series', date_played: day(300), playhead: 1400, fully_watched: true }, ...history];
    await runSync(deps, userId, 'delta');
    expect(await db.play.count({ where: { crEpisodeId: 'GSY005' } })).toBe(2);
  });
});

describe('when Crunchyroll refuses (KURO-REQ-007, KURO-REQ-008)', () => {
  it('pauses the connection on an expired session', async () => {
    failOnce = 1;
    failKind = 'expired';
    expect((await runSync(deps, userId, 'delta')).status).toBe('failed');
    expect((await db.crConnection.findUniqueOrThrow({ where: { userId } })).state).toBe('paused');
  });

  it('marks it blocked on a Cloudflare block, and a good run restores it', async () => {
    failOnce = 1;
    failKind = 'blocked';
    await runSync(deps, userId, 'delta');
    expect((await db.crConnection.findUniqueOrThrow({ where: { userId } })).state).toBe('blocked');
    await runSync(deps, userId, 'delta');
    expect((await db.crConnection.findUniqueOrThrow({ where: { userId } })).state).toBe('linked');
  });
});
