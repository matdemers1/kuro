import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { buildPool, prefetchCandidates, toEntry, type CatalogEntryRow, type MediaSource } from './pool.js';
import { matchSeries, type Proposal } from './ranges.js';
import { TitleIndex } from './titles.js';

/**
 * Run the matcher over everything the owner has watched (KURO-T-2.3) and write mappings.
 *
 * Only `auto` rows are ever replaced: a season holding any `confirmed` or `override` row belongs to
 * the owner and is left alone (KURO-ADR-003). Every season of a watched series is mapped, not only
 * the ones with plays, so Up Next can see the next season. A mapping whose catalog entry was
 * retired by a catalog import goes back to review — the remap queue (KURO-T-2.1).
 */

export interface MatchDeps {
  readonly db: Db;
  readonly anilist: MediaSource;
  readonly log: Logger;
  readonly now?: Date;
}

export interface MatchOutcome {
  readonly series: number;
  readonly accepted: number;
  readonly review: number;
  readonly kept: number;
  readonly remap: number;
}

export async function loadCatalog(db: Db) {
  const rows = (await db.catalogEntry.findMany({ select: { id: true, title: true, synonyms: true, type: true, episodes: true, status: true, seasonYear: true, season: true, anilistId: true, retiredAt: true } })).map(toEntry);
  return {
    index: new TitleIndex<CatalogEntryRow>(rows),
    byAnilist: new Map(rows.flatMap((r) => (r.anilistId === null ? [] : [[r.anilistId, r] as const]))),
  };
}

export async function matchCatalog(deps: MatchDeps, userId: string): Promise<MatchOutcome> {
  const { db, log } = deps;
  if ((await db.catalogEntry.count()) === 0) {
    log.info('no catalog yet; matching waits for the first import');
    return { series: 0, accepted: 0, review: 0, kept: 0, remap: 0 };
  }
  const { index, byAnilist } = await loadCatalog(db);
  const watched = await db.play.findMany({ where: { syncRun: { crConnection: { userId } }, crParentType: 'series' }, distinct: ['crParentId'], select: { crParentId: true } });
  const planned = await db.planEntry.findMany({ select: { crSeriesId: true }, distinct: ['crSeriesId'] });
  const series = await db.crSeries.findMany({
    where: { id: { in: [...new Set([...watched.map((w) => w.crParentId), ...planned.map((p) => p.crSeriesId)])] } },
    include: { seasons: { include: { episodes: { select: { id: true, episodeNumber: true, sequenceNumber: true, durationS: true, airDate: true, canonicalId: true } } } } },
  });

  await prefetchCandidates(series.map((s) => ({ id: s.id, title: s.title, slug: s.slugTitle, seasonTitles: s.seasons.map((x) => x.title) })), index, deps.anilist);

  let accepted = 0;
  let review = 0;
  let kept = 0;
  for (const s of series) {
    const seasons = [...s.seasons].sort((a, b) => (a.seasonSequenceNumber ?? a.seasonNumber) - (b.seasonSequenceNumber ?? b.seasonNumber));
    const owned = new Set((await db.mapping.findMany({ where: { crSeasonId: { in: seasons.map((x) => x.id) }, source: { not: 'auto' } }, select: { crSeasonId: true } })).map((m) => m.crSeasonId));
    const pool = await buildPool({ id: s.id, title: s.title, slug: s.slugTitle, seasonTitles: seasons.map((x) => x.title) }, index, byAnilist, deps.anilist);
    kept += owned.size;
    const proposals: Proposal[] = matchSeries(
      seasons.map((season) => ({ id: season.id, title: season.title, episodes: season.episodes.map((e) => ({ number: e.episodeNumber, sequence: e.sequenceNumber, durationS: e.durationS, airDate: e.airDate, canonicalId: e.canonicalId ?? e.id })) })),
      pool,
      deps.now,
    ).filter((p) => !owned.has(p.seasonId));
    const seasonIds = seasons.filter((x) => !owned.has(x.id)).map((x) => x.id);
    await db.$transaction([
      db.mapping.deleteMany({ where: { crSeasonId: { in: seasonIds }, source: 'auto' } }),
      db.mapping.createMany({
        data: proposals.map((p) => ({
          crSeasonId: p.seasonId,
          epFrom: p.epFrom,
          epTo: p.epTo,
          catalogEntryId: p.entryId,
          offset: p.offset,
          source: 'auto',
          status: p.confidence === 'strong' ? 'accepted' : 'review',
          confidence: p.confidence,
          signals: [...p.signals],
          candidates: [...p.candidates],
          autoEntryId: p.entryId,
        })),
        skipDuplicates: true,
      }),
    ]);
    for (const p of proposals) {
      if (p.confidence === 'strong') accepted++;
      else review++;
    }
  }

  // The remap queue: a mapping to a retired entry needs the owner, whoever wrote it.
  const remap = await db.$executeRaw`
    UPDATE mapping m SET status = 'review', signals = array_append(m.signals, 'catalog entry retired'), updated_at = now()
    FROM catalog_entry e
    WHERE e.id = m.catalog_entry_id AND e.retired_at IS NOT NULL AND m.status <> 'review'`;

  log.info({ series: series.length, accepted, review, kept, remap }, 'catalog matched');
  return { series: series.length, accepted, review, kept, remap };
}
