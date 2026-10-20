import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCatalog } from '../../src/catalog/import.js';
import { createDb, type Db } from '../../src/db.js';
import { checkAlerts } from '../../src/jobs/alertsCheck.js';
import { Alerts } from '../../src/push/sender.js';

/**
 * KURO-T-2.1: the weekly catalog import. A fake GitHub serves two continuations the way they really
 * publish — cedya77 a JSONL plus a non-catalog `fillers` release, athanasso only minified JSON — so
 * the source swap, stable ids, retirement and the stale alert are exercised end to end.
 */

const DEMON_SLAYER = {
  sources: ['https://anilist.co/anime/101922', 'https://myanimelist.net/anime/38000', 'https://kitsu.app/anime/41370'],
  title: 'Kimetsu no Yaiba',
  type: 'TV',
  episodes: 26,
  status: 'FINISHED',
  animeSeason: { season: 'SPRING', year: 2019 },
  picture: 'https://cdn.example/ds.jpg',
  duration: { value: 1380, unit: 'SECONDS' },
  synonyms: ['Demon Slayer: Kimetsu no Yaiba'],
  relatedAnime: ['https://anilist.co/anime/112151'],
  tags: ['action'],
  studios: ['ufotable'],
};
const MUGEN_TRAIN = { sources: ['https://myanimelist.net/anime/40456'], title: 'Kimetsu no Yaiba Movie: Mugen Ressha-hen', type: 'MOVIE', episodes: 1, status: 'FINISHED', animeSeason: { season: 'FALL', year: 2020 }, duration: { value: 117, unit: 'MINUTES' }, synonyms: [], relatedAnime: [], tags: [], studios: [] };
const OBSCURE = { sources: ['https://anidb.net/anime/99999'], title: 'Obscure OVA', type: 'OVA', episodes: 2, status: 'FINISHED', animeSeason: { season: 'UNDEFINED', year: 0 }, synonyms: [], relatedAnime: [], tags: [], studios: [] };
const SPY = { sources: ['https://anilist.co/anime/140960', 'https://myanimelist.net/anime/50265'], title: 'Spy x Family', type: 'TV', episodes: 12, status: 'FINISHED', animeSeason: { season: 'SPRING', year: 2022 }, synonyms: [], relatedAnime: [], tags: [], studios: [] };

let base = '';
let server: Server;
let db: Db;
const log = pino({ level: 'silent' });
const athanassoPublished = '2026-10-18T07:46:35Z';

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '';
    if (url.startsWith('/repos/cedya77/aod/releases')) {
      res.end(JSON.stringify([
        { tag_name: 'fillers', published_at: '2026-10-19T12:00:00Z', assets: [{ name: 'fillers.json', browser_download_url: `${base}/files/fillers.json` }] },
        { tag_name: '2026-43', published_at: '2026-10-19T11:17:03Z', assets: [{ name: 'anime-offline-database.jsonl', browser_download_url: `${base}/files/cedya.jsonl` }] },
        { tag_name: '2026-42', published_at: '2026-10-12T11:00:00Z', assets: [{ name: 'anime-offline-database.jsonl', browser_download_url: `${base}/files/old.jsonl` }] },
      ]));
    } else if (url.startsWith('/repos/athanasso/aod/releases')) {
      res.end(JSON.stringify([{ tag_name: '2026-42', published_at: athanassoPublished, assets: [{ name: 'anime-offline-database-minified.json', browser_download_url: `${base}/files/athanasso.json` }] }]));
    } else if (url === '/files/cedya.jsonl') {
      res.end([{ $schema: 'x', license: { name: 'ODbL' }, lastUpdate: '2026-10-19' }, DEMON_SLAYER, MUGEN_TRAIN, OBSCURE, { title: 'no sources, dropped' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    } else if (url === '/files/athanasso.json') {
      // Demon Slayer lost its AniList source upstream; Obscure is gone; Spy x Family is new.
      res.end(JSON.stringify({ license: { name: 'ODbL' }, data: [{ ...DEMON_SLAYER, sources: DEMON_SLAYER.sources.slice(1), episodes: 27 }, MUGEN_TRAIN, SPY] }));
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  db = createDb(process.env['DATABASE_URL'] ?? '');
});

afterAll(async () => {
  // The catalog is global; leave nothing for the alert tests to trip over.
  await db.catalogEntry.deleteMany();
  await db.catalogRelease.deleteMany();
  await db.alert.deleteMany({ where: { key: { startsWith: 'catalog-stale:' } } });
  server.close();
  await db.$disconnect();
});

describe('catalog import (KURO-REQ-025)', () => {
  it('imports the newest weekly cedya77 JSONL, skipping the fillers release and broken records', async () => {
    const out = await importCatalog(db, { repo: 'cedya77/aod', apiBase: base }, log);
    expect(out).toMatchObject({ status: 'imported', tag: '2026-43', entries: 3, added: 3, retired: 0 });
    const ds = await db.catalogEntry.findUniqueOrThrow({ where: { id: 'anilist:101922' } });
    expect(ds).toMatchObject({ title: 'Kimetsu no Yaiba', episodes: 26, season: 'SPRING', seasonYear: 2019, durationS: 1380, anilistId: 101922, malId: 38000 });
    expect(ds.synonyms).toContain('Demon Slayer: Kimetsu no Yaiba');
    expect((await db.catalogEntry.findUniqueOrThrow({ where: { id: 'mal:40456' } })).durationS).toBe(117 * 60);
    expect(await db.catalogEntry.findUniqueOrThrow({ where: { id: 'src:https://anidb.net/anime/99999' } })).toMatchObject({ season: null, seasonYear: null });
  });

  it('does nothing when the newest release is already imported', async () => {
    expect((await importCatalog(db, { repo: 'cedya77/aod', apiBase: base }, log)).status).toBe('unchanged');
  });

  it('swaps to athanasso by repo alone: ids survive a changed source list, and a vanished entry is retired, not deleted', async () => {
    const out = await importCatalog(db, { repo: 'athanasso/aod', apiBase: base }, log);
    expect(out).toMatchObject({ status: 'imported', tag: '2026-42', entries: 3, added: 1, retired: 1 });
    // Matched back through the MAL source it still has: same id, new data.
    const ds = await db.catalogEntry.findUniqueOrThrow({ where: { id: 'anilist:101922' } });
    expect(ds).toMatchObject({ episodes: 27, retiredAt: null });
    expect((await db.catalogEntry.findUniqueOrThrow({ where: { id: 'src:https://anidb.net/anime/99999' } })).retiredAt).not.toBeNull();
    expect(await db.catalogEntry.findUnique({ where: { id: 'anilist:140960' } })).not.toBeNull();
    expect(await db.catalogEntry.count()).toBe(4);
  });
});

describe('stale catalog alert (KURO-REQ-026)', () => {
  it('alerts once when the newest release is over three weeks old', async () => {
    const alerts = new Alerts(db, null, log);
    const fresh = await checkAlerts(db, alerts);
    expect(fresh.filter((k) => k.startsWith('catalog-stale:'))).toHaveLength(0);

    await db.catalogRelease.updateMany({ data: { publishedAt: new Date(Date.now() - 22 * 24 * 3_600_000) } });
    const stale = await checkAlerts(db, alerts);
    expect(stale.filter((k) => k.startsWith('catalog-stale:'))).toHaveLength(1);
    expect((await checkAlerts(db, alerts)).filter((k) => k.startsWith('catalog-stale:'))).toHaveLength(0);
  });
});
