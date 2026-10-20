import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { syncHealth } from '../jobs/alertsCheck.js';
import type { Alerts } from '../push/sender.js';

const Subscription = z.object({ endpoint: z.url().max(2000), keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }) });

export function pushRoutes(deps: { db: Db; alerts: Alerts; publicKey: string | undefined }): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/key', (_req, res) => {
    res.json({ publicKey: deps.publicKey ?? null });
  });

  router.post('/subscribe', (req, res, next) => {
    const body = Subscription.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'not a push subscription' });
      return;
    }
    const { endpoint, keys } = body.data;
    deps.db.pushSubscription
      .upsert({ where: { endpoint }, create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: req.get('user-agent')?.slice(0, 300) ?? null }, update: { p256dh: keys.p256dh, auth: keys.auth } })
      .then(() => res.status(204).end())
      .catch(next);
  });

  /** "Send a test alert" in Settings — the proof that this device receives them. */
  router.post('/test', (_req, res, next) => {
    deps.alerts
      .send({ key: `test:${new Date().toISOString()}`, title: 'Kurō alerts work', body: 'You’ll hear from Kurō here when a new dub lands or sync needs you.', url: '/' })
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}

/** The sync health panel and the banners read this (KURO-REQ-010). */
export function healthPanelRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/', (req, res, next) => {
    void (async () => {
      const h = await syncHealth(db, req.auth?.userId ?? '');
      const subscriptions = await db.pushSubscription.count();
      // The newest nightly backup and its restore check (KURO-T-6.2).
      const b = await db.backupRun.findFirst({ orderBy: { startedAt: 'desc' } });
      const backup = b === null ? null : { at: b.startedAt.toISOString(), file: b.file, sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes), check: b.check, detail: b.detail };
      res.json({ ...h, lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null, pushDevices: subscriptions, backup });
    })().catch(next);
  });
  return router;
}
