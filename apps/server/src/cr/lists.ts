import { z } from 'zod';
import type { CrSidecar } from '../adapters/crunchyroll.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import * as connection from './connection.js';

/**
 * The watchlist and Crunchylists, imported as series to watch (KURO-T-3.5). Each sync replaces the
 * snapshot whole: a series taken off the watchlist on Crunchyroll leaves Kurō's plan too. Only
 * series are taken — an episode on a list stands for its series; movie listings are not Shows yet.
 */

const Panel = z.object({
  id: z.string(),
  type: z.string(),
  episode_metadata: z.object({ series_id: z.string() }).partial().nullish(),
});

/** The series a list entry stands for. */
export function seriesOf(entry: Record<string, unknown>): string | null {
  const p = Panel.safeParse(entry['panel']);
  if (!p.success) return null;
  if (p.data.type === 'series') return p.data.id;
  if (p.data.type === 'episode') return p.data.episode_metadata?.series_id ?? null;
  return null;
}

export async function importLists(deps: { db: Db; sidecar: CrSidecar; secretKey: string; log: Logger }, userId: string, now = new Date()): Promise<number> {
  const s = await connection.session(deps.db, deps.secretKey, userId);
  const lists = await deps.sidecar.lists({ refreshToken: s.refreshToken, deviceId: s.deviceId, accountId: s.accountId });
  await connection.rotate(deps.db, deps.secretKey, s.id, lists.refreshToken);

  const rows = new Map<string, { crSeriesId: string; source: string; listTitle: string | null; syncedAt: Date }>();
  for (const entry of lists.watchlist) {
    const id = seriesOf(entry);
    if (id !== null) rows.set(`${id}|watchlist`, { crSeriesId: id, source: 'watchlist', listTitle: null, syncedAt: now });
  }
  for (const list of lists.crunchylists) {
    for (const entry of list.items) {
      const id = seriesOf(entry);
      if (id !== null) rows.set(`${id}|crunchylist:${list.id}`, { crSeriesId: id, source: `crunchylist:${list.id}`, listTitle: list.title, syncedAt: now });
    }
  }
  await deps.db.$transaction([deps.db.planEntry.deleteMany({}), deps.db.planEntry.createMany({ data: [...rows.values()] })]);
  deps.log.info({ entries: rows.size, lists: lists.crunchylists.length }, 'watchlist and Crunchylists imported');
  return rows.size;
}
