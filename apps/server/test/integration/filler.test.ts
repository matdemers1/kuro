import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FillerClient } from '../../src/adapters/fillerlist.js';
import { setPassword } from '../../src/auth/login.js';
import { seal } from '../../src/crypto/secretbox.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { refreshFiller } from '../../src/filler/refresh.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-5.3: a long matched Show — two Seasons, numbered straight through by its filler guide — gets
 * its filler marks after a refresh from a fake guide, and the skip toggle takes them out of Up Next
 * and out of what Completed waits for. Change-logged and undoable.
 */

let h: Harness;
let cookie = '';
let userId = '';
const RELEASE = randomUUID();
const KEY = 'show:anilist:7101';
const log = pino({ level: 'silent' });
const requested: string[] = [];
const guide: FillerClient = {
  index: () => Promise.resolve([{ slug: 'long-saga', title: 'Long Saga (Nagai Monogatari)' }, { slug: 'other', title: 'Some Other Show' }]),
  episodes: (slug) => {
    requested.push(slug);
    // 1–20 in Season 1, 21–45 in Season 2: 20 and 22–23 are filler, 24 mixed.
    return Promise.resolve(Array.from({ length: 45 }, (_, i) => ({ number: i + 1, kind: i + 1 === 20 || i + 1 === 22 || i + 1 === 23 ? ('filler' as const) : i + 1 === 24 ? ('mixed' as const) : ('canon' as const) })));
  },
};

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'filler@example.com', displayName: 'F' } });
  userId = user.id;
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'filler owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'filler@example.com', password: 'filler owner password' })), 'kuro_session') ?? '';
  const entry = (id: number, title: string, episodes: number, year: number) => ({ id: `anilist:${String(id)}`, title, type: 'TV', episodes, status: 'FINISHED', season: 'SPRING', seasonYear: year, synonyms: [], sources: [], related: [], tags: [], studios: [], anilistId: id, releaseId: RELEASE, updatedAt: new Date() });
  await h.db.catalogEntry.createMany({ data: [entry(7101, 'Nagai Monogatari', 20, 2010), entry(7102, 'Nagai Monogatari 2nd Season', 25, 2012)] });
  const media = (id: number, edges: [string, number][]) => ({ anilistId: id, payload: { id, idMal: null, format: null, episodes: null, season: null, seasonYear: null, title: { romaji: null, english: null, native: null }, synonyms: [], externalLinks: [], relations: { edges: edges.map(([relationType, node]) => ({ relationType, node: { id: node, type: 'ANIME', format: null } })) } } });
  await h.db.anilistMedia.createMany({ data: [media(7101, [['SEQUEL', 7102]]), media(7102, [['PREQUEL', 7101]])] });
  const sealed = seal('rt', SECRET_KEY);
  const conn = await h.db.crConnection.create({ data: { userId, accountId: '00000000-0000-4000-8000-0000000000f4', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await h.db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } });
  await h.db.crSeries.create({ data: { id: 'GLONG', title: 'Long Saga', raw: {} } });
  for (const [id, n, eps, entryId] of [['GLONG1', 1, 20, 'anilist:7101'], ['GLONG2', 2, 25, 'anilist:7102']] as const) {
    await h.db.crSeason.create({ data: { id, seriesId: 'GLONG', title: `Season ${String(n)}`, seasonNumber: n, seasonSequenceNumber: n, raw: {} } });
    await h.db.crEpisode.createMany({ data: Array.from({ length: eps }, (_, i) => ({ id: `${id}E${String(i + 1)}`, seasonId: id, title: `S${String(n)} episode ${String(i + 1)}`, episodeNumber: i + 1, sequenceNumber: i + 1, durationS: 1420, canonicalId: `${id}E${String(i + 1)}`, raw: {} })) });
    await h.db.mapping.create({ data: { crSeasonId: id, epFrom: 1, epTo: eps, catalogEntryId: entryId, offset: 0, source: 'auto', status: 'accepted', confidence: 'strong', signals: [], candidates: [] } });
  }
  // Crunchyroll's separate subtitled re-release of Season 1: the same twenty episodes under other IDs.
  await h.db.crSeason.create({ data: { id: 'GLONG1J', seriesId: 'GLONG', title: 'Season 1 Special Edition HD, Subtitled', seasonNumber: 3, seasonSequenceNumber: 3, audioLocale: 'ja-JP', raw: {} } });
  await h.db.crEpisode.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ id: `GLONG1JE${String(i + 1)}`, seasonId: 'GLONG1J', title: `S1 SE episode ${String(i + 1)}`, episodeNumber: i + 1, sequenceNumber: i + 1, durationS: 1420, audioLocale: 'ja-JP', canonicalId: `GLONG1JE${String(i + 1)}`, raw: {} })) });
  await h.db.mapping.create({ data: { crSeasonId: 'GLONG1J', epFrom: 1, epTo: 20, catalogEntryId: 'anilist:7101', offset: 0, source: 'auto', status: 'accepted', confidence: 'strong', signals: [], candidates: [] } });
  // Season 1 up to episode 19, then Season 2's first episode.
  for (const [ep, i] of [...Array.from({ length: 19 }, (_, i) => [`GLONG1E${String(i + 1)}`, i] as const), ['GLONG2E1', 19] as const]) {
    await h.db.play.create({ data: { crEpisodeId: ep, crParentId: 'GLONG', crParentType: 'series', datePlayed: new Date(Date.now() - (30 - i) * 3_600_000), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: run.id } });
  }
  await rebuildShows(h.db, userId);
});

afterAll(async () => {
  await h.db.fillerList.deleteMany({ where: { slug: { in: ['long-saga', 'other'] } } });
  await h.db.mapping.deleteMany({ where: { crSeasonId: { startsWith: 'GLONG' } } });
  await h.db.catalogEntry.deleteMany({ where: { releaseId: RELEASE } });
  await h.db.anilistMedia.deleteMany({ where: { anilistId: { in: [7101, 7102] } } });
  await h.db.showPreference.deleteMany({ where: { showKey: KEY } });
  await h.close();
});

interface Detail { skipFiller: boolean; filler: { count: number; mixed: number } | null; episodes: { crEpisodeId: string; filler: string | null; isNext: boolean }[] }
const detail = async () => (await (await fetch(`${h.base}/api/shows/${encodeURIComponent(KEY)}`, { headers: { cookie } })).json()) as Detail;
const put = (path: string, body: unknown) => fetch(`${h.base}${path}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const next = async () => (await h.db.showState.findUniqueOrThrow({ where: { showKey: KEY } })).nextCrEpisodeId;

describe('the filler guide (KURO-T-5.3)', () => {
  it('refreshes only the lists a long Show needs, then marks each episode, numbering through both Seasons', async () => {
    expect(await refreshFiller(h.db, guide, log)).toEqual({ lists: 1, fetched: 1 });
    expect(requested).toEqual(['long-saga']);
    // Read last week: not read again.
    expect((await refreshFiller(h.db, guide, log)).fetched).toBe(0);
    await rebuildShows(h.db, userId);
    const d = await detail();
    expect(d.filler).toMatchObject({ count: 3, mixed: 1 });
    const kind = (id: string) => d.episodes.find((e) => e.crEpisodeId === id)?.filler;
    expect([kind('GLONG1E20'), kind('GLONG2E2'), kind('GLONG2E3'), kind('GLONG2E4'), kind('GLONG2E5')]).toEqual(['filler', 'filler', 'filler', 'mixed', 'canon']);
  });

  it('a re-release of a Season is versions of the same episodes, not more of them', async () => {
    const state = await h.db.showState.findUniqueOrThrow({ where: { showKey: KEY } });
    expect(state.totalEpisodes).toBe(45);
    expect(state.watchedEpisodes).toBe(20);
    const d = await detail();
    expect(d.episodes).toHaveLength(45);
    expect(d.episodes.find((e) => e.crEpisodeId.startsWith('GLONG1J'))).toBeUndefined();
  });

  it('skipping filler takes Up Next past it; mixed episodes stay; undo puts it back', async () => {
    expect(await next()).toBe('GLONG2E2');
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/skip-filler`, { skip: true })).status).toBe(204);
    expect(await next()).toBe('GLONG2E4');
    const d = await detail();
    expect(d.skipFiller).toBe(true);
    expect(d.episodes.find((e) => e.isNext)?.crEpisodeId).toBe('GLONG2E4');
    // Season 1's unwatched filler no longer counts against the Show.
    const state = await h.db.showState.findUniqueOrThrow({ where: { showKey: KEY } });
    expect(state.totalEpisodes).toBe(45 - 3);

    const c = await h.db.changeLog.findFirstOrThrow({ where: { entity: 'skip_filler', undoesId: null }, orderBy: { at: 'desc' } });
    expect((await fetch(`${h.base}/api/changes/${c.id}/undo`, { method: 'POST', headers: { cookie } })).status).toBe(204);
    expect(await next()).toBe('GLONG2E2');
  });

  it('refuses a malformed toggle', async () => {
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/skip-filler`, { skip: 'yes' })).status).toBe(400);
  });
});
