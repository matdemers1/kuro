import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrSidecar } from '../../src/adapters/crunchyroll.js';
import { canonicalId, resolveCatalog, resolveMarkers, type ResolveDeps } from '../../src/cr/resolve.js';
import { seal } from '../../src/crypto/secretbox.js';
import { createDb, type Db } from '../../src/db.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { SECRET_KEY } from './helpers.js';

/** A synthetic series: S1 in Japanese (original) and its English dub as a second CR season. */
const ep = (id: string, n: number, locale: string, versions: [string, string, boolean][]) => ({
  id, title: `Episode ${String(n)}`, episode_number: n, sequence_number: n, duration_ms: 1_440_000, audio_locale: locale, episode_air_date: '2024-01-0' + String(n) + 'T15:00:00Z',
  versions: versions.map(([guid, l, original]) => ({ guid, audio_locale: l, original })),
});
const catalog: Record<string, unknown[]> = {
  'series/GRSER': [{ id: 'GRSER', title: 'Synthetic Show', slug_title: 'synthetic-show', description: 'A test series.' }],
  'series/GRSER/seasons': [
    { id: 'GSJA', title: 'Synthetic Show', season_number: 1, season_sequence_number: 1, audio_locale: 'ja-JP' },
    { id: 'GSEN', title: 'Synthetic Show (English Dub)', season_number: 1, season_sequence_number: 1, audio_locale: 'en-US' },
  ],
  'seasons/GSJA/episodes': [1, 2].map((n) => ep(`GJA${String(n)}`, n, 'ja-JP', [[`GJA${String(n)}`, 'ja-JP', true], [`GEN${String(n)}`, 'en-US', false]])),
  'seasons/GSEN/episodes': [1, 2].map((n) => ep(`GEN${String(n)}`, n, 'en-US', [[`GJA${String(n)}`, 'ja-JP', true], [`GEN${String(n)}`, 'en-US', false]])),
};
const markers: Record<string, unknown> = { GEN1: { credits: { start: 1300.7, end: 1390 } } };
const cmsCalls: string[] = [];

let server: Server;
let db: Db;
let deps: ResolveDeps;
let userId = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const b = JSON.parse(body) as { path?: string; episodeId?: string };
      res.setHeader('content-type', 'application/json');
      if (req.url === '/skip-events') {
        res.end(JSON.stringify({ events: markers[b.episodeId ?? ''] ?? null }));
        return;
      }
      cmsCalls.push(b.path ?? '');
      res.end(JSON.stringify({ refreshToken: 'rt', body: { data: catalog[b.path ?? ''] ?? [] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  db = createDb(process.env['DATABASE_URL'] ?? '');
  deps = { db, sidecar: new CrSidecar(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`), secretKey: SECRET_KEY, log: pino({ level: 'silent' }), pauseMs: 0 };
  const user = await db.user.create({ data: { email: 'resolve-owner@example.com', displayName: 'R' } });
  userId = user.id;
  const sealed = seal('rt', SECRET_KEY);
  const conn = await db.crConnection.create({ data: { userId, accountId: '00000000-0000-4000-8000-0000000000dd', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill' } });
  // Watched episode 1 in Japanese, then episode 1 again and episode 2 in the English dub.
  for (const [id, when] of [['GJA1', '2024-02-01T21:00:00Z'], ['GEN1', '2024-03-01T21:00:00Z'], ['GEN2', '2024-03-02T21:00:00Z']] as const) {
    await db.play.create({ data: { crEpisodeId: id, crParentId: 'GRSER', crParentType: 'series', datePlayed: new Date(when), playheadS: 1440, fullyWatched: true, raw: { id }, syncRunId: run.id } });
  }
});

afterAll(async () => {
  server.close();
  await db.$disconnect();
});

describe('resolving the catalog (KURO-REQ-011, KURO-REQ-012)', () => {
  it('picks the original version as the canonical episode', () => {
    expect(canonicalId({ id: 'GEN1', versions: [{ guid: 'GJA1', original: true }, { guid: 'GEN1', original: false }] })).toBe('GJA1');
    expect(canonicalId({ id: 'GSOLO', versions: [] })).toBe('GSOLO');
  });

  it('mirrors the series, both audio seasons and every episode', async () => {
    const out = await resolveCatalog(deps, userId);
    expect(out).toMatchObject({ series: 1, episodes: 4 });
    expect(await db.crSeason.count({ where: { seriesId: 'GRSER' } })).toBe(2);
    expect((await db.crSeason.findUniqueOrThrow({ where: { id: 'GSEN' } })).audioLocale).toBe('en-US');
  });

  it('folds every play onto a canonical episode: a sub and a dub play of episode 1 are one episode', async () => {
    const plays = await db.play.findMany({ where: { crParentId: 'GRSER' }, select: { crEpisodeId: true } });
    const episodes = await db.crEpisode.findMany({ where: { id: { in: plays.map((p) => p.crEpisodeId) } }, select: { canonicalId: true } });
    expect(episodes).toHaveLength(3);
    expect(new Set(episodes.map((e) => e.canonicalId))).toEqual(new Set(['GJA1', 'GJA2']));
  });

  it('records credits markers where published, and asks for each played episode once', async () => {
    expect(await resolveMarkers(deps, userId)).toEqual({ checked: 3, markers: 1 });
    expect((await resolveMarkers(deps, userId)).checked).toBe(0);
    expect((await db.crEpisode.findUniqueOrThrow({ where: { id: 'GEN1' } })).creditsStartS).toBe(1300);
    const without = await db.crEpisode.findUniqueOrThrow({ where: { id: 'GJA1' } });
    expect(without.creditsStartS).toBeNull();
    expect(without.skipCheckedAt).not.toBeNull();
  });

  it('does not re-fetch a series it resolved today', async () => {
    const before = cmsCalls.length;
    expect((await resolveCatalog(deps, userId)).series).toBe(0);
    expect(cmsCalls.length).toBe(before);
  });

  it('derives the Show, and two rebuilds produce identical rows (KURO-REQ-017)', async () => {
    const now = new Date('2026-10-20T03:00:00Z');
    await rebuildShows(db, userId, now);
    const first = await db.showState.findMany({ orderBy: { showKey: 'asc' } });
    await rebuildShows(db, userId, now);
    const second = await db.showState.findMany({ orderBy: { showKey: 'asc' } });
    expect(second).toEqual(first);
    const s = first.find((r) => r.showKey === 'cr:GRSER');
    // E1 watched (sub then dub), E2 watched in the dub: the show is complete, all in one Show.
    expect(s).toMatchObject({ title: 'Synthetic Show', watchedEpisodes: 2, totalEpisodes: 2, status: 'completed' });
  });
});
