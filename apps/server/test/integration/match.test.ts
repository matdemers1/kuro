import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AniListMedia } from '../../src/adapters/anilist.js';
import { seal } from '../../src/crypto/secretbox.js';
import { createDb, type Db } from '../../src/db.js';
import type { MediaSource } from '../../src/match/pool.js';
import { matchCatalog } from '../../src/match/run.js';
import { SECRET_KEY } from './helpers.js';

/**
 * KURO-T-2.3 end to end: a synthetic series shaped like SPY x FAMILY — a 25-episode first season
 * that the catalog splits into two cours, and a second season — matched through an AniList
 * Crunchyroll link, written as mappings, and re-run without touching what the owner confirmed.
 */

let db: Db;
let userId = '';
const log = pino({ level: 'silent' });
const RELEASE = randomUUID();

// AniList: cour 1 links to the Crunchyroll series by slug; the cours and season 2 chain by SEQUEL.
const media = (id: number, links: string[], sequel?: number, prequel?: number): AniListMedia => ({
  id, idMal: null, format: 'TV', episodes: null, season: null, seasonYear: null,
  title: { romaji: null, english: null, native: null }, synonyms: [],
  externalLinks: links.map((url) => ({ site: 'Crunchyroll', url })),
  relations: [...(sequel === undefined ? [] : [{ relationType: 'SEQUEL', node: { id: sequel, type: 'ANIME', format: 'TV' } }]), ...(prequel === undefined ? [] : [{ relationType: 'PREQUEL', node: { id: prequel, type: 'ANIME', format: 'TV' } }])],
});
const ANILIST: Record<number, AniListMedia> = {
  9001: media(9001, ['https://www.crunchyroll.com/synthetic-family'], 9002),
  9002: media(9002, [], 9003, 9001),
  9003: media(9003, [], undefined, 9002),
};
const asked: number[][] = [];
const anilist: MediaSource = {
  media: (ids) => {
    asked.push([...ids]);
    return Promise.resolve(new Map(ids.flatMap((id) => (ANILIST[id] === undefined ? [] : [[id, ANILIST[id]] as const]))));
  },
};

const catalogEntry = (id: string, title: string, episodes: number, year: number, season: string, anilistId: number) => ({
  id, title, type: 'TV', episodes, status: 'FINISHED', season, seasonYear: year, synonyms: [], sources: [`https://anilist.co/anime/${String(anilistId)}`], related: [], tags: [], studios: [], anilistId, releaseId: RELEASE, updatedAt: new Date(),
});

beforeAll(async () => {
  db = createDb(process.env['DATABASE_URL'] ?? '');
  await db.catalogEntry.createMany({
    data: [
      catalogEntry('anilist:9001', 'Synthetic Family', 12, 2022, 'SPRING', 9001),
      catalogEntry('anilist:9002', 'Synthetic Family Part 2', 13, 2022, 'FALL', 9002),
      catalogEntry('anilist:9003', 'Synthetic Family Season 2', 12, 2023, 'FALL', 9003),
      catalogEntry('anilist:9100', 'Synthetic Family Fan Remake', 25, 2010, 'SPRING', 9100),
    ],
  });
  const user = await db.user.create({ data: { email: 'match-owner@example.com', displayName: 'Match owner' } });
  userId = user.id;
  const sealed = seal('rt', SECRET_KEY);
  const conn = await db.crConnection.create({ data: { userId, accountId: '00000000-0000-4000-8000-0000000000dd', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } });
  await db.crSeries.create({ data: { id: 'GMSER', title: 'SYNTHETIC x FAMILY', slugTitle: 'synthetic-family', raw: {} } });
  const seasons = [
    { id: 'GMS1', title: 'Season 1', n: 1, from: 1, to: 25, year: 2022 },
    { id: 'GMS2', title: 'Season 2', n: 2, from: 26, to: 37, year: 2023 },
  ];
  for (const s of seasons) {
    await db.crSeason.create({ data: { id: s.id, seriesId: 'GMSER', title: s.title, seasonNumber: s.n, seasonSequenceNumber: s.n, raw: {} } });
    await db.crEpisode.createMany({
      data: Array.from({ length: s.to - s.from + 1 }, (_, i) => ({ id: `${s.id}E${String(s.from + i)}`, seasonId: s.id, title: `Ep ${String(s.from + i)}`, episodeNumber: s.from + i, sequenceNumber: s.from + i, durationS: 1420, airDate: new Date(Date.UTC(s.year, 3, 9 + i * 7)), canonicalId: `${s.id}E${String(s.from + i)}`, raw: {} })),
    });
  }
  await db.play.create({ data: { crEpisodeId: 'GMS1E1', crParentId: 'GMSER', crParentType: 'series', datePlayed: new Date('2024-01-01T21:00:00Z'), playheadS: 1400, fullyWatched: true, raw: {}, syncRunId: run.id } });
});

afterAll(async () => {
  await db.mapping.deleteMany({ where: { crSeasonId: { startsWith: 'GMS' } } });
  await db.catalogEntry.deleteMany({ where: { releaseId: RELEASE } });
  await db.$disconnect();
});

const mappings = (seasonId: string) => db.mapping.findMany({ where: { crSeasonId: seasonId }, orderBy: { epFrom: 'asc' } });

describe('the matcher, written as mappings (KURO-T-2.3)', () => {
  it('maps the split cour and the next season through the AniList link, strong, and never the look-alike', async () => {
    const out = await matchCatalog({ db, anilist, log, now: new Date('2026-10-20T00:00:00Z') }, userId);
    expect(out).toMatchObject({ series: 1, accepted: 3, review: 0 });
    expect((await mappings('GMS1')).map((m) => [m.catalogEntryId, m.epFrom, m.epTo, m.offset, m.status])).toEqual([
      ['anilist:9001', 1, 12, 0, 'accepted'],
      ['anilist:9002', 13, 25, -12, 'accepted'],
    ]);
    expect((await mappings('GMS2')).map((m) => [m.catalogEntryId, m.offset])).toEqual([['anilist:9003', -25]]);
  });

  it('leaves a season the owner confirmed alone on a re-run', async () => {
    const [first] = await mappings('GMS1');
    await db.mapping.update({ where: { id: first?.id ?? '' }, data: { source: 'override', catalogEntryId: 'anilist:9100' } });
    const out = await matchCatalog({ db, anilist, log, now: new Date('2026-10-20T00:00:00Z') }, userId);
    expect(out.kept).toBe(1);
    expect((await mappings('GMS1')).map((m) => [m.source, m.catalogEntryId])).toEqual([
      ['override', 'anilist:9100'],
      ['auto', 'anilist:9002'],
    ]);
  });

  it('sends a mapping to a retired entry back to review — the remap queue', async () => {
    await db.catalogEntry.update({ where: { id: 'anilist:9003' }, data: { retiredAt: new Date() } });
    const out = await matchCatalog({ db, anilist, log, now: new Date('2026-10-20T00:00:00Z') }, userId);
    // The retired entry is out of the pool, so season 2 is now weak; the override to a live entry stays put.
    expect((await mappings('GMS2'))[0]?.status).toBe('review');
    expect(out.review).toBeGreaterThan(0);
    expect((await mappings('GMS1'))[0]).toMatchObject({ source: 'override', status: 'accepted' });
  });
});
