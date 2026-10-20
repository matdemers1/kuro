import { Router } from 'express';
import { isoWeek } from '../adapters/animeschedule.js';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { weekKey } from '../schedule/refresh.js';

/**
 * This Season (KURO-T-3.2): what lands this week, dubs first. From AnimeSchedule's timetables when
 * they are configured — every show airing, the owner's own on top — and otherwise from what the
 * owner's Crunchyroll shows released this week. Plus the coverage report (KURO-R-012): Watching
 * shows still airing that the timetable does not list.
 */

const ORIGINAL = new Set(['ja-JP', 'zh-CN', 'ko-KR']);
const ACTIVE = new Set(['watching', 'caught_up', 'rewatching']);

export interface SeasonItem {
  title: string;
  episodeNumber: number | null;
  episodes: number | null;
  episodeDate: string | null;
  delayedUntil: string | null;
  showKey: string | null;
  status: string | null;
}

/** Monday 00:00 UTC to the next Monday, the ISO week AnimeSchedule numbers its timetables by. */
function weekBounds(now: Date): { start: Date; end: Date } {
  const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)));
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

/** The owner's shows first — the ones they are watching on top — then by when the episode lands. */
const byInterest = (a: SeasonItem, b: SeasonItem) =>
  Number(b.status !== null && ACTIVE.has(b.status)) - Number(a.status !== null && ACTIVE.has(a.status)) ||
  Number(b.showKey !== null) - Number(a.showKey !== null) ||
  (a.episodeDate ?? '9').localeCompare(b.episodeDate ?? '9') ||
  a.title.localeCompare(b.title);

export function thisSeasonRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/', (_req, res, next) => {
    void (async () => {
      const now = new Date();
      const week = weekKey(now);
      const { start, end } = weekBounds(now);
      const states = new Map((await db.showState.findMany({ select: { showKey: true, status: true, title: true } })).map((s) => [s.showKey, s]));
      const entries = await db.scheduleEntry.findMany({ where: { week } });

      if (entries.length > 0) {
        // Timetable route → catalog entry → the owner's Show holding it.
        const routes = new Map((await db.scheduleAnime.findMany({ where: { route: { in: [...new Set(entries.map((e) => e.route))] } } })).map((r) => [r.route, r]));
        const catalog = await db.catalogEntry.findMany({ where: { anilistId: { in: [...routes.values()].flatMap((r) => (r.anilistId === null ? [] : [r.anilistId])) } }, select: { id: true, anilistId: true } });
        const entryOfAnilist = new Map(catalog.flatMap((c) => (c.anilistId === null ? [] : [[c.anilistId, c.id] as const])));
        const items = await db.showItem.findMany({ where: { catalogEntryId: { in: catalog.map((c) => c.id) } }, select: { catalogEntryId: true, showKey: true } });
        const showOfEntry = new Map(items.map((i) => [i.catalogEntryId, i.showKey]));
        const showOfRoute = (route: string) => {
          const al = routes.get(route)?.anilistId;
          const entry = al === null || al === undefined ? undefined : entryOfAnilist.get(al);
          return entry === undefined ? null : (showOfEntry.get(entry) ?? null);
        };
        const item = (e: (typeof entries)[number]): SeasonItem => {
          const showKey = showOfRoute(e.route);
          return { title: e.english ?? e.title, episodeNumber: e.episodeNumber === 0 ? null : e.episodeNumber, episodes: e.episodes, episodeDate: e.episodeDate?.toISOString() ?? null, delayedUntil: e.delayedUntil?.toISOString() ?? null, showKey, status: showKey === null ? null : (states.get(showKey)?.status ?? null) };
        };
        const dubRoutes = new Set(entries.filter((e) => e.airType === 'dub').map((e) => e.route));
        const dubs = entries.filter((e) => e.airType === 'dub').map(item).sort(byInterest);
        const subs = entries.filter((e) => e.airType === 'sub' && !dubRoutes.has(e.route)).map(item).sort(byInterest);

        // Coverage (KURO-R-012): the owner's airing Watching shows that no timetable row reaches.
        const listed = new Set(entries.flatMap((e) => showOfRoute(e.route) ?? []));
        const airing = await db.showItem.findMany({ where: { kind: 'season', showKey: { in: [...states.values()].filter((s) => ACTIVE.has(s.status)).map((s) => s.showKey) } }, select: { showKey: true, catalogEntryId: true } });
        const ongoing = new Set((await db.catalogEntry.findMany({ where: { id: { in: airing.map((a) => a.catalogEntryId) }, status: 'ONGOING' }, select: { id: true } })).map((e) => e.id));
        const missing = [...new Set(airing.filter((a) => ongoing.has(a.catalogEntryId) && !listed.has(a.showKey)).map((a) => a.showKey))].map((k) => ({ showKey: k, title: states.get(k)?.title ?? k }));

        res.json({ source: 'animeschedule', week: { label: week, start: start.toISOString(), end: end.toISOString() }, dubs, subs, missing, credit: { name: 'AnimeSchedule.net', url: 'https://animeschedule.net' } });
        return;
      }

      // No timetable: what the owner's own Crunchyroll shows released this week.
      const shows = await db.show.findMany({ select: { showKey: true, seriesIds: true } });
      const showOfSeries = new Map(shows.flatMap((s) => s.seriesIds.map((id) => [id, s.showKey] as const)));
      const released = await db.crEpisode.findMany({
        where: { airDate: { gte: start, lt: end }, season: { seriesId: { in: [...showOfSeries.keys()] } } },
        select: { episodeNumber: true, airDate: true, audioLocale: true, season: { select: { seriesId: true } } },
      });
      const toItem = (e: (typeof released)[number]): SeasonItem => {
        const showKey = showOfSeries.get(e.season.seriesId) ?? null;
        return { title: (showKey === null ? undefined : states.get(showKey)?.title) ?? '', episodeNumber: e.episodeNumber, episodes: null, episodeDate: e.airDate?.toISOString() ?? null, delayedUntil: null, showKey, status: showKey === null ? null : (states.get(showKey)?.status ?? null) };
      };
      const dubs = released.filter((e) => e.audioLocale !== null && !ORIGINAL.has(e.audioLocale)).map(toItem).sort(byInterest);
      const dubbed = new Set(dubs.map((d) => d.showKey));
      const subs = released.filter((e) => e.audioLocale === null || ORIGINAL.has(e.audioLocale)).map(toItem).filter((s) => !dubbed.has(s.showKey)).sort(byInterest);
      res.json({ source: 'crunchyroll', week: { label: `${String(isoWeek(now).year)}-W${String(isoWeek(now).week).padStart(2, '0')}`, start: start.toISOString(), end: end.toISOString() }, dubs, subs, missing: [], credit: null });
    })().catch(next);
  });
  return router;
}
