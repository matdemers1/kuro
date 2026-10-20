import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';

/**
 * A Franchise (KURO-T-2.8): its Shows in watch order — by their first Season — with each one's
 * status and progress, and how many Seasons and Extras it holds.
 */
export function franchiseRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/:key', (req, res, next) => {
    const key = req.params['key'];
    void (async () => {
      const shows = await db.show.findMany({ where: { franchiseKey: key }, include: { items: { orderBy: { position: 'asc' } } } });
      if (shows.length === 0) {
        res.status(404).json({ error: 'no such franchise' });
        return;
      }
      const states = new Map((await db.showState.findMany({ where: { showKey: { in: shows.map((s) => s.showKey) } } })).map((s) => [s.showKey, s]));
      const firstIds = shows.flatMap((s) => s.items[0]?.catalogEntryId ?? []);
      const firsts = new Map((await db.catalogEntry.findMany({ where: { id: { in: firstIds } }, select: { id: true, seasonYear: true, season: true } })).map((e) => [e.id, e]));
      const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
      const when = (s: (typeof shows)[number]) => {
        const e = firsts.get(s.items[0]?.catalogEntryId ?? '');
        return (e?.seasonYear ?? 9999) * 10 + (e?.season === null || e?.season === undefined ? 9 : SEASONS.indexOf(e.season));
      };
      const ordered = [...shows].sort((a, b) => when(a) - when(b) || a.title.localeCompare(b.title));
      const earliest = shows.find((s) => `fr:${s.showKey}` === key) ?? ordered[0];
      res.json({
        key,
        title: earliest?.title ?? '',
        shows: ordered.map((s) => {
          const st = states.get(s.showKey);
          return {
            showKey: s.showKey,
            title: s.title,
            year: firsts.get(s.items[0]?.catalogEntryId ?? '')?.seasonYear ?? null,
            seasons: s.items.filter((i) => i.kind === 'season').length,
            extras: s.items.filter((i) => i.kind === 'extra').length,
            status: st?.status ?? null,
            watchedEpisodes: st?.watchedEpisodes ?? 0,
            totalEpisodes: st?.totalEpisodes ?? 0,
          };
        }),
      });
    })().catch(next);
  });
  return router;
}
