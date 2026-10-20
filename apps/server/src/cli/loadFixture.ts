import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { seal } from '../crypto/secretbox.js';
import { createDb } from '../db.js';

/**
 * `kuro load-fixture fixtures/real/` — load an exported history (`cr.json`: series, seasons,
 * episodes, plays) into a local database, attached to the owner, for working on matching and
 * screens against real shapes. The export stays in the gitignored fixtures/real/ and this local
 * database; it refuses in production and without an owner.
 */
const Fixture = z.object({
  series: z.array(z.object({ id: z.string(), title: z.string(), slug: z.string().nullable() })),
  seasons: z.array(z.object({ id: z.string(), seriesId: z.string(), title: z.string(), number: z.number(), sequence: z.number().nullable(), audio: z.string().nullable() })),
  episodes: z.array(z.object({ id: z.string(), seasonId: z.string(), number: z.number().nullable(), sequence: z.number(), durationS: z.number(), audio: z.string().nullable(), airDate: z.string().nullable(), canonicalId: z.string().nullable() })),
  plays: z.array(z.object({ episodeId: z.string(), parentId: z.string(), parentType: z.enum(['series', 'movie_listing']), at: z.string(), playheadS: z.number(), full: z.boolean() })),
});

export async function loadFixture(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dir = args[0];
  if (env['NODE_ENV'] === 'production' || dir === undefined) {
    console.error(dir === undefined ? 'usage: kuro load-fixture <dir with cr.json>' : 'load-fixture refuses to run in production');
    return dir === undefined ? 2 : 1;
  }
  const db = createDb(env['DATABASE_URL'] ?? '');
  try {
    const owner = await db.user.findFirst();
    if (owner === null) {
      console.error('run setup first: load-fixture attaches to the owner');
      return 1;
    }
    const fx = Fixture.parse(JSON.parse(await readFile(join(resolve(env['INIT_CWD'] ?? process.cwd(), dir), 'cr.json'), 'utf8')));
    const sealed = seal('fixture-refresh-token', env['KURO_SECRET_KEY'] ?? '');
    const conn = await db.crConnection.upsert({
      where: { userId: owner.id },
      create: { userId: owner.id, accountId: '00000000-0000-4000-8000-00000000f1x7', deviceId: randomUUID(), refreshTokenCiphertext: sealed, refreshTokenNonce: sealed.split('.')[0] ?? '', lastSuccessAt: new Date() },
      update: {},
    });
    const run = await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded', finishedAt: new Date() } });
    await db.crSeries.createMany({ data: fx.series.map((s) => ({ id: s.id, title: s.title, slugTitle: s.slug, raw: {} })), skipDuplicates: true });
    await db.crSeason.createMany({ data: fx.seasons.map((s) => ({ id: s.id, seriesId: s.seriesId, title: s.title, seasonNumber: s.number, seasonSequenceNumber: s.sequence, audioLocale: s.audio, raw: {} })), skipDuplicates: true });
    await db.crEpisode.createMany({
      data: fx.episodes.map((e) => ({ id: e.id, seasonId: e.seasonId, title: `Episode ${String(e.number ?? '')}`, episodeNumber: e.number, sequenceNumber: e.sequence, durationS: e.durationS, audioLocale: e.audio, airDate: e.airDate === null ? null : new Date(e.airDate), canonicalId: e.canonicalId, skipCheckedAt: new Date(), raw: {} })),
      skipDuplicates: true,
    });
    const { count } = await db.play.createMany({
      data: fx.plays.map((p) => ({ crEpisodeId: p.episodeId, crParentId: p.parentId, crParentType: p.parentType, datePlayed: new Date(p.at), playheadS: p.playheadS, fullyWatched: p.full, raw: {}, syncRunId: run.id })),
      skipDuplicates: true,
    });
    console.log(`loaded ${String(fx.series.length)} series, ${String(fx.episodes.length)} episodes, ${String(count)} plays — restart the server to match and derive`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}
