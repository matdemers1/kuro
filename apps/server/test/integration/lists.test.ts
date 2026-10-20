import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrSidecar } from '../../src/adapters/crunchyroll.js';
import { importLists, seriesOf } from '../../src/cr/lists.js';
import { seal } from '../../src/crypto/secretbox.js';
import { createDb, type Db } from '../../src/db.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { upNext } from '../../src/derive/show.js';
import { SECRET_KEY } from './helpers.js';

/**
 * KURO-T-3.5: the watchlist and every Crunchylist come in as Plan to watch after a sync. A fake
 * sidecar serves the lists; the series behind them are already resolved, as a sync would leave them.
 */

let server: Server;
let db: Db;
let userId = '';
let runId = '';
let watchlist: unknown[] = [{ panel: { id: 'GPLANA', type: 'series' } }, { panel: { id: 'GMOVIE', type: 'movie_listing' } }];
const crunchylists = [{ id: 'list-1', title: 'Weekend', items: [{ id: 'x', list_id: 'list-1', panel: { id: 'GEPB1', type: 'episode', episode_metadata: { series_id: 'GPLANB' } } }] }];
const deps = () => ({ db, sidecar: new CrSidecar(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`), secretKey: SECRET_KEY, log: pino({ level: 'silent' }) });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const b = JSON.parse(body) as { refreshToken: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ refreshToken: `${b.refreshToken}-r`, watchlist, crunchylists }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  db = createDb(process.env['DATABASE_URL'] ?? '');
  const user = await db.user.create({ data: { email: 'lists@example.com', displayName: 'L' } });
  userId = user.id;
  const sealed = seal('rt', SECRET_KEY);
  const conn = await db.crConnection.create({ data: { userId, accountId: '00000000-0000-4000-8000-0000000000f1', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: sealed.split('.')[0] ?? '' } });
  runId = (await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } })).id;
  for (const id of ['GPLANA', 'GPLANB']) {
    await db.crSeries.create({ data: { id, title: `Planned ${id}`, raw: {} } });
    await db.crSeason.create({ data: { id: `${id}S1`, seriesId: id, title: 'Season 1', seasonNumber: 1, raw: {} } });
    await db.crEpisode.createMany({ data: [1, 2].map((n) => ({ id: `${id}E${String(n)}`, seasonId: `${id}S1`, title: `E${String(n)}`, episodeNumber: n, sequenceNumber: n, durationS: 1420, canonicalId: `${id}E${String(n)}`, raw: {} })) });
  }
});

afterAll(async () => {
  await db.planEntry.deleteMany();
  server.close();
  await db.$disconnect();
});

const state = (series: string) => db.showState.findUnique({ where: { showKey: `cr:${series}` } });

describe('watchlist and Crunchylists (KURO-T-3.5)', () => {
  it('reads the series an entry stands for — an episode stands for its series, a movie for nothing yet', () => {
    expect(seriesOf({ panel: { id: 'GS', type: 'series' } })).toBe('GS');
    expect(seriesOf({ panel: { id: 'GE', type: 'episode', episode_metadata: { series_id: 'GS2' } } })).toBe('GS2');
    expect(seriesOf({ panel: { id: 'GM', type: 'movie_listing' } })).toBeNull();
    expect(seriesOf({})).toBeNull();
  });

  it('every watchlist and Crunchylist series appears as Plan to watch after a sync, and stays out of Up Next', async () => {
    expect(await importLists(deps(), userId)).toBe(2);
    await rebuildShows(db, userId);
    expect((await state('GPLANA'))?.status).toBe('plan_to_watch');
    expect((await state('GPLANB'))?.status).toBe('plan_to_watch');
    const order = upNext((await db.showState.findMany()).map((s) => ({ ...s, pinned: false })));
    expect(order.some((o) => o.showKey === 'cr:GPLANA' || o.showKey === 'cr:GPLANB')).toBe(false);
    expect((await db.crConnection.findUniqueOrThrow({ where: { userId } })).refreshTokenCiphertext).not.toContain('rt-r');
  });

  it('the first watched episode makes it Watching', async () => {
    await db.play.create({ data: { crEpisodeId: 'GPLANAE1', crParentId: 'GPLANA', crParentType: 'series', datePlayed: new Date(), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: runId } });
    await rebuildShows(db, userId);
    expect((await state('GPLANA'))?.status).toBe('watching');
  });

  it('a series taken off the watchlist leaves the plan at the next sync', async () => {
    watchlist = [];
    await importLists(deps(), userId);
    await rebuildShows(db, userId);
    expect(await db.planEntry.count({ where: { crSeriesId: 'GPLANA' } })).toBe(0);
    expect((await state('GPLANB'))?.status).toBe('plan_to_watch');
  });
});
