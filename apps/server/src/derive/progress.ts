import type { Db } from '../db.js';
import { loadShows, type ShowInputs } from './rebuild.js';
import { isWatched } from './show.js';

/**
 * Where the owner stands on each catalog entry of a Show — the franchise timeline (KURO-T-5.4) and the
 * MAL export (KURO-T-6.1) count per Season, not per Show. Versions of one episode count once.
 */
export interface EntryProgress {
  watched: number;
  total: number;
  firstWatchedAt: Date | null;
  lastWatchedAt: Date | null;
}

export function entryProgress(inputs: ShowInputs): Map<string, EntryProgress> {
  const out = new Map<string, EntryProgress>();
  const entryAt = new Map(inputs.show.items.map((i) => [i.position, i.entryId]));
  const watchedAt = new Map<string, { first: Date; last: Date }>();
  const byId = new Map([...inputs.main, ...inputs.extras].map((e) => [e.id, e]));
  for (const p of inputs.plays) {
    const e = byId.get(p.crEpisodeId);
    if (e === undefined || !isWatched(p, e)) continue;
    const w = watchedAt.get(e.canonicalId);
    watchedAt.set(e.canonicalId, { first: w === undefined || p.datePlayed < w.first ? p.datePlayed : w.first, last: w === undefined || p.datePlayed > w.last ? p.datePlayed : w.last });
  }
  const seen = new Set<string>();
  for (const e of [...inputs.main, ...inputs.extras]) {
    const entryId = e.rank === undefined ? undefined : entryAt.get(e.rank[0]);
    if (entryId === undefined || seen.has(e.canonicalId)) continue;
    seen.add(e.canonicalId);
    const p = out.get(entryId) ?? { watched: 0, total: 0, firstWatchedAt: null, lastWatchedAt: null };
    const w = watchedAt.get(e.canonicalId);
    out.set(entryId, {
      watched: p.watched + (w === undefined ? 0 : 1),
      total: p.total + 1,
      firstWatchedAt: w === undefined ? p.firstWatchedAt : p.firstWatchedAt === null || w.first < p.firstWatchedAt ? w.first : p.firstWatchedAt,
      lastWatchedAt: w === undefined ? p.lastWatchedAt : p.lastWatchedAt === null || w.last > p.lastWatchedAt ? w.last : p.lastWatchedAt,
    });
  }
  return out;
}

/** One Show's per-entry progress, loading its inputs. */
export async function progressOf(db: Db, userId: string, showKey: string): Promise<Map<string, EntryProgress>> {
  const [inputs] = await loadShows(db, userId, showKey);
  return inputs === undefined ? new Map() : entryProgress(inputs);
}
