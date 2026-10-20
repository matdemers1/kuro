import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { seal } from '../../src/crypto/secretbox.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-2.5 end to end: a Demon Slayer-shaped series — Season 1, the Mugen Train movie as a
 * one-episode Crunchyroll season, then the Mugen Train arc — plus its Final Season split off into
 * a second Crunchyroll series, all matched. The rebuild makes one Show, the movie an optional Extra
 * after Season 1, Up Next steps over it, and the detail page lists Seasons, Extras and Franchise.
 */

let h: Harness;
let cookie = '';
let userId = '';
const RELEASE = randomUUID();
const KEY = 'show:anilist:7001';

const entry = (id: number, title: string, type: string, episodes: number, year: number, season: string) => ({
  id: `anilist:${String(id)}`, title, type, episodes, status: 'FINISHED', season, seasonYear: year, synonyms: [], sources: [], related: [], tags: [], studios: [], anilistId: id, releaseId: RELEASE, updatedAt: new Date(),
});
const media = (id: number, edges: [string, number][]) => ({
  anilistId: id,
  payload: { id, idMal: null, format: null, episodes: null, season: null, seasonYear: null, title: { romaji: null, english: null, native: null }, synonyms: [], externalLinks: [], relations: { edges: edges.map(([relationType, node]) => ({ relationType, node: { id: node, type: 'ANIME', format: null } })) } },
});

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'shows@example.com', displayName: 'S' } });
  userId = user.id;
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'shows owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'shows@example.com', password: 'shows owner password' })), 'kuro_session') ?? '';

  await h.db.catalogEntry.createMany({
    data: [entry(7001, 'Blade S1', 'TV', 3, 2019, 'SPRING'), entry(7002, 'Blade Movie: Night Train', 'MOVIE', 1, 2020, 'FALL'), entry(7003, 'Blade: Night Train Arc', 'TV', 2, 2021, 'FALL'), entry(7004, 'Blade: Final', 'TV', 2, 2024, 'SPRING'), entry(7005, 'Blade Academy', 'TV', 2, 2022, 'SPRING'), entry(7006, 'Blade Movie: Castle', 'MOVIE', 1, 2025, 'SUMMER'), entry(7007, 'Blade Recap', 'SPECIAL', 1, 2020, 'WINTER')],
  });
  await h.db.anilistMedia.createMany({
    data: [media(7001, [['SEQUEL', 7002]]), media(7002, [['PREQUEL', 7001], ['SEQUEL', 7003]]), media(7003, [['PREQUEL', 7002], ['SEQUEL', 7004], ['SPIN_OFF', 7005]]), media(7004, [['PREQUEL', 7003], ['SEQUEL', 7006], ['SUMMARY', 7007]]), media(7005, [['PARENT', 7003]])],
  });
  const sealed = seal('rt', SECRET_KEY);
  const conn = await h.db.crConnection.create({ data: { userId, accountId: '00000000-0000-4000-8000-0000000000ef', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await h.db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } });

  const seasons: { series: string; id: string; n: number; eps: number; entry: number; year: number }[] = [
    { series: 'GBLADE', id: 'GB1', n: 1, eps: 3, entry: 7001, year: 2019 },
    { series: 'GBLADE', id: 'GBMOV', n: 2, eps: 1, entry: 7002, year: 2020 },
    { series: 'GBLADE', id: 'GB3', n: 3, eps: 2, entry: 7003, year: 2021 },
    { series: 'GBLADEFIN', id: 'GBF', n: 1, eps: 2, entry: 7004, year: 2024 },
    { series: 'GBACAD', id: 'GBA', n: 1, eps: 2, entry: 7005, year: 2022 },
  ];
  for (const sid of ['GBLADE', 'GBLADEFIN', 'GBACAD']) await h.db.crSeries.create({ data: { id: sid, title: sid === 'GBLADE' ? 'Blade' : sid === 'GBLADEFIN' ? 'Blade Final Season' : 'Blade Academy', raw: {} } });
  for (const s of seasons) {
    await h.db.crSeason.create({ data: { id: s.id, seriesId: s.series, title: `Season ${String(s.n)}`, seasonNumber: s.n, seasonSequenceNumber: s.n, raw: {} } });
    await h.db.crEpisode.createMany({ data: Array.from({ length: s.eps }, (_, i) => ({ id: `${s.id}E${String(i + 1)}`, seasonId: s.id, title: `${s.id} episode ${String(i + 1)}`, episodeNumber: i + 1, sequenceNumber: i + 1, durationS: s.eps === 1 ? 7000 : 1420, airDate: new Date(Date.UTC(s.year, 3, 6 + i * 7)), canonicalId: `${s.id}E${String(i + 1)}`, raw: {} })) });
    await h.db.mapping.create({ data: { crSeasonId: s.id, epFrom: 1, epTo: s.eps, catalogEntryId: `anilist:${String(s.entry)}`, offset: 0, source: 'auto', status: 'accepted', confidence: 'strong', signals: [], candidates: [] } });
  }
  // Season 1 watched; the movie skipped; one play each of the spin-off and the final season's series.
  const play = (ep: string, series: string, daysAgo: number) => h.db.play.create({ data: { crEpisodeId: ep, crParentId: series, crParentType: 'series', datePlayed: new Date(Date.now() - daysAgo * 86_400_000), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: run.id } });
  await play('GB1E1', 'GBLADE', 3);
  await play('GB1E2', 'GBLADE', 2);
  await play('GB1E3', 'GBLADE', 1);
  await play('GBAE1', 'GBACAD', 10);
  await rebuildShows(h.db, userId);
});

afterAll(async () => {
  await h.db.mapping.deleteMany({ where: { crSeasonId: { startsWith: 'GB' } } });
  await h.db.catalogEntry.deleteMany({ where: { releaseId: RELEASE } });
  await h.db.anilistMedia.deleteMany({ where: { anilistId: { gte: 7001, lte: 7007 } } });
  await h.close();
});

const get = async <T>(path: string) => (await (await fetch(`${h.base}${path}`, { headers: { cookie } })).json()) as T;
const put = (path: string, body: unknown) => fetch(`${h.base}${path}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stateOf = async () => h.db.showState.findUniqueOrThrow({ where: { showKey: KEY } });
const playAgo = async (ep: string, series: string, daysAgo: number) => {
  const run = await h.db.syncRun.findFirstOrThrow({ where: { crConnection: { userId } } });
  await h.db.play.create({ data: { crEpisodeId: ep, crParentId: series, crParentType: 'series', datePlayed: new Date(Date.now() - daysAgo * 86_400_000), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: run.id } });
};

describe('Shows from matched seasons (KURO-T-2.5)', () => {
  it('makes one Show of the series Crunchyroll split, with the movie as an optional Extra after Season 1', async () => {
    const show = await h.db.show.findUniqueOrThrow({ where: { showKey: KEY }, include: { items: { orderBy: { position: 'asc' } } } });
    expect(show.seriesIds).toEqual(['GBLADE', 'GBLADEFIN']);
    expect(show.items.map((i) => [i.catalogEntryId, i.kind, i.required])).toEqual([
      ['anilist:7001', 'season', true],
      ['anilist:7002', 'extra', false],
      ['anilist:7003', 'season', true],
      ['anilist:7004', 'season', true],
    ]);
  });

  it('Up Next steps over the unwatched movie to the next Season, and the Extra never counts toward the total', async () => {
    const state = await h.db.showState.findUniqueOrThrow({ where: { showKey: KEY } });
    expect(state).toMatchObject({ status: 'watching', watchedEpisodes: 3, totalEpisodes: 7, nextCrEpisodeId: 'GB3E1', nextIsNewSeason: true });
  });

  it('puts the spin-off in a Show of its own, in the same Franchise', async () => {
    const [blade, academy] = await Promise.all([h.db.show.findUniqueOrThrow({ where: { showKey: KEY } }), h.db.show.findUniqueOrThrow({ where: { showKey: 'show:anilist:7005' } })]);
    expect(academy.franchiseKey).toBe(blade.franchiseKey);
  });

  it('the detail page lists Seasons and Extras, the extra’s episodes, and the rest of the Franchise', async () => {
    const d = await get<{ title: string; items: { title: string; kind: string }[]; extras: { crEpisodeId: string }[]; franchise: { showKey: string }[]; episodes: { crEpisodeId: string }[] }>(`/api/shows/${encodeURIComponent(KEY)}`);
    expect(d.title).toBe('Blade');
    expect(d.items.map((i) => [i.title, i.kind])).toEqual([['Blade S1', 'season'], ['Blade Movie: Night Train', 'extra'], ['Blade: Night Train Arc', 'season'], ['Blade: Final', 'season']]);
    expect(d.extras.map((e) => e.crEpisodeId)).toEqual(['GBMOVE1']);
    expect(d.episodes.map((e) => e.crEpisodeId)).toEqual(['GB1E1', 'GB1E2', 'GB1E3', 'GB3E1', 'GB3E2', 'GBFE1', 'GBFE2']);
    expect(d.franchise.map((f) => f.showKey)).toEqual(['show:anilist:7005']);
  });

  it('the Library lists each Show with its Franchise, and the Franchise lists its Shows in watch order', async () => {
    const lib = await get<{ items: { showKey: string; franchiseKey: string; franchiseTitle: string }[] }>('/api/shows');
    const blade = lib.items.find((i) => i.showKey === KEY);
    const academy = lib.items.find((i) => i.showKey === 'show:anilist:7005');
    expect(blade?.franchiseKey).toBe(academy?.franchiseKey);
    expect(blade?.franchiseTitle).toBe('Blade');
    const f = await get<{ title: string; shows: { showKey: string; seasons: number; extras: number }[] }>(`/api/franchises/${encodeURIComponent(blade?.franchiseKey ?? '')}`);
    expect(f.title).toBe('Blade');
    expect(f.shows.map((x) => [x.showKey, x.seasons, x.extras])).toEqual([[KEY, 3, 1], ['show:anilist:7005', 1, 0]]);
    expect((await fetch(`${h.base}/api/franchises/fr%3Anope`, { headers: { cookie } })).status).toBe(404);
  });

  it('the Franchise timeline puts the movie between Season 1 and Season 2, the spin-off where it aired, and the sequel movie not in the library at the end (KURO-T-5.4)', async () => {
    const blade = await h.db.show.findUniqueOrThrow({ where: { showKey: KEY } });
    const f = await get<{ timeline: { entryId: string; kind: string; label: string | null; showKey: string | null; watched: number | null; total: number | null }[] }>(`/api/franchises/${encodeURIComponent(blade.franchiseKey)}`);
    expect(f.timeline.map((r) => [r.entryId, r.kind, r.label])).toEqual([
      ['anilist:7001', 'season', 'Season 1'],
      ['anilist:7002', 'extra', null],
      ['anilist:7003', 'season', 'Season 2'],
      ['anilist:7005', 'season', 'Season 1'],
      ['anilist:7004', 'season', 'Season 3'],
      ['anilist:7006', 'related', null],
    ]);
    // Where the owner stands on each part; the recap (a SUMMARY) is not on the timeline.
    expect(f.timeline[0]).toMatchObject({ watched: 3, total: 3 });
    expect(f.timeline[1]).toMatchObject({ watched: 0, total: 1 });
    expect(f.timeline[5]).toMatchObject({ showKey: null, watched: null });
  });

  it('two rebuilds produce identical Shows (KURO-ADR-004)', async () => {
    const snap = async () => JSON.stringify(await h.db.show.findMany({ orderBy: { showKey: 'asc' }, include: { items: { orderBy: { position: 'asc' } } }, omit: { derivedAt: true } }));
    const first = await snap();
    await rebuildShows(h.db, userId);
    expect(await snap()).toBe(first);
  });
});

describe('statuses on real Shows (KURO-T-2.7)', () => {
  it('Dropped is the owner’s: it leaves Up Next, is change-logged, and undo brings it back', async () => {
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/status`, { status: 'dropped' })).status).toBe(204);
    expect((await stateOf()).status).toBe('dropped');
    const upNext = await get<{ items: { showKey: string }[] }>('/api/up-next');
    expect(upNext.items.some((i) => i.showKey === KEY)).toBe(false);
    const change = await h.db.changeLog.findFirstOrThrow({ where: { entity: 'show_status', entityId: KEY }, orderBy: { at: 'desc' } });
    expect((await fetch(`${h.base}/api/changes/${change.id}/undo`, { method: 'POST', headers: { cookie } })).status).toBe(204);
    expect((await stateOf()).status).toBe('watching');
  });

  it('Caught up, not Completed, when everything out is watched and the last Season is still airing', async () => {
    for (const [ep, d] of [['GB3E1', 0.9], ['GB3E2', 0.8], ['GBFE1', 0.7], ['GBFE2', 0.6]] as const) await playAgo(ep, ep.startsWith('GBF') ? 'GBLADEFIN' : 'GBLADE', d);
    await h.db.catalogEntry.update({ where: { id: 'anilist:7004' }, data: { status: 'ONGOING' } });
    await rebuildShows(h.db, userId);
    expect((await stateOf()).status).toBe('caught_up');
    await h.db.catalogEntry.update({ where: { id: 'anilist:7004' }, data: { status: 'FINISHED' } });
    await rebuildShows(h.db, userId);
    expect((await stateOf()).status).toBe('completed');
  });

  it('Rewatching after the end, picking up after the episode replayed', async () => {
    await playAgo('GB1E1', 'GBLADE', 0.1);
    await rebuildShows(h.db, userId);
    expect(await stateOf()).toMatchObject({ status: 'rewatching', nextCrEpisodeId: 'GB1E2' });
  });
});
