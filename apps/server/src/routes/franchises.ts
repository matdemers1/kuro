import { Router } from 'express';
import { Media } from '../adapters/anilist.js';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { progressOf } from '../derive/progress.js';
import { timeline, type TimelineEntry } from '../derive/timeline.js';
import { seasonIndex } from '../match/ranges.js';

/**
 * A Franchise (KURO-T-2.8): its Shows in watch order — by their first Season — with each one's
 * status and progress, and how many Seasons and Extras it holds. And its watch-order timeline
 * (KURO-T-5.4): every Season and Extra in order, with the related entries the owner has none of.
 */

/** AniList relations worth a place on a timeline; recaps, alternatives and character links are not. */
const TIMELINE_RELATIONS = new Set(['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'PARENT']);

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

      // The timeline: every part of every Show, and the related entries not in the library.
      const ownedIds = shows.flatMap((s) => s.items.map((i) => i.catalogEntryId));
      const ownedEntries = await db.catalogEntry.findMany({ where: { id: { in: ownedIds } }, select: { anilistId: true } });
      const relatedIds = new Map<number, string>();
      for (const row of await db.anilistMedia.findMany({ where: { anilistId: { in: ownedEntries.flatMap((e) => (e.anilistId === null ? [] : [e.anilistId])) } } })) {
        const m = Media.safeParse(row.payload);
        if (!m.success) continue;
        for (const edge of m.data.relations) if (edge.node.type === 'ANIME' && TIMELINE_RELATIONS.has(edge.relationType) && !relatedIds.has(edge.node.id)) relatedIds.set(edge.node.id, edge.relationType);
      }
      const rows = await db.catalogEntry.findMany({
        where: { OR: [{ id: { in: ownedIds } }, { anilistId: { in: [...relatedIds.keys()] }, retiredAt: null, type: { not: 'UNKNOWN' } }] },
        select: { id: true, title: true, type: true, episodes: true, seasonYear: true, season: true, status: true, anilistId: true },
      });
      const entryMap = new Map<string, TimelineEntry>(rows.map((e) => [e.id, { id: e.id, title: e.title, type: e.type, episodes: e.episodes, year: e.seasonYear, seasonIndex: seasonIndex(e.season) ?? 9, status: e.status }]));
      const related = rows.flatMap((e) => (e.anilistId !== null && relatedIds.has(e.anilistId) && !ownedIds.includes(e.id) ? [{ entryId: e.id, relation: relatedIds.get(e.anilistId) ?? 'SEQUEL' }] : []));
      const userId = req.auth?.userId ?? '';
      const progress = new Map<string, { watched: number; total: number }>();
      for (const s of ordered) for (const [id, p] of await progressOf(db, userId, s.showKey)) progress.set(id, p);
      const steps = timeline(
        ordered.map((s) => ({ showKey: s.showKey, title: s.title, items: s.items.map((i) => ({ entryId: i.catalogEntryId, kind: i.kind === 'extra' ? ('extra' as const) : ('season' as const), required: i.required })) })),
        entryMap,
        related,
      ).map((r) => ({ ...r, watched: progress.get(r.entryId)?.watched ?? null, total: progress.get(r.entryId)?.total ?? null }));
      const earliest = shows.find((s) => `fr:${s.showKey}` === key) ?? ordered[0];
      res.json({
        key,
        title: earliest?.title ?? '',
        timeline: steps,
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
