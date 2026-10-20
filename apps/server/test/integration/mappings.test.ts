import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-2.4: the review queue over HTTP — what it lists, the three answers, the change log behind
 * each and undo — plus the catalog search it uses.
 */

let h: Harness;
let cookie = '';
const RELEASE = randomUUID();
const SEASON = 'GRVSEASON';

const entry = (id: string, title: string, episodes: number, year: number) => ({
  id, title, type: 'TV', episodes, status: 'FINISHED', season: 'SPRING', seasonYear: year, synonyms: [], sources: [], related: [], tags: [], studios: [], releaseId: RELEASE, updatedAt: new Date(),
});
const weakRows = () => [
  { crSeasonId: SEASON, epFrom: 1, epTo: 12, catalogEntryId: 'rv:guess', offset: 0, source: 'auto', status: 'review', confidence: 'weak', signals: ['not the next season on the main line'], candidates: ['rv:guess', 'rv:right'], autoEntryId: 'rv:guess' },
];

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'review@example.com', displayName: 'R' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'review owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'review@example.com', password: 'review owner password' })), 'kuro_session') ?? '';
  await h.db.catalogEntry.createMany({ data: [entry('rv:guess', 'Reviewable Show', 12, 2015), entry('rv:right', 'Reviewable Show Season 2', 12, 2023)] });
  await h.db.crSeries.create({ data: { id: 'GRVSERIES', title: 'Reviewable Show', raw: {} } });
  await h.db.crSeason.create({ data: { id: SEASON, seriesId: 'GRVSERIES', title: 'Season 2', seasonNumber: 2, raw: {} } });
  await h.db.mapping.createMany({ data: weakRows() });
});
afterAll(async () => {
  await h.db.mapping.deleteMany({ where: { crSeasonId: SEASON } });
  await h.db.crEpisode.deleteMany({ where: { seasonId: SEASON } });
  await h.db.catalogEntry.deleteMany({ where: { releaseId: RELEASE } });
  await h.close();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${h.base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
type Review = { items: { seasonId: string; seriesTitle: string; seasonTitle: string; ranges: { entry: { id: string } | null }[]; candidates: { id: string; title: string }[] }[]; total: number };
const review = async () => (await (await call('GET', '/api/mappings/review?all=1')).json()) as Review;
const rows = () => h.db.mapping.findMany({ where: { crSeasonId: SEASON }, orderBy: { epFrom: 'asc' } });
const lastChange = async () => h.db.changeLog.findFirstOrThrow({ where: { entity: 'mapping_season', entityId: SEASON }, orderBy: { at: 'desc' } });

describe('the match review queue (KURO-T-2.4)', () => {
  it('hides an unsure season nobody has watched, unless asked for all', async () => {
    const watchedOnly = (await (await call('GET', '/api/mappings/review')).json()) as Review & { unwatched: number };
    expect(watchedOnly.items.some((i) => i.seasonId === SEASON)).toBe(false);
    expect(watchedOnly.unwatched).toBeGreaterThan(0);
  });

  it('lists each unsure season with its guess and the candidates to pick from', async () => {
    const r = await review();
    const item = r.items.find((i) => i.seasonId === SEASON);
    expect(item).toMatchObject({ seriesTitle: 'Reviewable Show', seasonTitle: 'Season 2' });
    expect(item?.ranges[0]?.entry?.id).toBe('rv:guess');
    expect(item?.candidates.map((c) => c.id)).toEqual(['rv:guess', 'rv:right']);
  });

  it('choosing an entry maps the whole season to it, as the owner’s, and leaves the queue', async () => {
    expect((await call('POST', `/api/mappings/season/${SEASON}/choose`, { entryId: 'rv:right' })).status).toBe(204);
    expect((await rows()).map((m) => [m.catalogEntryId, m.source, m.status, m.epFrom, m.epTo, m.offset])).toEqual([['rv:right', 'override', 'accepted', 1, 12, 0]]);
    expect((await review()).items.some((i) => i.seasonId === SEASON)).toBe(false);
  });

  it('undo puts the season back in the queue exactly as it was', async () => {
    const change = await lastChange();
    expect((await call('POST', `/api/changes/${change.id}/undo`)).status).toBe(204);
    expect((await rows()).map((m) => [m.catalogEntryId, m.source, m.status])).toEqual([['rv:guess', 'auto', 'review']]);
  });

  it('confirming keeps the matcher’s guess, made the owner’s', async () => {
    expect((await call('POST', `/api/mappings/season/${SEASON}/confirm`)).status).toBe(204);
    expect((await rows()).map((m) => [m.catalogEntryId, m.source, m.status])).toEqual([['rv:guess', 'confirmed', 'accepted']]);
    expect((await lastChange()).action).toBe('confirm');
  });

  it('"not in the catalog" keeps Crunchyroll’s structure and stops asking', async () => {
    expect((await call('POST', `/api/mappings/season/${SEASON}/skip`)).status).toBe(204);
    expect((await rows()).map((m) => [m.catalogEntryId, m.source, m.status])).toEqual([[null, 'override', 'accepted']]);
  });

  it('a season spanning two entries is split across them in the order chosen', async () => {
    await h.db.crEpisode.createMany({ data: Array.from({ length: 24 }, (_, i) => ({ id: `GRVE${String(i + 1)}`, seasonId: SEASON, title: `E${String(i + 1)}`, episodeNumber: i + 1, sequenceNumber: i + 1, durationS: 1420, raw: {} })) });
    expect((await call('POST', `/api/mappings/season/${SEASON}/choose`, { entryIds: ['rv:guess', 'rv:right'] })).status).toBe(204);
    expect((await rows()).map((m) => [m.catalogEntryId, m.epFrom, m.epTo, m.offset])).toEqual([
      ['rv:guess', 1, 12, 0],
      ['rv:right', 13, 24, -12],
    ]);
  });

  it('refuses an entry that does not exist', async () => {
    expect((await call('POST', `/api/mappings/season/${SEASON}/choose`, { entryId: 'rv:nope' })).status).toBe(404);
  });

  it('searches the catalog by title', async () => {
    const { items } = (await (await call('GET', '/api/catalog/search?q=Reviewable%20Show%20Season%202')).json()) as { items: { id: string }[] };
    expect(items[0]?.id).toBe('rv:right');
  });
});
