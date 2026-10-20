import { crunchyrollKeys, type AniListMedia } from '../adapters/anilist.js';
import { seasonIndex, type EntryIn, type Pool } from './ranges.js';
import type { TitleIndex } from './titles.js';

/**
 * The entries a Crunchyroll series could map to (KURO-T-2.3). Title search finds candidates;
 * AniList, asked only about those (KURO-ADR-002), says which of them link to this very Crunchyroll
 * series — the anchors — and through its typed relations which entries form the main line (sequels
 * and prequels) and the wider franchise (side stories, spin-offs, movies).
 */

export interface CatalogEntryRow extends EntryIn {
  readonly anilistId: number | null;
  readonly retired: boolean;
}

export interface SeriesIn {
  readonly id: string;
  readonly title: string;
  readonly slug: string | null;
  readonly seasonTitles: readonly string[];
}

export interface MediaSource {
  media(ids: readonly number[]): Promise<Map<number, AniListMedia>>;
}

/** Relations that keep a franchise together; ADAPTATION, SOURCE, CHARACTER and OTHER do not. */
const FRANCHISE = new Set(['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY', 'PARENT', 'COMPILATION', 'CONTAINS']);
const MAIN_LINE = new Set(['SEQUEL', 'PREQUEL']);
/** How many candidates per series AniList is asked about. */
export const CANDIDATES = 12;
const FRANCHISE_LIMIT = 60;

export function toEntry(row: {
  id: string;
  title: string;
  synonyms: string[];
  type: string;
  episodes: number;
  status: string;
  seasonYear: number | null;
  season: string | null;
  anilistId: number | null;
  retiredAt: Date | null;
}): CatalogEntryRow {
  return {
    id: row.id,
    title: row.title,
    synonyms: row.synonyms,
    type: row.type,
    episodes: row.episodes,
    status: row.status,
    year: row.seasonYear,
    seasonIndex: seasonIndex(row.season),
    anilistId: row.anilistId,
    retired: row.retiredAt !== null,
  };
}

/**
 * Ask AniList about every series' candidates in one go, 50 to a request, before pools are built:
 * one request per series would spend the 20-a-minute budget on half-empty requests.
 */
export async function prefetchCandidates(series: readonly SeriesIn[], index: TitleIndex<CatalogEntryRow>, anilist: MediaSource): Promise<void> {
  const ids = new Set<number>();
  for (const s of series) {
    for (const e of index.search([s.title, ...s.seasonTitles], 25).filter((c) => !c.retired).slice(0, CANDIDATES)) {
      if (e.anilistId !== null) ids.add(e.anilistId);
    }
  }
  await anilist.media([...ids]);
}

export async function buildPool(series: SeriesIn, index: TitleIndex<CatalogEntryRow>, byAnilist: ReadonlyMap<number, CatalogEntryRow>, anilist: MediaSource): Promise<Pool> {
  const candidates = index.search([series.title, ...series.seasonTitles], 25).filter((e) => !e.retired);
  const asked = candidates.slice(0, CANDIDATES).flatMap((e) => (e.anilistId === null ? [] : [e.anilistId]));
  const media = new Map(await anilist.media(asked));

  const keys = new Set([series.id.toLowerCase(), ...(series.slug === null ? [] : [series.slug.toLowerCase()])]);
  const anchors = asked.filter((id) => {
    const m = media.get(id);
    return m !== undefined && [...crunchyrollKeys(m)].some((k) => keys.has(k));
  });
  if (anchors.length === 0) {
    return { entries: candidates, anchored: false, mainLine: new Set(), franchise: new Set(), seriesTitle: series.title };
  }

  // Walk the franchise outward from the anchors, a layer at a time, asking AniList only for nodes
  // that are catalog entries and not yet known.
  const franchise = new Set<number>(anchors);
  let frontier = anchors;
  while (frontier.length > 0 && franchise.size < FRANCHISE_LIMIT) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const edge of media.get(id)?.relations ?? []) {
        if (!FRANCHISE.has(edge.relationType) || edge.node.type !== 'ANIME' || franchise.has(edge.node.id)) continue;
        if (!byAnilist.has(edge.node.id)) continue;
        franchise.add(edge.node.id);
        next.push(edge.node.id);
      }
    }
    for (const [id, m] of await anilist.media(next.filter((id) => !media.has(id)))) media.set(id, m);
    frontier = next;
  }

  // The main line: what sequel and prequel edges reach from an anchor.
  const mainLine = new Set<number>(anchors);
  const stack = [...anchors];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    for (const edge of media.get(id)?.relations ?? []) {
      if (MAIN_LINE.has(edge.relationType) && franchise.has(edge.node.id) && !mainLine.has(edge.node.id)) {
        mainLine.add(edge.node.id);
        stack.push(edge.node.id);
      }
    }
  }

  const toIds = (ids: Iterable<number>) => new Set([...ids].flatMap((a) => byAnilist.get(a)?.id ?? []));
  const franchiseIds = toIds(franchise);
  const entries = new Map<string, CatalogEntryRow>();
  for (const id of franchiseIds) {
    const e = index.get(id);
    if (e !== undefined && !e.retired) entries.set(id, e);
  }
  for (const c of candidates) entries.set(c.id, c);
  return { entries: [...entries.values()], anchored: true, mainLine: toIds(mainLine), franchise: franchiseIds, seriesTitle: series.title };
}
