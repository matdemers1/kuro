import type { Db } from '../db.js';
import { deriveShow, type EpisodeIn, type PlayIn } from './show.js';

/**
 * Rebuild every Show's derived state from scratch, in one transaction (KURO-ADR-004): the vault,
 * the resolved catalog and nothing else go in; show_state comes out whole. Run after every sync and
 * resolve, and after any owner override. Deterministic: same inputs, same rows.
 */
export async function rebuildShows(db: Db, userId: string, now = new Date(), fallbackLocale = 'en-US'): Promise<number> {
  const plays = await db.play.findMany({
    where: { syncRun: { crConnection: { userId } }, crParentType: 'series' },
    select: { crEpisodeId: true, crParentId: true, datePlayed: true, playheadS: true, fullyWatched: true },
  });
  const bySeries = new Map<string, PlayIn[]>();
  for (const p of plays) {
    const list = bySeries.get(p.crParentId) ?? [];
    list.push(p);
    bySeries.set(p.crParentId, list);
  }

  const series = await db.crSeries.findMany({
    where: { id: { in: [...bySeries.keys()] } },
    include: { seasons: { include: { episodes: true } } },
    orderBy: { id: 'asc' },
  });

  const rows = series.map((s) => {
    const episodes: EpisodeIn[] = s.seasons.flatMap((season) =>
      season.episodes.map((e) => ({
        id: e.id,
        canonicalId: e.canonicalId ?? e.id,
        seasonNumber: season.seasonNumber,
        seasonSequence: season.seasonSequenceNumber ?? season.seasonNumber,
        sequenceNumber: e.sequenceNumber,
        episodeNumber: e.episodeNumber,
        title: e.title,
        durationS: e.durationS,
        audioLocale: e.audioLocale,
        airDate: e.airDate,
        creditsStartS: e.creditsStartS,
      })),
    );
    const out = deriveShow(episodes, bySeries.get(s.id) ?? [], now, fallbackLocale);
    return { showKey: `cr:${s.id}`, title: s.title, ...out, derivedAt: now };
  });

  await db.$transaction([db.showState.deleteMany({}), db.showState.createMany({ data: rows })]);
  return rows.length;
}
