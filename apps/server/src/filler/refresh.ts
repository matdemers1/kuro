import type { FillerClient } from '../adapters/fillerlist.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { linkSeasons, type SeasonIn } from './link.js';

/**
 * The weekly filler refresh (KURO-T-5.3): read the site's index, find the lists that name a Season of
 * one of the owner's long Shows, and fetch each one not read in the last week. Only long Shows: a
 * twelve-episode season has no filler to speak of.
 */

export const LONG_SHOW = 40;
export const FILLER_CRON = '0 5 * * 3';
/** A list for a Show still airing is read again weekly; one for a finished Show, every ninety days. */
const AIRING_FRESH_MS = 7 * 86_400_000;
const FINISHED_FRESH_MS = 90 * 86_400_000;

/** Each long Show's Seasons in order, as the linker wants them, with whether any is still airing. */
export async function longShowSeasons(db: Db): Promise<Map<string, (SeasonIn & { airing: boolean })[]>> {
  const long = await db.showState.findMany({ where: { totalEpisodes: { gte: LONG_SHOW } }, select: { showKey: true } });
  const items = await db.showItem.findMany({ where: { showKey: { in: long.map((s) => s.showKey) }, kind: 'season' }, orderBy: [{ showKey: 'asc' }, { position: 'asc' }] });
  const entries = new Map((await db.catalogEntry.findMany({ where: { id: { in: items.map((i) => i.catalogEntryId) } }, select: { id: true, title: true, synonyms: true, episodes: true, status: true } })).map((e) => [e.id, e]));
  const out = new Map<string, (SeasonIn & { airing: boolean })[]>();
  for (const i of items) {
    const e = entries.get(i.catalogEntryId);
    if (e !== undefined) out.set(i.showKey, [...(out.get(i.showKey) ?? []), { entryId: e.id, title: e.title, synonyms: e.synonyms, episodes: e.episodes, airing: e.status === 'ONGOING' }]);
  }
  return out;
}

export async function refreshFiller(db: Db, client: FillerClient, log: Logger, now = new Date()): Promise<{ lists: number; fetched: number }> {
  const shows = await longShowSeasons(db);
  if (shows.size === 0) return { lists: 0, fetched: 0 };
  // Counts are not known until a list is read; for finding which lists matter, any length will do.
  const index = (await client.index()).map((s) => ({ ...s, count: Number.POSITIVE_INFINITY }));
  const wanted = new Map<string, { title: string; airing: boolean }>();
  for (const seasons of shows.values()) {
    const airing = seasons.some((s) => s.airing);
    for (const { slug } of linkSeasons(seasons, index).values()) {
      wanted.set(slug, { title: index.find((s) => s.slug === slug)?.title ?? slug, airing: airing || (wanted.get(slug)?.airing ?? false) });
    }
  }

  const fetchedAt = new Map((await db.fillerList.findMany({ select: { slug: true, fetchedAt: true } })).map((l) => [l.slug, l.fetchedAt.getTime()]));
  let fetched = 0;
  for (const [slug, { title, airing }] of wanted) {
    const at = fetchedAt.get(slug);
    if (at !== undefined && now.getTime() - at < (airing ? AIRING_FRESH_MS : FINISHED_FRESH_MS)) continue;
    const episodes = await client.episodes(slug);
    if (episodes.length === 0) {
      log.warn({ slug }, 'filler list had no episodes; the page may have changed');
      continue;
    }
    await db.$transaction([
      db.fillerList.upsert({ where: { slug }, create: { slug, title, fetchedAt: now }, update: { title, fetchedAt: now } }),
      db.fillerEpisode.deleteMany({ where: { slug } }),
      db.fillerEpisode.createMany({ data: episodes.map((e) => ({ slug, ...e })) }),
    ]);
    fetched += 1;
  }
  log.info({ lists: wanted.size, fetched }, 'filler lists refreshed');
  return { lists: wanted.size, fetched };
}
