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
      const rows = episodeList(inputs.main, inputs.plays, undefined, pref?.skipFiller ?? false);
      const watchedExtras = new Set(episodeList(inputs.extras, inputs.plays).filter((e) => e.watched).map((e) => e.crEpisodeId));
      const franchise = await db.show.findMany({ where: { franchiseKey: (await db.show.findUnique({ where: { showKey: key } }))?.franchiseKey ?? '' }, select: { showKey: true, title: true } });
      res.json({
        showKey: key,
        title: state.title,
        description: inputs.description,
        status: state.status,
        manualStatus: pref?.status ?? null,
        dropReason: pref?.dropReason ?? null,
        rating: (await db.rating.findUnique({ where: { target: `show:${key}` } }))?.score ?? null,
        seasonRatings: Object.fromEntries((await db.rating.findMany({ where: { target: { in: inputs.show.items.map((i) => `season:${i.entryId}`) } } })).map((r) => [r.target.slice('season:'.length), r.score])),
        note: (await db.showNote.findUnique({ where: { showKey: key } }))?.text ?? null,
        rewatches: (await db.rewatch.findMany({ where: { showKey: key }, orderBy: { startedAt: 'asc' } })).map((r) => ({ startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null })),
        inRewatchQueue: (await db.rewatchQueueItem.findUnique({ where: { showKey: key } })) !== null,
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
        skipFiller: pref?.skipFiller ?? false,
        // The filler guide (KURO-T-5.3), credited when one covers the Show.
        filler: inputs.fillerSlugs.length === 0 ? null : { count: rows.filter((e) => e.filler === 'filler').length, mixed: rows.filter((e) => e.filler === 'mixed').length, source: { name: 'Anime Filler List', url: `https://www.animefillerlist.com/shows/${inputs.fillerSlugs[0] ?? ''}` } },
        episodes: rows.map((e) => ({ ...e, lastWatchedAt: e.lastWatchedAt?.toISOString() ?? null, watchUrl: `https://www.crunchyroll.com/watch/${e.crEpisodeId}` })),
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

  /** A 1–10 rating of the Show, or of one of its Seasons (KURO-REQ-041); null clears it. */
  const Score = z.object({ score: z.number().int().min(1).max(10).nullable() });
  const rate = (target: (req: import('express').Request) => string) => (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    const body = Score.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'score must be a whole number from 1 to 10, or null' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    const key = target(req);
    void (async () => {
      const before = await db.rating.findUnique({ where: { target: key } });
      if (body.data.score === null) await db.rating.deleteMany({ where: { target: key } });
      else await db.rating.upsert({ where: { target: key }, create: { target: key, score: body.data.score }, update: { score: body.data.score } });
      await record(db, { userId, entity: 'rating', entityId: key, action: body.data.score === null ? 'cleared' : 'rated', before: { score: before?.score ?? null }, after: { score: body.data.score } });
      res.status(204).end();
    })().catch(next);
  };
  const param = (req: import('express').Request, name: string) => {
    const v: unknown = req.params[name];
    return typeof v === 'string' ? v : '';
  };
  router.put('/:key/rating', rate((req) => `show:${param(req, 'key')}`));
  router.put('/:key/seasons/:entryId/rating', rate((req) => `season:${param(req, 'entryId')}`));

  /** Skip filler (KURO-T-5.3): Up Next goes past the guide's filler episodes. Change-logged. */
  router.put('/:key/skip-filler', (req, res, next) => {
    const body = z.object({ skip: z.boolean() }).safeParse(req.body);
    const key = req.params['key'];
    if (!body.success || !(key.startsWith('cr:') || key.startsWith('show:'))) {
      res.status(400).json({ error: 'skip must be true or false' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const before = (await db.showPreference.findUnique({ where: { showKey: key } }))?.skipFiller ?? false;
      await db.showPreference.upsert({ where: { showKey: key }, create: { showKey: key, skipFiller: body.data.skip }, update: { skipFiller: body.data.skip } });
      await record(db, { userId, entity: 'skip_filler', entityId: key, action: body.data.skip ? 'skip' : 'include', before: { skip: before }, after: { skip: body.data.skip } });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  /** A free-text note on the Show (KURO-REQ-044); an empty one removes it. Change-logged. */
  router.put('/:key/note', (req, res, next) => {
    const body = z.object({ text: z.string().max(10_000) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'text is required (up to 10,000 characters)' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    const key = req.params['key'];
    void (async () => {
      const before = await db.showNote.findUnique({ where: { showKey: key } });
      const text = body.data.text.trim();
      if (text === (before?.text ?? '')) {
        res.status(204).end();
        return;
      }
      if (text === '') await db.showNote.deleteMany({ where: { showKey: key } });
      else await db.showNote.upsert({ where: { showKey: key }, create: { showKey: key, text }, update: { text } });
      await record(db, { userId, entity: 'show_note', entityId: key, action: text === '' ? 'removed' : 'noted', before: { text: before?.text ?? null }, after: { text: text === '' ? null : text } });
      res.status(204).end();
    })().catch(next);
  });

  /** The owner's own status — Plan to watch, Dropped, or neither (derived) — change-logged (KURO-REQ-033). */
  router.put('/:key/status', (req, res, next) => {
    const body = z.object({ status: z.enum(['plan_to_watch', 'dropped']).nullable(), reason: z.enum(['pacing', 'not_for_me', 'got_busy']).optional() }).safeParse(req.body);
    const key = req.params['key'];
    if (!body.success || !(key.startsWith('cr:') || key.startsWith('show:'))) {
      res.status(400).json({ error: 'status must be plan_to_watch, dropped or null' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const before = await db.showPreference.findUnique({ where: { showKey: key } });
      const status = body.data.status;
      // Why it was dropped (KURO-REQ-043); cleared with the status.
      const data = { status, statusAt: status === null ? null : new Date(), dropReason: status === 'dropped' ? (body.data.reason ?? null) : null };
      await db.showPreference.upsert({ where: { showKey: key }, create: { showKey: key, ...data }, update: data });
      await record(db, { userId, entity: 'show_status', entityId: key, action: status ?? 'cleared', before: { status: before?.status ?? null, statusAt: before?.statusAt?.toISOString() ?? null, dropReason: before?.dropReason ?? null }, after: { status, statusAt: data.statusAt?.toISOString() ?? null, dropReason: data.dropReason } });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
