import type { Db } from '../db.js';
import {
  ADULT,
  closestLiked,
  DISMISSED_WEIGHT,
  idfOf,
  isConfident,
  labelOf,
  MIN_SIGNALS,
  profileOf,
  rank,
  seasonOf,
  termsOf,
  weightOf,
  type Candidate,
  type ManualAdjust,
  type Profile,
  type Signal,
  type Term,
} from './model.js';

/**
 * The recommender's inputs from the database (KURO-T-4.4/4.5): the candidate pool — the catalog's TV
 * and full-length ONA entries, cached per catalog release — and the owner's signals: their Shows with
 * ratings and statuses, their Not interested dismissals, and their edits to the taste profile.
 */

export interface PoolEntry extends Candidate {
  title: string;
  type: string;
  episodes: number;
  status: string;
  season: string | null;
  seasonYear: number | null;
  sources: readonly string[];
  related: readonly string[];
  sequel: boolean;
}

interface Pool {
  releaseId: string | null;
  entries: PoolEntry[];
  bySource: Map<string, PoolEntry>;
  idf: (t: Term) => number;
}

let cached: Pool | undefined;

/** Ten minutes or longer an episode, or of unknown length: shorts are a different thing to recommend. */
const MIN_DURATION_S = 600;

async function pool(db: Db): Promise<Pool> {
  const release = await db.catalogRelease.findFirst({ orderBy: { importedAt: 'desc' }, select: { id: true } });
  const releaseId = release?.id ?? null;
  if (cached !== undefined && cached.releaseId === releaseId) return cached;
  const rows = await db.$queryRaw<
    { id: string; title: string; type: string; episodes: number; status: string; season: string | null; season_year: number | null; tags: string[]; studios: string[]; sources: string[]; related: string[]; score: number | null }[]
  >`
SELECT id, title, type, episodes, status, season, season_year, tags, studios, sources, related, score
FROM catalog_entry
WHERE retired_at IS NULL AND type IN ('TV', 'ONA') AND NOT (tags && ${ADULT}::text[])
  AND (duration_s IS NULL OR duration_s >= ${MIN_DURATION_S})`;
  const entries = rows.map(
    (r): PoolEntry => ({
      id: r.id,
      title: r.title,
      type: r.type,
      episodes: r.episodes,
      status: r.status,
      season: r.season,
      seasonYear: r.season_year,
      terms: termsOf(r.tags, r.studios),
      score: r.score,
      sources: r.sources,
      related: r.related,
      sequel: r.tags.includes('sequel'),
    }),
  );
  const bySource = new Map(entries.flatMap((e) => e.sources.map((s) => [s, e] as const)));
  cached = { releaseId, entries, bySource, idf: idfOf(entries.map((e) => e.terms)).idf };
  return cached;
}

/** For tests: forget the cached pool after the catalog changes underneath it. */
export function forgetPool(): void {
  cached = undefined;
}

export interface Taste {
  pool: Pool;
  profile: Profile;
  signals: Signal[];
  confident: number;
  /** Catalog entries the owner already has in a Show, or has dismissed, and the URLs of their relatives. */
  excluded: { ids: Set<string>; urls: Set<string> };
  adjust: Map<Term, ManualAdjust>;
}

export async function loadTaste(db: Db): Promise<Taste> {
  const p = await pool(db);
  const [items, states, ratings, dismissed, terms] = await Promise.all([
    db.showItem.findMany({ select: { showKey: true, catalogEntryId: true, kind: true } }),
    db.showState.findMany({ select: { showKey: true, title: true, status: true } }),
    db.rating.findMany({ where: { target: { startsWith: 'show:' } } }),
    db.recDismissal.findMany(),
    db.tasteTerm.findMany(),
  ]);
  const owned = await db.catalogEntry.findMany({
    where: { id: { in: [...new Set([...items.map((i) => i.catalogEntryId), ...dismissed.map((d) => d.catalogEntryId)])] } },
    select: { id: true, title: true, tags: true, studios: true, sources: true, related: true },
  });
  const entry = new Map(owned.map((e) => [e.id, e]));
  const rating = new Map(ratings.map((r) => [r.target.slice('show:'.length), r.score]));
  const itemsOf = new Map<string, typeof items>();
  for (const i of items) itemsOf.set(i.showKey, [...(itemsOf.get(i.showKey) ?? []), i]);

  const signals: Signal[] = [];
  let confident = 0;
  for (const s of states) {
    const mine = itemsOf.get(s.showKey) ?? [];
    const seasons = mine.filter((i) => i.kind === 'season');
    const tagged = (seasons.length > 0 ? seasons : mine).flatMap((i) => entry.get(i.catalogEntryId) ?? []);
    if (tagged.length === 0) continue;
    const r = rating.get(s.showKey) ?? null;
    const weight = weightOf(r, s.status);
    if (isConfident({ weight, rated: r !== null, status: s.status })) confident += 1;
    signals.push({ key: s.showKey, title: s.title, terms: [...new Set(tagged.flatMap((e) => termsOf(e.tags, e.studios)))], weight });
  }
  for (const d of dismissed) {
    const e = entry.get(d.catalogEntryId);
    if (e !== undefined) signals.push({ key: `entry:${e.id}`, title: e.title, terms: termsOf(e.tags, e.studios), weight: DISMISSED_WEIGHT });
  }

  const adjust = new Map(terms.map((t) => [t.term, t.adjust as ManualAdjust]));
  const ids = new Set(owned.map((e) => e.id));
  const inShows = new Set(items.map((i) => i.catalogEntryId));
  const urls = new Set(owned.filter((e) => inShows.has(e.id)).flatMap((e) => [...e.sources, ...e.related]));
  return { pool: p, profile: profileOf(signals, p.idf, adjust), signals, confident, excluded: { ids, urls }, adjust };
}

const SEASON_ORDER = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const when = (e: PoolEntry) => (e.seasonYear ?? 9999) * 10 + (e.season === null ? 9 : SEASON_ORDER.indexOf(e.season));

/**
 * The entries worth recommending: not the owner's, not a relative of the owner's, not dismissed, not
 * a sequel — and not a later entry when an earlier one of the same franchise is also a candidate.
 */
export function candidatesOf(t: Taste, keep: (e: PoolEntry) => boolean): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const e of t.pool.entries) {
    if (e.sequel || !keep(e) || t.excluded.ids.has(e.id)) continue;
    if (e.sources.some((s) => t.excluded.urls.has(s)) || e.related.some((r) => t.excluded.urls.has(r))) continue;
    const earlier = e.related.some((r) => {
      const rel = t.pool.bySource.get(r);
      return rel !== undefined && rel.id !== e.id && !rel.sequel && when(rel) < when(e);
    });
    if (!earlier) out.push(e);
  }
  return out;
}

export interface Rec {
  entryId: string;
  title: string;
  type: string;
  episodes: number;
  season: string | null;
  seasonYear: number | null;
  status: string;
  fit: number;
  because: { term: Term; label: string }[];
  like: { showKey: string; title: string } | null;
}

export function toRecs(t: Taste, candidates: readonly PoolEntry[], limit: number): Rec[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const liked = t.signals.filter((s) => s.weight > 0 && !s.key.startsWith('entry:'));
  return rank(candidates, t.profile, t.pool.idf)
    .slice(0, limit)
    .flatMap((s) => {
      const e = byId.get(s.id);
      if (e === undefined) return [];
      const like = closestLiked(e, liked, t.pool.idf);
      return [
        {
          entryId: e.id,
          title: e.title,
          type: e.type,
          episodes: e.episodes,
          season: e.season,
          seasonYear: e.seasonYear,
          status: e.status,
          fit: Math.round(s.fit * 1000) / 1000,
          because: s.because.map((term) => ({ term, label: labelOf(term) })),
          like: like === null ? null : { showKey: like.key, title: like.title },
        },
      ];
    });
}

/** Discover: everything finished or airing, best fit first. */
export function discover(t: Taste, limit = 40): Rec[] {
  return toRecs(t, candidatesOf(t, (e) => e.status !== 'UPCOMING' && (e.episodes >= 6 || (e.episodes === 0 && e.status === 'ONGOING'))), limit);
}

/** Season picks: this season's new Shows, best fit first — or by the catalog's score while the profile is cold. */
export function seasonPicks(t: Taste, now: Date, limit = 12): Rec[] {
  const { season, year } = seasonOf(now);
  const fresh = candidatesOf(t, (e) => e.season === season && e.seasonYear === year && e.status !== 'FINISHED');
  if (t.confident >= MIN_SIGNALS) return toRecs(t, fresh, limit);
  const cold = { ...t, profile: { weights: new Map<Term, number>(), learned: new Map<Term, number>(), muted: new Set<Term>() } };
  return toRecs(cold, fresh, limit);
}
