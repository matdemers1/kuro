import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';
import { episodeList } from '../derive/show.js';
import { loadShows, rebuildShows } from '../derive/rebuild.js';

/**
 * A Show's detail (KURO-REQ-015): its Seasons and Extras, its episode list in watch order, the rest
 * of its Franchise, and the owner's pin. A matched Show is `show:<first season's entry>`; one still
 * on Crunchyroll's structure is `cr:<series id>`.
 */
export function showRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  /** Every Show, with the Franchise it belongs to (KURO-REQ-035): the Library groups by it. */
  router.get('/', (_req, res, next) => {
    void (async () => {
      const [states, prefs, shows] = await Promise.all([db.showState.findMany({ orderBy: { title: 'asc' } }), db.showPreference.findMany(), db.show.findMany({ select: { showKey: true, title: true, franchiseKey: true } })]);
      const pinned = new Set(prefs.filter((p) => p.pinned).map((p) => p.showKey));
      const byKey = new Map(shows.map((s) => [s.showKey, s]));
      // A Franchise is named for its earliest Show — the one in its key.
      const franchiseTitle = (key: string) => byKey.get(key.replace(/^fr:/, ''))?.title ?? null;
      res.json({
        items: states.map((s) => {
          const franchiseKey = byKey.get(s.showKey)?.franchiseKey ?? `fr:${s.showKey}`;
          return {
            showKey: s.showKey,
            title: s.title,
            status: s.status,
            watchedEpisodes: s.watchedEpisodes,
            totalEpisodes: s.totalEpisodes,
            pinned: pinned.has(s.showKey),
            lastPlayedAt: s.lastPlayedAt?.toISOString() ?? null,
            franchiseKey,
            franchiseTitle: franchiseTitle(franchiseKey) ?? s.title,
          };
        }),
      });
    })().catch(next);
  });

  /** The Show holding a catalog entry now — where to go after a merge or split re-keys one. */
  router.get('/by-entry/:entryId', (req, res, next) => {
    void (async () => {
      const item = await db.showItem.findFirst({ where: { catalogEntryId: req.params['entryId'] }, select: { showKey: true } });
      if (item === null) res.status(404).json({ error: 'no show holds that entry' });
      else res.json({ showKey: item.showKey });
    })().catch(next);
  });

  router.get('/:key', (req, res, next) => {
    const key = req.params['key'];
    if (!key.startsWith('cr:') && !key.startsWith('show:')) {
      res.status(404).json({ error: 'no such show' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const [state, pref, [inputs]] = await Promise.all([db.showState.findUnique({ where: { showKey: key } }), db.showPreference.findUnique({ where: { showKey: key } }), loadShows(db, userId, key)]);
      if (state === null || inputs === undefined) {
        res.status(404).json({ error: 'no such show' });
        return;
      }
      // Seasons and Extras, in watch order, with the catalog's names for them (KURO-REQ-031).
      const entries = new Map((await db.catalogEntry.findMany({ where: { id: { in: inputs.show.items.map((i) => i.entryId) } }, select: { id: true, title: true, type: true, episodes: true, seasonYear: true, picture: true } })).map((e) => [e.id, e]));
      const watchedExtras = new Set(episodeList(inputs.extras, inputs.plays).filter((e) => e.watched).map((e) => e.crEpisodeId));
      const franchise = await db.show.findMany({ where: { franchiseKey: (await db.show.findUnique({ where: { showKey: key } }))?.franchiseKey ?? '' }, select: { showKey: true, title: true } });
      res.json({
        showKey: key,
        title: state.title,
        description: inputs.description,
        status: state.status,
        manualStatus: pref?.status ?? null,
        pinned: pref?.pinned ?? false,
        watchedEpisodes: state.watchedEpisodes,
        totalEpisodes: state.totalEpisodes,
        remainingS: state.remainingS,
        dubLag: state.dubLag,
        next: state.nextCrEpisodeId === null ? null : { season: state.nextSeason, episode: state.nextEpisode, title: state.nextTitle, audioLocale: state.nextAudioLocale, watchUrl: `https://www.crunchyroll.com/watch/${state.nextCrEpisodeId}` },
        items: inputs.show.items.flatMap((i) => {
          const e = entries.get(i.entryId);
          return e === undefined ? [] : [{ entryId: i.entryId, kind: i.kind, required: i.required, title: e.title, type: e.type, episodes: e.episodes, year: e.seasonYear, hasPicture: e.picture !== null }];
        }),
        seriesIds: inputs.show.seriesIds,
        franchise: franchise.filter((f) => f.showKey !== key).map((f) => ({ showKey: f.showKey, title: f.title })),
        episodes: episodeList(inputs.main, inputs.plays).map((e) => ({ ...e, lastWatchedAt: e.lastWatchedAt?.toISOString() ?? null, watchUrl: `https://www.crunchyroll.com/watch/${e.crEpisodeId}` })),
        extras: episodeList(inputs.extras, inputs.plays).map((e) => ({ ...e, spoiler: false, isNext: false, watched: watchedExtras.has(e.crEpisodeId), lastWatchedAt: e.lastWatchedAt?.toISOString() ?? null, watchUrl: `https://www.crunchyroll.com/watch/${e.crEpisodeId}` })),
      });
    })().catch(next);
  });

  /** Pin or unpin (an input to derivation, change-logged). */
  router.put('/:key/pin', (req, res, next) => {
    const body = z.object({ pinned: z.boolean() }).safeParse(req.body);
    const key = req.params['key'];
    if (!body.success || !(key.startsWith('cr:') || key.startsWith('show:'))) {
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

  /** The owner's own status — Plan to watch, Dropped, or neither (derived) — change-logged (KURO-REQ-033). */
  router.put('/:key/status', (req, res, next) => {
    const body = z.object({ status: z.enum(['plan_to_watch', 'dropped']).nullable() }).safeParse(req.body);
    const key = req.params['key'];
    if (!body.success || !(key.startsWith('cr:') || key.startsWith('show:'))) {
      res.status(400).json({ error: 'status must be plan_to_watch, dropped or null' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const before = await db.showPreference.findUnique({ where: { showKey: key } });
      const status = body.data.status;
      const data = { status, statusAt: status === null ? null : new Date() };
      await db.showPreference.upsert({ where: { showKey: key }, create: { showKey: key, ...data }, update: data });
      await record(db, { userId, entity: 'show_status', entityId: key, action: status ?? 'cleared', before: { status: before?.status ?? null, statusAt: before?.statusAt?.toISOString() ?? null }, after: { status, statusAt: data.statusAt?.toISOString() ?? null } });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
