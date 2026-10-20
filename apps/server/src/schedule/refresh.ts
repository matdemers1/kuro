import { isoWeek, type ScheduleClient } from '../adapters/animeschedule.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

/**
 * The daily schedule refresh (KURO-T-3.1): this week's dub and sub timetables from AnimeSchedule,
 * replaced whole, and each new route asked once what it is in the catalog's terms (its AniList and
 * MAL ids) — paced, and capped per run so a first run cannot hammer the API.
 */

export const SCHEDULE_CRON = '0 6 * * *';
const LINKS_PER_RUN = 60;
const LINK_PAUSE_MS = 1500;

export const weekKey = (d: Date) => {
  const w = isoWeek(d);
  return `${String(w.year)}-W${String(w.week).padStart(2, '0')}`;
};

export async function refreshSchedule(db: Db, client: ScheduleClient, tz: string, log: Logger, now = new Date(), pauseMs = LINK_PAUSE_MS): Promise<{ dub: number; sub: number; linked: number }> {
  const week = weekKey(now);
  const counts = { dub: 0, sub: 0 };
  for (const airType of ['dub', 'sub'] as const) {
    const entries = await client.timetable(airType, isoWeek(now), tz);
    const rows = new Map(
      entries.map((e) => [
        `${e.route}|${String(e.episodeNumber ?? 0)}`,
        { week, route: e.route, airType, episodeNumber: e.episodeNumber ?? 0, episodeDate: e.episodeDate, title: e.title, english: e.english, episodes: e.episodes, status: e.status, delayedUntil: e.delayedUntil, fetchedAt: now },
      ]),
    );
    await db.$transaction([db.scheduleEntry.deleteMany({ where: { week, airType } }), db.scheduleEntry.createMany({ data: [...rows.values()] })]);
    counts[airType] = rows.size;
  }

  const known = new Set((await db.scheduleAnime.findMany({ select: { route: true } })).map((r) => r.route));
  const routes = [...new Set((await db.scheduleEntry.findMany({ where: { week }, select: { route: true } })).map((r) => r.route))].filter((r) => !known.has(r)).slice(0, LINKS_PER_RUN);
  let linked = 0;
  for (const route of routes) {
    try {
      const ids = await client.links(route);
      await db.scheduleAnime.create({ data: { route, anilistId: ids.anilistId, malId: ids.malId, fetchedAt: now } });
      linked++;
    } catch (err) {
      log.warn({ route, err: err instanceof Error ? err.message : String(err) }, 'AnimeSchedule route lookup failed; it is retried tomorrow');
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  log.info({ week, ...counts, linked }, 'schedule refreshed');
  return { ...counts, linked };
}
