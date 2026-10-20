import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';
import { record } from '../domain/changelog.js';

/**
 * The change log and undo (KURO-REQ-022). Undo restores an entry's `before`, writes its own entry
 * pointing at the one it reversed, and refuses when that entry is already undone or the thing has
 * changed since — undoing an old pin over a newer unpin would be a surprise, not a correction.
 */
const UNDOABLE: Record<string, (db: Db, entityId: string, before: Record<string, unknown>, after: Record<string, unknown>) => Promise<'ok' | 'moved_on'>> = {
  async show_preference(db, showKey, before, after) {
    const now = await db.showPreference.findUnique({ where: { showKey } });
    if ((now?.pinned ?? false) !== after['pinned']) return 'moved_on';
    const pinned = before['pinned'] === true;
    await db.showPreference.upsert({ where: { showKey }, create: { showKey, pinned }, update: { pinned } });
    return 'ok';
  },
};

export function changeRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', (_req, res, next) => {
    void (async () => {
      const rows = await db.changeLog.findMany({ orderBy: { at: 'desc' }, take: 200, include: { undoneBy: { select: { id: true } } } });
      res.json({
        items: rows.map((r) => ({
          id: r.id,
          entity: r.entity,
          entityId: r.entityId,
          action: r.action,
          before: r.before,
          after: r.after,
          at: r.at.toISOString(),
          undone: r.undoneBy !== null,
          isUndo: r.undoesId !== null,
          undoable: r.entity in UNDOABLE && r.undoneBy === null && r.undoesId === null,
        })),
      });
    })().catch(next);
  });

  router.post('/:id/undo', (req, res, next) => {
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const entry = await db.changeLog.findUnique({ where: { id: req.params['id'] }, include: { undoneBy: { select: { id: true } } } });
      const undo = entry === null ? undefined : UNDOABLE[entry.entity];
      if (entry === null || undo === undefined || entry.undoesId !== null) {
        res.status(404).json({ error: 'that change cannot be undone' });
        return;
      }
      if (entry.undoneBy !== null) {
        res.status(409).json({ error: 'that change was already undone' });
        return;
      }
      const result = await undo(db, entry.entityId, (entry.before ?? {}) as Record<string, unknown>, (entry.after ?? {}) as Record<string, unknown>);
      if (result === 'moved_on') {
        res.status(409).json({ error: 'it has changed since; undo the newer change first' });
        return;
      }
      await db.changeLog.create({
        data: { userId, entity: entry.entity, entityId: entry.entityId, action: `undo:${entry.action}`, before: entry.after ?? {}, after: entry.before ?? {}, undoesId: entry.id },
      });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

export { record };
