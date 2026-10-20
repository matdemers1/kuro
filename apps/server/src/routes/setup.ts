import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';
import type { Logger } from '../logger.js';
import { setPassword, type AuthDeps } from '../auth/login.js';
import * as sessions from '../auth/sessions.js';

/**
 * First run (KURO-REQ-055, KURO-REQ-062). While no owner exists, the SETUP_TOKEN from the
 * environment creates exactly one; from then on this router answers 404 to everything and Kurō
 * has no signup at all. TOTP enrolment and the D3 Auth link happen next, from the session this
 * returns, through the ordinary /auth routes.
 */

const SetupBody = z.object({
  setupToken: z.string().min(1).max(512),
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12, 'use at least 12 characters').max(1024),
});

export interface SetupRouteDeps extends AuthDeps {
  readonly db: Db;
  readonly setupToken: string | undefined;
  readonly secure: boolean;
  readonly log: Logger;
}

/** Constant-time, length-independent comparison of the presented token. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function setupRoutes(deps: SetupRouteDeps): Router {
  const router = Router();

  router.use((_req, res, next) => {
    deps.db.user
      .count()
      .then((owners) => {
        // Once the owner exists the setup surface does not exist either.
        if (owners > 0 || deps.setupToken === undefined) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        next();
      })
      .catch(next);
  });

  router.get('/', (_req, res) => {
    res.json({ setupRequired: true });
  });

  router.post('/', (req, res, next) => {
    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid setup details', fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      return;
    }
    if (!tokenMatches(parsed.data.setupToken, deps.setupToken ?? '')) {
      res.status(403).json({ error: 'that setup token is not right' });
      return;
    }
    const { email, displayName, password } = parsed.data;
    void (async () => {
      // Serialised: two racing setups must not both create an owner.
      const user = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4242001)`;
        if ((await tx.user.count()) > 0) return null;
        return tx.user.create({ data: { email: email.trim().toLowerCase(), displayName } });
      });
      if (user === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      await setPassword(deps, user.id, password);
      await record(deps.db, { userId: user.id, entity: 'user', entityId: user.id, action: 'owner_created', after: { email: user.email } });
      const session = await sessions.issue(deps.db, user.id, 'password', { ip: req.ip, userAgent: req.get('user-agent') });
      sessions.setCookie(res, session.token, deps.secure);
      deps.log.info({ userId: user.id }, 'owner created; setup is now closed');
      res.status(201).json({ status: 'owner_created' });
    })().catch(next);
  });

  return router;
}
