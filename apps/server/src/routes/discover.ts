import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';
import { discover, loadTaste } from '../recommend/load.js';
import { labelOf, MIN_SIGNALS } from '../recommend/model.js';

/**
 * Discover and the taste profile (KURO-REQ-045–048, KURO-T-4.4/4.5). Discover lists catalog Shows the
 * owner has not seen, each with its because; Not interested hides one and weighs its likes down.
 * The taste profile is the learned weight of each tag and studio, which the owner can boost, lower
 * or mute. Every change is change-logged and undoable.
 */

/** Shows to rate when the profile is cold: the most-watched ones not yet rated, or finished. */
async function toRate(db: Db) {
  const rated = new Set((await db.rating.findMany({ where: { target: { startsWith: 'show:' } }, select: { target: true } })).map((r) => r.target.slice('show:'.length)));
  const shows = await db.showState.findMany({ where: { watchedEpisodes: { gt: 0 } }, orderBy: [{ watchedEpisodes: 'desc' }, { title: 'asc' }], take: 30, select: { showKey: true, title: true, status: true, watchedEpisodes: true } });
  return shows.filter((s) => !rated.has(s.showKey)).slice(0, 8);
}

const Interest = z.object({ interested: z.boolean() });
const Adjust = z.object({ adjust: z.enum(['boost', 'lower', 'mute']).nullable() });
const TERM = /^(tag|studio):.{1,200}$/;

export function discoverRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', (_req, res, next) => {
    void (async () => {
      const taste = await loadTaste(db);
      if (taste.confident < MIN_SIGNALS) {
        res.json({ state: 'cold', needed: MIN_SIGNALS - taste.confident, items: [], toRate: await toRate(db) });
        return;
      }
      res.json({ state: 'ready', items: discover(taste), toRate: [] });
    })().catch(next);
  });

  /** Not interested (or, to take it back, interested again). */
  router.put('/:entryId/interest', (req, res, next) => {
    const body = Interest.safeParse(req.body);
    const entryId = req.params['entryId'];
    if (!body.success) {
      res.status(400).json({ error: 'interested must be true or false' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      if ((await db.catalogEntry.findUnique({ where: { id: entryId }, select: { id: true } })) === null) {
        res.status(404).json({ error: 'no such catalog entry' });
        return;
      }
      const was = (await db.recDismissal.findUnique({ where: { catalogEntryId: entryId } })) !== null;
      const dismissed = !body.data.interested;
      if (was !== dismissed) {
        if (dismissed) await db.recDismissal.create({ data: { catalogEntryId: entryId } });
        else await db.recDismissal.delete({ where: { catalogEntryId: entryId } });
        await record(db, { userId, entity: 'rec_dismissal', entityId: entryId, action: dismissed ? 'not_interested' : 'interested', before: { dismissed: was }, after: { dismissed } });
      }
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

export function tasteRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  /** The profile: the strongest liked and disliked terms, plus every term the owner has edited. */
  router.get('/', (_req, res, next) => {
    void (async () => {
      const t = await loadTaste(db);
      const row = (term: string) => ({
        term,
        label: labelOf(term),
        kind: term.startsWith('studio:') ? 'studio' : 'tag',
        learned: Math.round((t.profile.learned.get(term) ?? 0) * 1000) / 1000,
        weight: Math.round((t.profile.weights.get(term) ?? 0) * 1000) / 1000,
        adjust: t.adjust.get(term) ?? null,
      });
      const byLearned = [...t.profile.learned.entries()].filter(([term]) => !t.adjust.has(term)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const liked = byLearned.filter(([, w]) => w > 0);
      res.json({
        state: t.confident < MIN_SIGNALS ? 'cold' : 'ready',
        tags: liked.filter(([term]) => term.startsWith('tag:')).slice(0, 24).map(([term]) => row(term)),
        studios: liked.filter(([term]) => term.startsWith('studio:')).slice(0, 10).map(([term]) => row(term)),
        disliked: byLearned.filter(([, w]) => w < 0).reverse().slice(0, 8).map(([term]) => row(term)),
        edited: [...t.adjust.keys()].sort().map(row),
      });
    })().catch(next);
  });

  router.put('/terms/:term', (req, res, next) => {
    const body = Adjust.safeParse(req.body);
    const term = req.params['term'];
    if (!body.success || !TERM.test(term)) {
      res.status(400).json({ error: 'adjust must be boost, lower, mute or null, for a tag: or studio: term' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const before = (await db.tasteTerm.findUnique({ where: { term } }))?.adjust ?? null;
      const adjust = body.data.adjust;
      if (before !== adjust) {
        if (adjust === null) await db.tasteTerm.delete({ where: { term } });
        else await db.tasteTerm.upsert({ where: { term }, create: { term, adjust }, update: { adjust } });
        await record(db, { userId, entity: 'taste_term', entityId: term, action: adjust ?? 'reset', before: { adjust: before }, after: { adjust } });
      }
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
