import { randomUUID } from 'node:crypto';
import { seal } from '../crypto/secretbox.js';
import { createDb } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';

/**
 * `kuro seed-dev` — synthetic shows for local screenshots and design work. Invented titles and IDs
 * only (KURO-REQ-057). Refuses in production, and refuses without an owner (run setup first).
 */
export async function seedDev(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env['NODE_ENV'] === 'production') {
    console.error('seed-dev refuses to run in production');
    return 1;
  }
  const db = createDb(env['DATABASE_URL'] ?? '');
  const secretKey = env['KURO_SECRET_KEY'] ?? '';
  const owner = await db.user.findFirst();
  if (owner === null) {
    console.error('run setup first: seed-dev attaches to the owner');
    return 1;
  }
  const now = Date.now();
  const days = (d: number) => new Date(now - d * 86_400_000);
  const sealed = seal('synthetic-refresh-token', secretKey);
  const conn = await db.crConnection.upsert({
    where: { userId: owner.id },
    create: { userId: owner.id, accountId: '00000000-0000-4000-8000-00000000dev1', deviceId: randomUUID(), refreshTokenCiphertext: sealed, refreshTokenNonce: sealed.split('.')[0] ?? '', lastSuccessAt: new Date() },
    update: {},
  });
  const run = await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded', finishedAt: new Date() } });

  const shows: { id: string; title: string; seasons: number; per: number; watched: number; lastDays: number; newDub?: boolean }[] = [
    { id: 'GDEVLANT', title: 'Lantern Road', seasons: 2, per: 12, watched: 17, lastDays: 1 },
    { id: 'GDEVTIDE', title: 'Tidewright', seasons: 1, per: 12, watched: 7, lastDays: 20, newDub: true },
    { id: 'GDEVKITE', title: 'Paper Kite Academy', seasons: 3, per: 10, watched: 10, lastDays: 3 },
    { id: 'GDEVFORG', title: 'The Forgemaster’s Daughter', seasons: 1, per: 13, watched: 4, lastDays: 70 },
    { id: 'GDEVMOON', title: 'Moonlit Ledger', seasons: 1, per: 12, watched: 12, lastDays: 200 },
  ];
  for (const s of shows) {
    await db.crSeries.upsert({ where: { id: s.id }, create: { id: s.id, title: s.title, description: 'A synthetic show for local design work.', raw: {} }, update: {} });
    let i = 0;
    for (let season = 1; season <= s.seasons; season++) {
      for (const [suffix, locale] of [['JA', 'ja-JP'], ['EN', 'en-US']] as const) {
        const seasonId = `${s.id}S${String(season)}${suffix}`;
        await db.crSeason.upsert({ where: { id: seasonId }, create: { id: seasonId, seriesId: s.id, title: s.title, seasonNumber: season, seasonSequenceNumber: season, audioLocale: locale, raw: {} }, update: {} });
        for (let n = 1; n <= s.per; n++) {
          const canonical = `${s.id}E${String(season)}x${String(n)}JA`;
          const id = `${s.id}E${String(season)}x${String(n)}${suffix}`;
          const aired = s.newDub === true && suffix === 'EN' && season === 1 && n === s.watched + 1 ? days(2) : days(400);
          await db.crEpisode.upsert({
            where: { id },
            create: { id, seasonId, title: `Episode ${String(n)}${suffix === 'EN' ? ' (dub)' : ''}`, episodeNumber: n, sequenceNumber: n, durationS: 1440, audioLocale: locale, airDate: aired, canonicalId: canonical, creditsStartS: 1300, raw: {} },
            update: {},
          });
        }
      }
      for (let n = 1; n <= s.per; n++, i++) {
        if (i >= s.watched) continue;
        await db.play.create({ data: { crEpisodeId: `${s.id}E${String(season)}x${String(n)}EN`, crParentId: s.id, crParentType: 'series', datePlayed: days(s.lastDays + (s.watched - i) * 0.5), playheadS: 1440, fullyWatched: true, raw: {}, syncRunId: run.id } }).catch(() => undefined);
      }
    }
  }
  await db.showPreference.upsert({ where: { showKey: 'cr:GDEVKITE' }, create: { showKey: 'cr:GDEVKITE', pinned: true }, update: { pinned: true } });
  const n = await rebuildShows(db, owner.id);
  console.log(`seeded ${String(shows.length)} synthetic shows; ${String(n)} derived`);
  await db.$disconnect();
  return 0;
}
