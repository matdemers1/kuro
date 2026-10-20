import { Router } from 'express';
import { z } from 'zod';
import { CrSidecarError, type CrSidecar } from '../adapters/crunchyroll.js';
import { requireUser } from '../auth/middleware.js';
import * as connection from '../cr/connection.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

const LinkBody = z.object({ email: z.string().trim().min(3).max(320), password: z.string().min(1).max(1024) });

export function crunchyrollRoutes(deps: { db: Db; sidecar: CrSidecar; secretKey: string; log: Logger }): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', (req, res, next) => {
    connection
      .getStatus(deps.db, req.auth?.userId ?? '')
      .then((s) => res.json(s))
      .catch(next);
  });

  /** Link or re-link. The password is used for this one exchange and never stored or logged. */
  router.post('/link', (req, res, next) => {
    const body = LinkBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    connection
      .link(deps, userId, body.data)
      .then((s) => {
        deps.log.info({ userId }, 'crunchyroll linked');
        res.json(s);
      })
      .catch((err: unknown) => {
        if (err instanceof CrSidecarError) {
          const message =
            err.kind === 'expired'
              ? 'Crunchyroll did not accept that email and password.'
              : err.kind === 'blocked'
                ? 'Crunchyroll blocked the request from this server. Try again later.'
                : 'Crunchyroll could not be reached. Try again later.';
          res.status(err.kind === 'expired' ? 401 : 502).json({ error: message, kind: err.kind });
          return;
        }
        next(err);
      });
  });

  return router;
}
