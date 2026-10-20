import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { seal } from '../../src/crypto/secretbox.js';
import { streaks } from '../../src/stats/stats.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-5.1 and 5.2: lifetime totals against a SQL hand count over the same tables, the heatmap's
 * America/New_York days, and a year in review. The plays straddle New Year's Eve in New York, which
 * is already New Year's Day in UTC.
 */

let h: Harness;
let cookie = '';
const SHOW = 'show:stats:one';

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'stats@example.com', displayName: 'S' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'stats owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'stats@example.com', password: 'stats owner password' })), 'kuro_session') ?? '';
  const sealed = seal('rt', SECRET_KEY);
  const conn = await h.db.crConnection.create({ data: { userId: user.id, accountId: '00000000-0000-4000-8000-0000000000f3', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await h.db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } });
  await h.db.crSeries.create({ data: { id: 'GSTATS', title: 'Stats Show', raw: {} } });
  await h.db.crSeason.create({ data: { id: 'GSTATSS1', seriesId: 'GSTATS', title: 'Season 1', seasonNumber: 1, raw: {} } });
  await h.db.crEpisode.createMany({
    data: [1, 2, 3].map((n) => ({ id: `GSTATSE${String(n)}`, seasonId: 'GSTATSS1', title: `E${String(n)}`, episodeNumber: n, sequenceNumber: n, durationS: 1400, canonicalId: `GSTATSE${String(n)}`, audioLocale: n === 3 ? 'ja-JP' : 'en-US', raw: {} })),
  });
  await h.db.show.create({ data: { showKey: SHOW, title: 'Stats Show', franchiseKey: `fr:${SHOW}`, seriesIds: ['GSTATS'], derivedAt: new Date() } });
  await h.db.showState.create({ data: { showKey: SHOW, title: 'Stats Show', status: 'watching', watchedEpisodes: 2, totalEpisodes: 3, remainingS: 1400, derivedAt: new Date() } });
  const play = (ep: number, at: string, playheadS: number, fullyWatched: boolean) => ({ crEpisodeId: `GSTATSE${String(ep)}`, crParentId: 'GSTATS', crParentType: 'series' as const, datePlayed: new Date(at), playheadS, fullyWatched, raw: {}, syncRunId: run.id });
  await h.db.play.createMany({
    data: [
      // 23:30 on 31 December in New York — 04:30 on 1 January in UTC.
      play(1, '2001-01-01T04:30:00Z', 1400, true),
      // A playhead past the end counts as the episode's length.
      play(2, '2001-01-01T04:50:00Z', 1500, true),
      play(3, '2001-01-02T15:00:00Z', 600, false),
    ],
  });
});

// Plays are append-only (KURO-REQ-004); the database is new each run, so they stay.
afterAll(async () => {
  await h.db.showState.deleteMany({ where: { showKey: SHOW } });
  await h.db.show.deleteMany({ where: { showKey: SHOW } });
  await h.close();
});

const get = async (path: string) => {
  const res = await fetch(`${h.base}${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
};

describe('lifetime stats (KURO-T-5.1)', () => {
  it('the totals match a SQL hand count over the whole vault', async () => {
    const [hand] = await h.db.$queryRaw<{ plays: bigint; episodes: bigint; seconds: bigint; days: bigint }[]>`
      SELECT count(*) AS plays,
             (SELECT count(DISTINCT cr_episode_id) FROM play WHERE fully_watched) AS episodes,
             sum(CASE WHEN e.duration_s > 0 AND p.playhead_s > e.duration_s THEN e.duration_s ELSE p.playhead_s END) AS seconds,
             count(DISTINCT date(timezone('America/New_York', p.date_played))) AS days
      FROM play p LEFT JOIN cr_episode e ON e.id = p.cr_episode_id`;
    const body = (await get('/api/stats')).body as { totals: { plays: number; episodes: number; seconds: number; days: number } };
    expect(body.totals).toMatchObject({ plays: Number(hand?.plays), episodes: Number(hand?.episodes), seconds: Number(hand?.seconds), days: Number(hand?.days) });
  });

  it('the heatmap and the years count New York days', async () => {
    const body = (await get('/api/stats')).body as { years: { year: number; plays: number; seconds: number }[]; timezone: string };
    expect(body.timezone).toBe('America/New_York');
    // Two of the three plays were on 31 December 2000 in New York.
    expect(body.years.find((y) => y.year === 2000)).toEqual({ year: 2000, plays: 2, seconds: 2800 });
    expect(body.years.find((y) => y.year === 2001)).toEqual({ year: 2001, plays: 1, seconds: 600 });
  });

  it('streaks run over consecutive days, and the current one ends today or yesterday', () => {
    expect(streaks(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-07', '2026-10-08'], '2026-10-09')).toEqual({ longest: 3, current: 2 });
    expect(streaks(['2026-10-01'], '2026-10-09')).toEqual({ longest: 1, current: 0 });
    expect(streaks([], '2026-10-09')).toEqual({ longest: 0, current: 0 });
  });
});

describe('year in review (KURO-T-5.2)', () => {
  it('a year with plays: hours, top Shows, the busiest month, the biggest day and Shows started', async () => {
    const res = await get('/api/stats/years/2000');
    const { status } = res;
    const body = res.body as {
      totals: { plays: number; seconds: number; dubShare: number | null };
      top: { showKey: string; seconds: number }[];
      busiestMonth: number;
      biggestDay: { day: string; plays: number };
      started: { showKey: string }[];
    };
    expect(status).toBe(200);
    expect(body.totals).toMatchObject({ plays: 2, seconds: 2800, dubShare: 1 });
    expect(body.top[0]).toMatchObject({ showKey: SHOW, seconds: 2800 });
    expect(body.busiestMonth).toBe(12);
    expect(body.biggestDay).toMatchObject({ day: '2000-12-31', plays: 2 });
    expect(body.started.map((s) => s.showKey)).toContain(SHOW);
    const next = (await get('/api/stats/years/2001')).body as { totals: { dubShare: number }; started: { showKey: string }[] };
    expect(next.totals.dubShare).toBe(0);
    expect(next.started.map((s) => s.showKey)).not.toContain(SHOW);
  });

  it('a year without plays is a 404; nonsense is a 400', async () => {
    expect((await get('/api/stats/years/2003')).status).toBe(404);
    expect((await get('/api/stats/years/nineteen')).status).toBe(400);
  });
});
