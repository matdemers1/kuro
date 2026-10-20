import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { importCatalog } from '../../src/catalog/import.js';
import { seal } from '../../src/crypto/secretbox.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-2.6's done-when: split, merge, reorder and attach-extra, made through the API, survive a
 * re-sync and a catalog re-import. The catalog comes from a fake GitHub release; the second release
 * reshuffles sources, so only stable ids keep the overrides pointing at the right entries.
 */

const record = (id: number, title: string, type: string, episodes: number, year: number, extraSources: string[] = []) => ({
  sources: [`https://anilist.co/anime/${String(id)}`, ...extraSources],
  title, type, episodes, status: 'FINISHED', animeSeason: { season: 'SPRING', year }, synonyms: [], relatedAnime: [], tags: [], studios: [],
});
let release = '2026-50';
const catalog = () => [
  record(8101, 'Override Show', 'TV', 2, 2018, release === '2026-50' ? [] : ['https://myanimelist.net/anime/98101']),
  record(8102, 'Override Show 2nd Season', 'TV', 2, 2020),
  record(8103, 'Override Show Movie', 'MOVIE', 1, 2019),
  record(8104, 'Another Show', 'TV', 2, 2021),
];

let h: Harness;
let server: Server;
let base = '';
let cookie = '';
let userId = '';
let runId = '';
const log = pino({ level: 'silent' });
const SHOW = 'show:anilist:8101';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if ((req.url ?? '').startsWith('/repos/ov/aod/releases')) res.end(JSON.stringify([{ tag_name: release, published_at: new Date().toISOString(), assets: [{ name: 'anime-offline-database.jsonl', browser_download_url: `${base}/files/ov.jsonl` }] }]));
    else res.end(catalog().map((r) => JSON.stringify(r)).join('\n'));
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  h = await startApp();
  await importCatalog(h.db, { repo: 'ov/aod', apiBase: base }, log);
  const media = (id: number, edges: [string, number][]) => ({ anilistId: id, payload: { id, idMal: null, format: null, episodes: null, season: null, seasonYear: null, title: { romaji: null, english: null, native: null }, synonyms: [], externalLinks: [], relations: { edges: edges.map(([relationType, node]) => ({ relationType, node: { id: node, type: 'ANIME', format: null } })) } } });
  await h.db.anilistMedia.createMany({ data: [media(8101, [['SEQUEL', 8102], ['SIDE_STORY', 8103]]), media(8102, [['PREQUEL', 8101]]), media(8103, [['PARENT', 8101]]), media(8104, [])] });

  const user = await h.db.user.create({ data: { email: 'overrides@example.com', displayName: 'O' } });
  userId = user.id;
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'overrides owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'overrides@example.com', password: 'overrides owner password' })), 'kuro_session') ?? '';
  const sealed = seal('rt', SECRET_KEY);
  const conn = await h.db.crConnection.create({ data: { userId, accountId: '00000000-0000-4000-8000-0000000000f0', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  runId = (await h.db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } })).id;

  const seasons = [
    { series: 'GOVA', id: 'GOVA1', entry: 8101, eps: 2 },
    { series: 'GOVA', id: 'GOVA2', entry: 8102, eps: 2 },
    { series: 'GOVM', id: 'GOVM1', entry: 8103, eps: 1 },
    { series: 'GOVO', id: 'GOVO1', entry: 8104, eps: 2 },
  ];
  for (const [id, title] of [['GOVA', 'Override Show'], ['GOVM', 'Override Show: The Movie'], ['GOVO', 'Another Show']] as const) await h.db.crSeries.create({ data: { id, title, raw: {} } });
  for (const s of seasons) {
    await h.db.crSeason.create({ data: { id: s.id, seriesId: s.series, title: s.id, seasonNumber: 1, raw: {} } });
    await h.db.crEpisode.createMany({ data: Array.from({ length: s.eps }, (_, i) => ({ id: `${s.id}E${String(i + 1)}`, seasonId: s.id, title: 'E', episodeNumber: i + 1, sequenceNumber: i + 1, durationS: 1420, canonicalId: `${s.id}E${String(i + 1)}`, raw: {} })) });
    await h.db.mapping.create({ data: { crSeasonId: s.id, epFrom: 1, epTo: s.eps, catalogEntryId: `anilist:${String(s.entry)}`, offset: 0, source: 'confirmed', status: 'accepted', confidence: 'strong', signals: [], candidates: [] } });
  }
  for (const [ep, series] of [['GOVA1E1', 'GOVA'], ['GOVM1E1', 'GOVM'], ['GOVO1E1', 'GOVO']] as const) await play(ep, series, 3);
  await rebuildShows(h.db, userId);
});

afterAll(async () => {
  await h.db.override.deleteMany();
  await h.db.mapping.deleteMany({ where: { crSeasonId: { startsWith: 'GOV' } } });
  await h.db.catalogEntry.deleteMany({ where: { id: { startsWith: 'anilist:81' } } });
  await h.db.catalogRelease.deleteMany({ where: { repo: 'ov/aod' } });
  await h.db.anilistMedia.deleteMany({ where: { anilistId: { gte: 8101, lte: 8104 } } });
  await h.close();
  server.close();
});

async function play(ep: string, series: string, daysAgo: number) {
  await h.db.play.create({ data: { crEpisodeId: ep, crParentId: series, crParentType: 'series', datePlayed: new Date(Date.now() - daysAgo * 86_400_000), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: runId } });
}
const post = (body: unknown) => fetch(`${h.base}/api/overrides`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** Every Show, as [key, [entry:kind…]] — the shape every assertion compares. */
const structure = async () =>
  (await h.db.show.findMany({ where: { seriesIds: { hasSome: ['GOVA', 'GOVM', 'GOVO'] } }, include: { items: { orderBy: { position: 'asc' } } }, orderBy: { showKey: 'asc' } })).map((s) => [s.showKey, s.items.map((i) => `${i.catalogEntryId.replace('anilist:', '')}:${i.kind}`)]);

const FINAL = [
  [SHOW, ['8101:season', '8104:season', '8103:extra']],
  ['show:anilist:8102', ['8102:season']],
];

describe('grouping overrides (KURO-T-2.6)', () => {
  it('starts as the derivation sees it: the show with two seasons, the movie and the other show apart', async () => {
    expect(await structure()).toEqual([
      ['show:anilist:8101', ['8101:season', '8102:season']],
      ['show:anilist:8103', ['8103:extra']],
      ['show:anilist:8104', ['8104:season']],
    ]);
  });

  it('applies split, attach, merge and reorder, made through the API', async () => {
    expect((await post({ kind: 'split', entryIds: ['anilist:8102'] })).status).toBe(201);
    expect((await post({ kind: 'attach', entryId: 'anilist:8103', afterEntryId: 'anilist:8101' })).status).toBe(201);
    expect((await post({ kind: 'merge', seriesIds: ['GOVA', 'GOVO'] })).status).toBe(201);
    expect((await post({ kind: 'reorder', entryIds: ['anilist:8101', 'anilist:8104', 'anilist:8103'] })).status).toBe(201);
    expect(await structure()).toEqual(FINAL);
  });

  it('survives a re-sync', async () => {
    await play('GOVA1E2', 'GOVA', 1);
    await play('GOVA2E1', 'GOVA', 0.5);
    await rebuildShows(h.db, userId);
    expect(await structure()).toEqual(FINAL);
  });

  it('survives a catalog re-import that reshuffles sources', async () => {
    release = '2026-51';
    expect((await importCatalog(h.db, { repo: 'ov/aod', apiBase: base }, log)).status).toBe('imported');
    await rebuildShows(h.db, userId);
    expect(await structure()).toEqual(FINAL);
  });

  it('lists the overrides touching a Show, and undo takes the last one back', async () => {
    const { items } = (await (await fetch(`${h.base}/api/overrides?showKey=${encodeURIComponent(SHOW)}`, { headers: { cookie } })).json()) as { items: { kind: string }[] };
    expect(items.map((i) => i.kind)).toEqual(['split', 'attach', 'merge', 'reorder']);
    const change = await h.db.changeLog.findFirstOrThrow({ where: { entity: 'override', action: 'reorder' }, orderBy: { at: 'desc' } });
    expect((await fetch(`${h.base}/api/changes/${change.id}/undo`, { method: 'POST', headers: { cookie } })).status).toBe(204);
    expect((await structure())[0]).toEqual([SHOW, ['8101:season', '8103:extra', '8104:season']]);
  });

  it('removing an override puts the Show back the way derivation sees it', async () => {
    const split = await h.db.override.findFirstOrThrow({ where: { kind: 'split' } });
    expect((await fetch(`${h.base}/api/overrides/${split.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    expect((await structure()).find(([k]) => k === SHOW)?.[1]).toContain('8102:season');
  });
});
