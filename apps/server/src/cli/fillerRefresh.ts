import { AnimeFillerList } from '../adapters/fillerlist.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';
import { refreshFiller } from '../filler/refresh.js';
import { createLogger } from '../logger.js';

/** `kuro filler-refresh` — read the filler lists the owner's long Shows need now, then re-derive (KURO-T-5.3). */
export async function fillerRefresh(): Promise<number> {
  const config = loadConfig();
  if (config.DATABASE_URL === undefined) {
    console.error('DATABASE_URL is required');
    return 2;
  }
  const db = createDb(config.DATABASE_URL);
  try {
    const out = await refreshFiller(db, new AnimeFillerList(), createLogger(config.LOG_LEVEL));
    for (const { userId } of await db.crConnection.findMany({ select: { userId: true } })) await rebuildShows(db, userId);
    console.log(`${String(out.lists)} filler lists for your long shows, ${String(out.fetched)} fetched`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}
