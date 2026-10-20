import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { upNext } from '../derive/show.js';

/** Up Next (KURO-REQ-013): derived state, ordered, with the owner's pins. Read-only. */
export function upNextRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/', (_req, res, next) => {
    void (async () => {
      const [states, prefs] = await Promise.all([db.showState.findMany(), db.showPreference.findMany({ where: { pinned: true } })]);
      const pinned = new Set(prefs.map((p) => p.showKey));
      const byKey = new Map(states.map((s) => [s.showKey, s]));
      const order = upNext(states.map((s) => ({ ...s, pinned: pinned.has(s.showKey) })));
      res.json({
        items: order.flatMap(({ showKey, group }) => {
          const s = byKey.get(showKey);
          if (s === undefined) return [];
          return [{
            showKey,
            group,
            title: s.title,
            status: s.status,
            watchedEpisodes: s.watchedEpisodes,
            totalEpisodes: s.totalEpisodes,
            remainingS: s.remainingS,
            currentSeason: s.currentSeason,
            currentEpisode: s.currentEpisode,
            nextSeason: s.nextSeason,
            nextEpisode: s.nextEpisode,
            nextTitle: s.nextTitle,
            nextAudioLocale: s.nextAudioLocale,
            watchUrl: s.nextCrEpisodeId === null ? null : `https://www.crunchyroll.com/watch/${s.nextCrEpisodeId}`,
            lastPlayedAt: s.lastPlayedAt?.toISOString() ?? null,
          }];
        }),
      });
    })().catch(next);
  });
  return router;
}
