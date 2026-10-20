import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';
import { episodeList, type EpisodeIn } from '../derive/show.js';
import { rebuildShows } from '../derive/rebuild.js';

/**
 * A Show's detail (KURO-REQ-015) with its episode list in watch order, and the owner's pin. In
 * Phase 1 a Show is a Crunchyroll series: `cr:<series id>`.
 */
export function showRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', (_req, res, next) => {
    void (async () => {
      const [states, prefs] = await Promise.all([db.showState.findMany({ orderBy: { title: 'asc' } }), db.showPreference.findMany()]);
      const pinned = new Set(prefs.filter((p) => p.pinned).map((p) => p.showKey));
      res.json({ items: states.map((s) => ({ showKey: s.showKey, title: s.title, status: s.status, watchedEpisodes: s.watchedEpisodes, totalEpisodes: s.totalEpisodes, pinned: pinned.has(s.showKey), lastPlayedAt: s.lastPlayedAt?.toISOString() ?? null })) });
    })().catch(next);
  });

  router.get('/:key', (req, res, next) => {
    const key = req.params['key'];
    const seriesId = key.startsWith('cr:') ? key.slice(3) : null;
    if (seriesId === null) {
      res.status(404).json({ error: 'no such show' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const [state, pref, series, plays] = await Promise.all([
        db.showState.findUnique({ where: { showKey: key } }),
        db.showPreference.findUnique({ where: { showKey: key } }),
        db.crSeries.findUnique({ where: { id: seriesId }, include: { seasons: { include: { episodes: true } } } }),
        db.play.findMany({ where: { crParentId: seriesId, syncRun: { crConnection: { userId } } }, select: { crEpisodeId: true, datePlayed: true, playheadS: true, fullyWatched: true } }),
      ]);
      if (state === null || series === null) {
        res.status(404).json({ error: 'no such show' });
        return;
      }
      const episodes: EpisodeIn[] = series.seasons.flatMap((season) =>
        season.episodes.map((e) => ({ id: e.id, canonicalId: e.canonicalId ?? e.id, seasonNumber: season.seasonNumber, seasonSequence: season.seasonSequenceNumber ?? season.seasonNumber, sequenceNumber: e.sequenceNumber, episodeNumber: e.episodeNumber, title: e.title, durationS: e.durationS, audioLocale: e.audioLocale, airDate: e.airDate, creditsStartS: e.creditsStartS })),
      );
      res.json({
        showKey: key,
        title: state.title,
        description: series.description,
        status: state.status,
        pinned: pref?.pinned ?? false,
        watchedEpisodes: state.watchedEpisodes,
        totalEpisodes: state.totalEpisodes,
        remainingS: state.remainingS,
        next: state.nextCrEpisodeId === null ? null : { season: state.nextSeason, episode: state.nextEpisode, title: state.nextTitle, audioLocale: state.nextAudioLocale, watchUrl: `https://www.crunchyroll.com/watch/${state.nextCrEpisodeId}` },
        episodes: episodeList(episodes, plays).map((e) => ({ ...e, lastWatchedAt: e.lastWatchedAt?.toISOString() ?? null, watchUrl: `https://www.crunchyroll.com/watch/${e.crEpisodeId}` })),
      });
    })().catch(next);
  });

  /** Pin or unpin (an input to derivation, change-logged). */
  router.put('/:key/pin', (req, res, next) => {
    const body = z.object({ pinned: z.boolean() }).safeParse(req.body);
    const key = req.params['key'];
    if (!body.success || !key.startsWith('cr:')) {
      res.status(400).json({ error: 'pinned must be true or false' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const before = await db.showPreference.findUnique({ where: { showKey: key } });
      await db.showPreference.upsert({ where: { showKey: key }, create: { showKey: key, pinned: body.data.pinned }, update: { pinned: body.data.pinned } });
      await record(db, { userId, entity: 'show_preference', entityId: key, action: body.data.pinned ? 'pinned' : 'unpinned', before: { pinned: before?.pinned ?? false }, after: { pinned: body.data.pinned } });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
