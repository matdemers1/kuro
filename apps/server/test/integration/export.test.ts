import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { seal } from '../../src/crypto/secretbox.js';
import type { Db } from '../../src/db.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { importJson, KuroExport, malStatus } from '../../src/export/export.js';
import { cookieFrom, freshDatabase, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-6.1: the JSON export carries every play and the owner's choices, and `import-json` reads it
 * into a brand-new Kurō with the same plays; the CSVs quote what needs quoting; the MAL XML is well
 * formed, one <anime> per catalog entry with a MAL id, in MAL's own status words.
 */

let h: Harness;
let cookie = '';
let fresh: Db;
let dropFresh: () => Promise<void>;

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'export@example.com', displayName: 'E' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'export owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'export@example.com', password: 'export owner password' })), 'kuro_session') ?? '';
  const sealed = seal('rt', SECRET_KEY);
  const conn = await h.db.crConnection.create({ data: { userId: user.id, accountId: '00000000-0000-4000-8000-0000000000f5', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await h.db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } });
  await h.db.crSeries.create({ data: { id: 'GEXPORT', title: 'Export, "Quoted" Show', raw: {} } });
  await h.db.crSeason.create({ data: { id: 'GEXPORTS1', seriesId: 'GEXPORT', title: 'Season 1', seasonNumber: 1, raw: {} } });
  await h.db.crEpisode.createMany({ data: [1, 2].map((n) => ({ id: `GEXPORTE${String(n)}`, seasonId: 'GEXPORTS1', title: `E${String(n)}`, episodeNumber: n, sequenceNumber: n, durationS: 1420, canonicalId: `GEXPORTE${String(n)}`, raw: {} })) });
  await h.db.play.createMany({
    data: [1, 2].map((n) => ({ crEpisodeId: `GEXPORTE${String(n)}`, crParentId: 'GEXPORT', crParentType: 'series' as const, datePlayed: new Date(Date.UTC(2024, 0, n, 20)), playheadS: 1420, fullyWatched: true, raw: { from: 'crunchyroll', n }, syncRunId: run.id })),
  });
  await rebuildShows(h.db, user.id);
  await h.db.rating.create({ data: { target: 'show:cr:GEXPORT', score: 8 } });
  await h.db.showNote.create({ data: { showKey: 'cr:GEXPORT', text: 'note, with "quotes"' } });

  const f = await freshDatabase('kuro_export_test');
  fresh = f.db;
  dropFresh = () => f.drop();
}, 60_000);

afterAll(async () => {
  await dropFresh();
  await h.db.rating.deleteMany({ where: { target: 'show:cr:GEXPORT' } });
  await h.db.showNote.deleteMany({ where: { showKey: 'cr:GEXPORT' } });
  await h.close();
});

const download = (path: string) => fetch(`${h.base}/api/export/${path}`, { headers: { cookie } });
const playsOf = async (db: Db) => (await db.play.findMany({ where: { crParentId: 'GEXPORT' }, orderBy: { datePlayed: 'asc' } })).map((p) => ({ crEpisodeId: p.crEpisodeId, datePlayed: p.datePlayed.toISOString(), playheadS: p.playheadS, fullyWatched: p.fullyWatched, raw: p.raw }));

describe('export (KURO-T-6.1)', () => {
  it('the JSON export round-trips Plays into a brand-new Kurō, with the owner’s choices', async () => {
    const res = await download('kuro.json');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="kuro-\d{4}-\d{2}-\d{2}\.json"/);
    const data = KuroExport.parse(await res.json());
    expect(data.plays.filter((p) => p.crParentId === 'GEXPORT')).toHaveLength(2);

    const owner = await fresh.user.create({ data: { email: 'restored@example.com', displayName: 'R' } });
    await expect(importJson(fresh, owner.id, data)).rejects.toThrow(/link Crunchyroll first/);
    const sealed = seal('rt', SECRET_KEY);
    await fresh.crConnection.create({ data: { userId: owner.id, accountId: '00000000-0000-4000-8000-0000000000f6', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
    const first = await importJson(fresh, owner.id, data);
    expect(first.added).toBe(data.plays.length);
    expect(await playsOf(fresh)).toEqual(await playsOf(h.db));
    expect((await fresh.rating.findUnique({ where: { target: 'show:cr:GEXPORT' } }))?.score).toBe(8);
    expect((await fresh.showNote.findUnique({ where: { showKey: 'cr:GEXPORT' } }))?.text).toBe('note, with "quotes"');
    // Importing twice adds nothing: the vault already has every play.
    expect((await importJson(fresh, owner.id, data)).added).toBe(0);
    await expect(importJson(fresh, owner.id, { format: 'something-else' })).rejects.toThrow();
  });

  it('the CSVs quote commas and quotes', async () => {
    const shows = await (await download('shows.csv')).text();
    expect(shows.split('\r\n')[0]).toBe('title,status,watched_episodes,total_episodes,rating,last_played,anilist_id,mal_id,show_key');
    expect(shows).toContain('"Export, ""Quoted"" Show",completed,2,2,8,');
    const plays = await (await download('plays.csv')).text();
    expect(plays).toContain('2024-01-01T20:00:00.000Z,"Export, ""Quoted"" Show",1,1,E1,,1420,1420,true,GEXPORTE1');
  });

  it('the MAL XML is a MyAnimeList list in MAL’s status words', async () => {
    const res = await download('mal.xml');
    expect(res.headers.get('content-type')).toMatch(/application\/xml/);
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" ?>')).toBe(true);
    expect(xml).toContain('<myanimelist>');
    expect(xml).toContain('<user_export_type>1</user_export_type>');
    expect(malStatus({ watched: 12, total: 12 }, { episodes: 12, status: 'FINISHED' }, 'season', 'completed')).toBe('Completed');
    expect(malStatus({ watched: 12, total: 12 }, { episodes: 24, status: 'ONGOING' }, 'season', 'caught_up')).toBe('Watching');
    expect(malStatus({ watched: 3, total: 12 }, { episodes: 12, status: 'FINISHED' }, 'season', 'paused')).toBe('On-Hold');
    expect(malStatus({ watched: 3, total: 12 }, { episodes: 12, status: 'FINISHED' }, 'season', 'dropped')).toBe('Dropped');
    expect(malStatus({ watched: 0, total: 12 }, { episodes: 12, status: 'FINISHED' }, 'season', 'watching')).toBe('Plan to Watch');
    expect(malStatus({ watched: 0, total: 1 }, { episodes: 1, status: 'FINISHED' }, 'extra', 'watching')).toBeNull();
  });
});
