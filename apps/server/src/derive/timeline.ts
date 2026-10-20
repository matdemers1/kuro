/**
 * A Franchise's watch-order timeline (KURO-T-5.4): every Season and Extra of every Show in it, plus
 * the related catalog entries the owner has none of — the movie not on Crunchyroll, the sequel
 * announced. Each Show keeps its own order (the owner's, after any reorder); Shows interleave by when
 * each part came out, so a spin-off sits between the Seasons it aired between; the rest slot in by
 * date. Pure.
 */

export interface TimelineEntry {
  id: string;
  title: string;
  type: string;
  episodes: number;
  year: number | null;
  /** 0–3 for WINTER–FALL; 9 when unknown. */
  seasonIndex: number;
  status: string;
}

export interface TimelineShow {
  showKey: string;
  title: string;
  items: readonly { entryId: string; kind: 'season' | 'extra'; required: boolean }[];
}

export interface TimelineRow {
  entryId: string;
  title: string;
  type: string;
  episodes: number;
  year: number | null;
  status: string;
  /** season / extra of an owned Show, or related — in the catalog, not in the library. */
  kind: 'season' | 'extra' | 'related';
  /** "Season 2" within its Show, for seasons. */
  label: string | null;
  showKey: string | null;
  showTitle: string | null;
  required: boolean;
  relation: string | null;
}

const when = (e: TimelineEntry | undefined) => (e?.year ?? 9999) * 10 + (e?.seasonIndex ?? 9);

export function timeline(shows: readonly TimelineShow[], entries: ReadonlyMap<string, TimelineEntry>, related: readonly { entryId: string; relation: string }[]): TimelineRow[] {
  // One queue per Show in its own order, and one per related entry.
  const queues: TimelineRow[][] = shows.map((s) => {
    let n = 0;
    return s.items.flatMap((i) => {
      const e = entries.get(i.entryId);
      if (e === undefined) return [];
      if (i.kind === 'season') n += 1;
      return [{ entryId: e.id, title: e.title, type: e.type, episodes: e.episodes, year: e.year, status: e.status, kind: i.kind, label: i.kind === 'season' ? `Season ${String(n)}` : null, showKey: s.showKey, showTitle: s.title, required: i.required, relation: null }];
    });
  });
  const owned = new Set(queues.flat().map((r) => r.entryId));
  for (const r of related) {
    const e = entries.get(r.entryId);
    if (e === undefined || owned.has(e.id)) continue;
    owned.add(e.id);
    queues.push([{ entryId: e.id, title: e.title, type: e.type, episodes: e.episodes, year: e.year, status: e.status, kind: 'related', label: null, showKey: null, showTitle: null, required: false, relation: r.relation }]);
  }
  // Merge: always take the earliest head; ties go to the Show listed first, owned before related.
  const out: TimelineRow[] = [];
  const heads = queues.map(() => 0);
  for (;;) {
    let best = -1;
    for (let q = 0; q < queues.length; q += 1) {
      const row = queues[q]?.[heads[q] ?? 0];
      if (row === undefined) continue;
      const bestRow = best < 0 ? undefined : queues[best]?.[heads[best] ?? 0];
      if (bestRow === undefined || when(entries.get(row.entryId)) < when(entries.get(bestRow.entryId))) best = q;
    }
    if (best < 0) return out;
    const row = queues[best]?.[heads[best] ?? 0];
    if (row !== undefined) out.push(row);
    heads[best] = (heads[best] ?? 0) + 1;
  }
}
