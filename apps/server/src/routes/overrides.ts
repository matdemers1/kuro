import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';
import { record } from '../domain/changelog.js';
import { anchors, OverrideBody } from '../overrides/overrides.js';

/**
 * The grouping editor's API (KURO-T-2.6): add a merge, split, reorder or attach; list the ones that
 * touch a Show; take one back. Each change is change-logged and undoable, and Shows are rebuilt.
 */
export function overrideRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  /** The overrides anchored on a Show's series or entries. */
  router.get('/', (req, res, next) => {
    const showKey = typeof req.query['showKey'] === 'string' ? req.query['showKey'] : '';
    void (async () => {
      const show = await db.show.findUnique({ where: { showKey }, include: { items: true } });
      // Its series, its items, and every entry mapped from its series — a split moves an entry out
      // of the Show, but the override still belongs to the Show it was split from.
      const mapped = await db.mapping.findMany({ where: { crSeasonId: { in: (await db.crSeason.findMany({ where: { seriesId: { in: show?.seriesIds ?? [] } }, select: { id: true } })).map((x) => x.id) } }, select: { catalogEntryId: true } });
      const touched = new Set([...(show?.seriesIds ?? []), ...(show?.items.map((i) => i.catalogEntryId) ?? []), ...mapped.flatMap((m) => (m.catalogEntryId === null ? [] : [m.catalogEntryId]))]);
      const rows = await db.override.findMany({ orderBy: { createdAt: 'asc' } });
      res.json({
        items: rows.flatMap((r) => {
          const o = OverrideBody.safeParse({ ...(r.payload as object), kind: r.kind });
          return o.success && anchors(o.data).some((a) => touched.has(a)) ? [{ id: r.id, ...o.data, createdAt: r.createdAt.toISOString() }] : [];
        }),
      });
    })().catch(next);
  });

  router.post('/', (req, res, next) => {
    const parsed = OverrideBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'not a merge, split, reorder or attach' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const { kind, ...payload } = parsed.data;
      const row = await db.override.create({ data: { kind, payload } });
      await record(db, { userId, entity: 'override', entityId: row.id, action: kind, before: { exists: false }, after: { exists: true, kind, payload } });
      await rebuildShows(db, userId);
      res.status(201).json({ id: row.id });
    })().catch(next);
  });

  router.delete('/:id', (req, res, next) => {
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const row = await db.override.findUnique({ where: { id: req.params['id'] } });
      if (row === null) {
        res.status(404).json({ error: 'no such override' });
        return;
      }
      await db.override.delete({ where: { id: row.id } });
      await record(db, { userId, entity: 'override', entityId: row.id, action: `remove:${row.kind}`, before: { exists: true, kind: row.kind, payload: row.payload as object }, after: { exists: false } });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
