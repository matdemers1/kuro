import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';

/**
 * The rewatch queue (KURO-REQ-042, KURO-T-4.2): Shows to watch again, in the owner's order, each
 * with an optional reason and Season to start from. Every change records the whole queue before and
 * after, so undo puts it back exactly.
 */

type QueueSnapshot = { showKey: string; position: number; reason: string | null; startEntryId: string | null }[];

export async function queueSnapshot(db: Db): Promise<QueueSnapshot> {
  return (await db.rewatchQueueItem.findMany({ orderBy: { position: 'asc' } })).map((q) => ({ showKey: q.showKey, position: q.position, reason: q.reason, startEntryId: q.startEntryId }));
}

export async function restoreQueue(db: Db, rows: QueueSnapshot): Promise<void> {
  await db.$transaction([db.rewatchQueueItem.deleteMany({}), db.rewatchQueueItem.createMany({ data: rows })]);
}

const Item = z.object({ showKey: z.string().min(1).max(300), reason: z.string().max(500).nullish(), startEntryId: z.string().max(300).nullish() });
const Patch = z.object({ reason: z.string().max(500).nullish(), startEntryId: z.string().max(300).nullish() });
const Order = z.object({ showKeys: z.array(z.string().min(1).max(300)).max(500) });

export function rewatchRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  const change = async (userId: string, action: string, entityId: string, mutate: (rows: QueueSnapshot) => QueueSnapshot) => {
    const before = await queueSnapshot(db);
    const after = mutate(before.map((r) => ({ ...r }))).map((r, position) => ({ ...r, position }));
    await restoreQueue(db, after);
    await record(db, { userId, entity: 'rewatch_queue', entityId, action, before: { rows: before }, after: { rows: after } });
  };

  router.get('/', (_req, res, next) => {
    void (async () => {
      const rows = await queueSnapshot(db);
      const keys = rows.map((r) => r.showKey);
      const [states, rewatches, entries] = await Promise.all([
        db.showState.findMany({ where: { showKey: { in: keys } }, select: { showKey: true, title: true, status: true, totalEpisodes: true } }),
        db.rewatch.groupBy({ by: ['showKey'], where: { showKey: { in: keys } }, _count: { _all: true } }),
        db.catalogEntry.findMany({ where: { id: { in: rows.flatMap((r) => (r.startEntryId === null ? [] : [r.startEntryId])) } }, select: { id: true, title: true } }),
      ]);
      const state = new Map(states.map((s) => [s.showKey, s]));
      const count = new Map(rewatches.map((r) => [r.showKey, r._count._all]));
      const entry = new Map(entries.map((e) => [e.id, e.title]));
      res.json({
        items: rows.map((r) => ({
          ...r,
          title: state.get(r.showKey)?.title ?? r.showKey,
          status: state.get(r.showKey)?.status ?? null,
          startTitle: r.startEntryId === null ? null : (entry.get(r.startEntryId) ?? null),
          timesRewatched: count.get(r.showKey) ?? 0,
        })),
      });
    })().catch(next);
  });

  router.post('/', (req, res, next) => {
    const body = Item.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'showKey is required' });
      return;
    }
    void (async () => {
      if ((await db.showState.findUnique({ where: { showKey: body.data.showKey } })) === null) {
        res.status(404).json({ error: 'no such show' });
        return;
      }
      await change(req.auth?.userId ?? '', 'queued', body.data.showKey, (rows) => [
        ...rows.filter((r) => r.showKey !== body.data.showKey),
        { showKey: body.data.showKey, position: rows.length, reason: body.data.reason ?? null, startEntryId: body.data.startEntryId ?? null },
      ]);
      res.status(201).end();
    })().catch(next);
  });

  /** The new order, as the list of Show keys; any left out keep their place at the end. */
  router.put('/order', (req, res, next) => {
    const body = Order.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'showKeys is required' });
      return;
    }
    void (async () => {
      await change(req.auth?.userId ?? '', 'reordered', 'queue', (rows) => {
        const rank = new Map(body.data.showKeys.map((k, i) => [k, i]));
        return [...rows].sort((a, b) => (rank.get(a.showKey) ?? Infinity) - (rank.get(b.showKey) ?? Infinity) || a.position - b.position);
      });
      res.status(204).end();
    })().catch(next);
  });

  router.put('/:showKey', (req, res, next) => {
    const body = Patch.safeParse(req.body);
    const key = req.params['showKey'];
    if (!body.success) {
      res.status(400).json({ error: 'reason and startEntryId must be text or null' });
      return;
    }
    void (async () => {
      if ((await db.rewatchQueueItem.findUnique({ where: { showKey: key } })) === null) {
        res.status(404).json({ error: 'not in the rewatch queue' });
        return;
      }
      await change(req.auth?.userId ?? '', 'edited', key, (rows) =>
        rows.map((r) => (r.showKey === key ? { ...r, ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}), ...(body.data.startEntryId !== undefined ? { startEntryId: body.data.startEntryId } : {}) } : r)),
      );
      res.status(204).end();
    })().catch(next);
  });

  router.delete('/:showKey', (req, res, next) => {
    const key = req.params['showKey'];
    void (async () => {
      await change(req.auth?.userId ?? '', 'unqueued', key, (rows) => rows.filter((r) => r.showKey !== key));
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
