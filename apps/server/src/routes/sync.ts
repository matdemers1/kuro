import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import type { SyncQueue } from '../jobs/queue.js';
import { latestRun } from '../sync/run.js';

export function syncRoutes(deps: { db: Db; queue: SyncQueue }): Router {
  const router = Router();
  router.use(requireUser);

  /** The import screen and the sync health panel poll this. */
  router.get('/', (req, res, next) => {
    latestRun(deps.db, req.auth?.userId ?? '')
      .then((r) => res.json(r ?? { run: null, plays: 0, linked: false }))
      .catch(next);
  });

  /** Sync now (KURO-REQ-006). A backfill until one has finished; a delta after that. */
  router.post('/', (req, res, next) => {
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const conn = await deps.db.crConnection.findUnique({ where: { userId } });
      if (conn === null) {
        res.status(409).json({ error: 'link Crunchyroll first' });
        return;
      }
      const kind = conn.lastSuccessAt === null ? 'backfill' : 'delta';
      await deps.queue.request(userId, kind);
      res.status(202).json({ queued: kind });
    })().catch(next);
  });

  return router;
}
