import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';
import { record } from '../domain/changelog.js';
import { restoreSeason, snapshot, type Snapshot } from './mappings.js';
import { queueSnapshot, restoreQueue } from './rewatch.js';
import { listSnapshot, restoreList, type ListSnapshot } from './shareLists.js';

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
  /** The rewatch queue, back to exactly what it was, if it has not changed since. */
  async rewatch_queue(db, _id, before, after) {
    if (stable(await queueSnapshot(db)) !== stable(after['rows'])) return 'moved_on';
    await restoreQueue(db, (before['rows'] ?? []) as Awaited<ReturnType<typeof queueSnapshot>>);
    return 'ok';
  },
  /** A shared list, back to exactly what it was — link, order and notes — if it has not changed since. */
  async share_list(db, id, before, after) {
    if (stable(await listSnapshot(db, id)) !== stable(after)) return 'moved_on';
    await restoreList(db, id, before as unknown as ListSnapshot);
    return 'ok';
  },
  /** Skip filler, back to what it was, if it was not changed since. */
  async skip_filler(db, showKey, before, after) {
    const now = (await db.showPreference.findUnique({ where: { showKey } }))?.skipFiller ?? false;
    if (now !== (after['skip'] === true)) return 'moved_on';
    const skipFiller = before['skip'] === true;
    await db.showPreference.upsert({ where: { showKey }, create: { showKey, skipFiller }, update: { skipFiller } });
    return 'ok';
  },
  /** Not interested, taken back or put back, if it was not changed since. */
  async rec_dismissal(db, catalogEntryId, before, after) {
    const now = (await db.recDismissal.findUnique({ where: { catalogEntryId } })) !== null;
    if (now !== (after['dismissed'] === true)) return 'moved_on';
    if (before['dismissed'] === true) await db.recDismissal.create({ data: { catalogEntryId } });
    else await db.recDismissal.deleteMany({ where: { catalogEntryId } });
    return 'ok';
  },
  /** A taste-profile edit, back to the earlier one (or none), if it was not changed since. */
  async taste_term(db, term, before, after) {
    const now = (await db.tasteTerm.findUnique({ where: { term } }))?.adjust ?? null;
    if (now !== (after['adjust'] ?? null)) return 'moved_on';
    const adjust = typeof before['adjust'] === 'string' ? before['adjust'] : null;
    if (adjust === null) await db.tasteTerm.deleteMany({ where: { term } });
    else await db.tasteTerm.upsert({ where: { term }, create: { term, adjust }, update: { adjust } });
    return 'ok';
  },
  /** A rating, back to its earlier score (or none), if it was not changed since. */
  async rating(db, target, before, after) {
    const now = await db.rating.findUnique({ where: { target } });
    if ((now?.score ?? null) !== (after['score'] ?? null)) return 'moved_on';
    const score = typeof before['score'] === 'number' ? before['score'] : null;
    if (score === null) await db.rating.deleteMany({ where: { target } });
    else await db.rating.upsert({ where: { target }, create: { target, score }, update: { score } });
    return 'ok';
  },
  /** A note, back to its earlier text (or none), if it was not edited since. */
  async show_note(db, showKey, before, after) {
    const now = await db.showNote.findUnique({ where: { showKey } });
    if ((now?.text ?? null) !== (after['text'] ?? null)) return 'moved_on';
    const text = typeof before['text'] === 'string' ? before['text'] : null;
    if (text === null) await db.showNote.deleteMany({ where: { showKey } });
    else await db.showNote.upsert({ where: { showKey }, create: { showKey, text }, update: { text } });
    return 'ok';
  },
  /** A grouping override, added or taken back: undo does the opposite, if nothing changed since. */
  async override(db, id, before, after) {
    const now = await db.override.findUnique({ where: { id } });
    if ((now !== null) !== (after['exists'] === true)) return 'moved_on';
    if (now !== null) await db.override.delete({ where: { id } });
    else if (typeof before['kind'] === 'string') await db.override.create({ data: { id, kind: before['kind'], payload: (before['payload'] ?? {}) } });
    return 'ok';
  },
  /** The owner's status for a Show, back to what it was, if nothing changed it since. */
  async show_status(db, showKey, before, after) {
    const now = await db.showPreference.findUnique({ where: { showKey } });
    if ((now?.status ?? null) !== after['status']) return 'moved_on';
    const status = (before['status'] as string | null | undefined) ?? null;
    const at = typeof before['statusAt'] === 'string' ? new Date(before['statusAt']) : null;
    const dropReason = typeof before['dropReason'] === 'string' ? before['dropReason'] : null;
    await db.showPreference.upsert({ where: { showKey }, create: { showKey, status, statusAt: at, dropReason }, update: { status, statusAt: at, dropReason } });
    return 'ok';
  },
  /** A review-queue answer: the season's mappings go back to what they were, if nothing changed since. */
  async mapping_season(db, seasonId, before, after) {
    const now = await snapshot(db, seasonId);
    // jsonb does not keep key order, so compare with keys sorted.
    if (stable(now) !== stable(after)) return 'moved_on';
    await restoreSeason(db, seasonId, before as unknown as Snapshot);
    return 'ok';
  },
};

/** JSON with object keys sorted, so two equal values always print the same. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

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
