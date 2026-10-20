import { watchOrder, type EntryIn } from '../match/ranges.js';

/**
 * Season → Show → Franchise (KURO-T-2.5, KURO-REQ-031). Pure: from the accepted mappings, the
 * catalog entries they point at and AniList's typed relations, which Shows exist, what is in each,
 * in what order, and which Franchise each belongs to.
 *
 *   - A Season is a TV (or full-length ONA) entry on a Show's main line; a Show is the Crunchyroll
 *     series whose seasons sit on one sequel/prequel line — merged across series when Crunchyroll
 *     splits one show into several.
 *   - An Extra is a mapped movie, OVA or special: slotted in after the season it follows by date,
 *     optional, and never blocking Completed (Mugen Train after Demon Slayer's first season). A
 *     series of nothing but extras on another show's line joins that show; otherwise it is a Show of
 *     its own — a standalone movie is its own Show in the Franchise (KURO-D-016).
 *   - A Franchise is whatever AniList's side-story, spin-off and related edges connect. A spin-off
 *     is its own Show inside it.
 *   - A series with nothing mapped stays a Show on Crunchyroll's own structure (`cr:<series>`), so
 *     an unmatched show is never lost.
 */

export interface EntryInfo extends EntryIn {
  readonly anilistId: number | null;
}

export interface RangeIn {
  readonly seriesId: string;
  readonly seasonId: string;
  readonly entryId: string | null;
}

export interface Relation {
  readonly from: number;
  readonly to: number;
  readonly type: string;
}

export interface SeriesIn {
  readonly id: string;
  readonly title: string;
}

export interface ShowItem {
  readonly entryId: string;
  readonly kind: 'season' | 'extra';
  readonly position: number;
  readonly required: boolean;
}

export interface GroupedShow {
  readonly key: string;
  readonly title: string;
  readonly franchiseKey: string;
  readonly seriesIds: readonly string[];
  readonly items: readonly ShowItem[];
}

export interface Grouping {
  readonly shows: readonly GroupedShow[];
  /** The Show each Crunchyroll series belongs to. */
  readonly showOfSeries: ReadonlyMap<string, string>;
  /** Season or extra, by catalog entry — what derivation needs to order and count episodes. */
  readonly kindOfEntry: ReadonlyMap<string, 'season' | 'extra'>;
}

const MAIN_LINE = new Set(['SEQUEL', 'PREQUEL']);
const FRANCHISE = new Set(['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY', 'PARENT', 'COMPILATION', 'CONTAINS']);

export const isSeason = (e: Pick<EntryIn, 'type' | 'episodes'>) => e.type === 'TV' || (e.type === 'ONA' && e.episodes >= 8);

class UnionFind<T> {
  private readonly parent = new Map<T, T>();
  find(x: T): T {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: T, b: T): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function groupShows(series: readonly SeriesIn[], ranges: readonly RangeIn[], entries: ReadonlyMap<string, EntryInfo>, relations: readonly Relation[]): Grouping {
  // Entry components along the main line, and across the franchise, keyed by AniList id.
  const line = new UnionFind<number>();
  const franchise = new UnionFind<number>();
  for (const r of relations) {
    if (MAIN_LINE.has(r.type)) line.union(r.from, r.to);
    if (FRANCHISE.has(r.type)) franchise.union(r.from, r.to);
  }
  const lineOf = (e: EntryInfo) => (e.anilistId === null ? `entry:${e.id}` : `al:${String(line.find(e.anilistId))}`);
  const franchiseOf = (e: EntryInfo) => (e.anilistId === null ? `entry:${e.id}` : `al:${String(franchise.find(e.anilistId))}`);

  // What each series is mapped to.
  const mapped = new Map<string, EntryInfo[]>();
  for (const r of ranges) {
    const e = r.entryId === null ? undefined : entries.get(r.entryId);
    if (e === undefined) continue;
    const list = mapped.get(r.seriesId) ?? [];
    if (!list.some((x) => x.id === e.id)) list.push(e);
    mapped.set(r.seriesId, list);
  }

  // Series sharing a main line are one Show. A series with seasons belongs to its seasons' line; one
  // with only extras joins the line those extras sit on, if a series with seasons is there.
  const showUf = new UnionFind<string>();
  const seriesOfLine = new Map<string, string>();
  for (const s of series) {
    for (const e of (mapped.get(s.id) ?? []).filter(isSeason)) {
      const l = lineOf(e);
      const other = seriesOfLine.get(l);
      if (other === undefined) seriesOfLine.set(l, s.id);
      else showUf.union(s.id, other);
    }
  }
  for (const s of series) {
    const list = mapped.get(s.id) ?? [];
    if (list.some(isSeason)) continue;
    const host = list.map((e) => seriesOfLine.get(lineOf(e))).find((x) => x !== undefined);
    if (host !== undefined) showUf.union(s.id, host);
  }

  const members = new Map<string, SeriesIn[]>();
  for (const s of series) {
    const root = showUf.find(s.id);
    members.set(root, [...(members.get(root) ?? []), s]);
  }

  const kindOfEntry = new Map<string, 'season' | 'extra'>();
  const built: (GroupedShow & { franchiseOf: string | null; first: EntryInfo | null })[] = [];
  for (const group of members.values()) {
    const all = group.flatMap((s) => mapped.get(s.id) ?? []).filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);
    const seasons = all.filter(isSeason).sort(watchOrder);
    const extras = all.filter((e) => !isSeason(e)).sort(watchOrder);
    const first = seasons[0] ?? extras[0] ?? null;

    // Seasons in watch order; each extra after the last season it does not precede.
    const items: ShowItem[] = [];
    let pos = 0;
    const pending = [...extras];
    for (const season of seasons) {
      while (pending.length > 0 && pending[0] !== undefined && watchOrder(pending[0], season) < 0 && items.length > 0) {
        const extra = pending.shift();
        if (extra !== undefined) items.push({ entryId: extra.id, kind: 'extra', position: pos++, required: false });
      }
      items.push({ entryId: season.id, kind: 'season', position: pos++, required: true });
    }
    for (const extra of pending) items.push({ entryId: extra.id, kind: 'extra', position: pos++, required: seasons.length === 0 });
    for (const it of items) kindOfEntry.set(it.entryId, seasons.length === 0 ? 'season' : it.kind);

    // The Show is named for the Crunchyroll series holding its first season: Crunchyroll's English
    // title reads better than the catalog's romaji.
    const titled = first === null ? group[0] : (group.find((s) => (mapped.get(s.id) ?? []).some((e) => e.id === first.id)) ?? group[0]);
    const key = first === null ? `cr:${group[0]?.id ?? ''}` : `show:${first.id}`;
    built.push({ key, title: titled?.title ?? '', franchiseKey: '', seriesIds: group.map((s) => s.id).sort(), items, franchiseOf: first === null ? null : franchiseOf(first), first });
  }

  // A Franchise is named for its earliest Show.
  const byFranchise = new Map<string, typeof built>();
  for (const s of built) {
    const k = s.franchiseOf ?? s.key;
    byFranchise.set(k, [...(byFranchise.get(k) ?? []), s]);
  }
  const shows: GroupedShow[] = [];
  for (const group of byFranchise.values()) {
    const earliest = [...group].sort((a, b) => (a.first === null ? 1 : b.first === null ? -1 : watchOrder(a.first, b.first)) || a.key.localeCompare(b.key))[0];
    const franchiseKey = `fr:${earliest?.key ?? ''}`;
    for (const s of group) shows.push({ key: s.key, title: s.title, franchiseKey, seriesIds: s.seriesIds, items: s.items });
  }
  shows.sort((a, b) => a.key.localeCompare(b.key));

  const showOfSeries = new Map<string, string>();
  for (const s of shows) for (const id of s.seriesIds) showOfSeries.set(id, s.key);
  return { shows, showOfSeries, kindOfEntry };
}
