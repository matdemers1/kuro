import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AniList } from '../adapters/anilist.js';
import { importCatalog } from '../catalog/import.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createLogger } from '../logger.js';
import { buildPool, prefetchCandidates, toEntry, type CatalogEntryRow } from '../match/pool.js';
import { matchSeries, type Proposal } from '../match/ranges.js';
import { TitleIndex } from '../match/titles.js';

/**
 * `kuro matcher-eval fixtures/real/` (KURO-T-2.3): the matcher over the owner's real history, without
 * writing a mapping. It reads `cr.json` — series, seasons, episodes and plays exported from the
 * vault, kept in the gitignored fixtures/real/ — and prints the auto-accept rate, how many shows
 * need review, and how many confirmed mappings the matcher would contradict (known-wrong). The
 * KURO-R-004 gate: at most 10% of shows needing a manual fix. `--verbose` lists the shows to review.
 */

const Fixture = z.object({
  series: z.array(z.object({ id: z.string(), title: z.string(), slug: z.string().nullable() })),
  seasons: z.array(z.object({ id: z.string(), seriesId: z.string(), title: z.string(), sequence: z.number().nullable() })),
  episodes: z.array(z.object({ id: z.string(), seasonId: z.string(), number: z.number().nullable(), sequence: z.number(), durationS: z.number(), airDate: z.string().nullable(), canonicalId: z.string().nullable() })),
  plays: z.array(z.object({ episodeId: z.string(), parentId: z.string() })),
});

export async function matcherEval(args: readonly string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith('--'));
  if (dir === undefined) {
    console.error('usage: kuro matcher-eval <dir with cr.json> [--verbose]');
    return 2;
  }
  const verbose = args.includes('--verbose');
  /** Every proposal, strong ones too — for checking that what is auto-accepted is right. */
  const list = args.includes('--list');
  const config = loadConfig();
  if (config.DATABASE_URL === undefined) {
    console.error('DATABASE_URL is required: the catalog and the AniList cache live there');
    return 2;
  }
  const log = createLogger(config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL);
  try {
    const fx = Fixture.parse(JSON.parse(await readFile(join(resolve(process.env['INIT_CWD'] ?? process.cwd(), dir), 'cr.json'), 'utf8')));
    if ((await db.catalogRelease.count()) === 0) await importCatalog(db, { repo: config.KURO_CATALOG_REPO }, log);

    const rows = (await db.catalogEntry.findMany({ select: { id: true, title: true, synonyms: true, type: true, episodes: true, status: true, seasonYear: true, season: true, anilistId: true, retiredAt: true } })).map(toEntry);
    const index = new TitleIndex<CatalogEntryRow>(rows);
    const byAnilist = new Map(rows.flatMap((r) => (r.anilistId === null ? [] : [[r.anilistId, r] as const])));
    const anilist = new AniList(db, log);

    const playedSeasons = new Set(fx.plays.flatMap((p) => fx.episodes.find((e) => e.id === p.episodeId)?.seasonId ?? []));
    const watched = new Set(fx.plays.map((p) => p.parentId));
    const episodesBySeason = new Map<string, (typeof fx.episodes)[number][]>();
    for (const e of fx.episodes) episodesBySeason.set(e.seasonId, [...(episodesBySeason.get(e.seasonId) ?? []), e]);

    const watchedSeries = fx.series.filter((s) => watched.has(s.id));
    await prefetchCandidates(watchedSeries.map((s) => ({ id: s.id, title: s.title, slug: s.slug, seasonTitles: fx.seasons.filter((x) => x.seriesId === s.id).map((x) => x.title) })), index, anilist);

    let auto = 0;
    let review = 0;
    let anchored = 0;
    let weakSeasons = 0;
    let unmatched = 0;
    const toReview: string[] = [];
    for (const series of watchedSeries) {
      const seasons = fx.seasons.filter((s) => s.seriesId === series.id).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const pool = await buildPool({ id: series.id, title: series.title, slug: series.slug, seasonTitles: seasons.map((s) => s.title) }, index, byAnilist, anilist);
      if (pool.anchored) anchored++;
      // Every season in order (the matcher needs them all), scored on the ones the owner played.
      const proposals: Proposal[] = matchSeries(
        seasons.map((s) => ({ id: s.id, title: s.title, episodes: (episodesBySeason.get(s.id) ?? []).map((e) => ({ number: e.number, sequence: e.sequence, durationS: e.durationS, airDate: e.airDate === null ? null : new Date(e.airDate), canonicalId: e.canonicalId ?? e.id })) })),
        pool,
      ).filter((p) => playedSeasons.has(p.seasonId));
      if (list) {
        console.log(series.title);
        for (const p of proposals) {
          const e = p.entryId === null ? undefined : index.get(p.entryId);
          const season = seasons.find((s) => s.id === p.seasonId)?.title ?? p.seasonId;
          console.log(`  ${p.confidence === 'strong' ? '✓' : '?'} "${season}" E${String(p.epFrom)}–${String(p.epTo)} → ${e === undefined ? '—' : `${e.title} [${e.type} ${String(e.episodes)} ${String(e.year ?? '?')}] ${p.offset === 0 ? '' : `offset ${String(p.offset)}`}`}`);
        }
      }
      const weak = proposals.filter((p) => p.confidence === 'weak');
      weakSeasons += weak.length;
      unmatched += proposals.filter((p) => p.entryId === null).length;
      if (weak.length === 0) auto++;
      else {
        review++;
        if (verbose) {
          const line = weak.map((p) => {
            const season = seasons.find((s) => s.id === p.seasonId)?.title ?? p.seasonId;
            const guess = p.entryId === null ? '—' : `${index.get(p.entryId)?.title ?? p.entryId} (${index.get(p.entryId)?.type ?? '?'} ${String(index.get(p.entryId)?.episodes ?? '?')})`;
            return `    E${String(p.epFrom)}–${String(p.epTo)} "${season}" → ${guess}: ${p.signals.join(', ')}`;
          });
          toReview.push(`  ${series.title}${pool.anchored ? '' : ' [no AniList link]'}\n${line.join('\n')}`);
        }
      }
    }
    const shows = auto + review;
    const known = await knownWrong(db);
    console.log(`shows ${String(shows)} · auto-accepted ${String(auto)} (${pct(auto, shows)}) · need review ${String(review)} (${pct(review, shows)}) · AniList-anchored ${String(anchored)}`);
    console.log(`weak season ranges ${String(weakSeasons)} · unmatched ${String(unmatched)} · known-wrong ${known === null ? 'n/a (no confirmed mappings yet)' : String(known)}`);
    console.log(`KURO-R-004 gate (≤10% need a manual fix): ${review / Math.max(1, shows) <= 0.1 ? 'PASS' : 'FAIL'}`);
    if (verbose && toReview.length > 0) console.log(`\nto review:\n${toReview.join('\n')}`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

const pct = (n: number, of: number) => `${String(Math.round((n / Math.max(1, of)) * 1000) / 10)}%`;

/** Confirmed or overridden mappings an automatic run would have got wrong — null before any exist. */
async function knownWrong(db: ReturnType<typeof createDb>): Promise<number | null> {
  const tables = await db.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('public.mapping') IS NOT NULL AS exists`;
  if (tables[0]?.exists !== true) return null;
  const rows = await db.$queryRaw<{ wrong: bigint; total: bigint }[]>`SELECT count(*) FILTER (WHERE auto_entry_id IS DISTINCT FROM catalog_entry_id) AS wrong, count(*) AS total FROM mapping WHERE source IN ('confirmed', 'override')`;
  const r = rows[0];
  return r === undefined || r.total === 0n ? null : Number(r.wrong);
}
