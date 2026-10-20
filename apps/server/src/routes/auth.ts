import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';
import type { Logger } from '../logger.js';
import * as login from '../auth/login.js';
import { requireUser } from '../auth/middleware.js';
import type { OidcClient } from '../auth/oidc.js';
import * as sessions from '../auth/sessions.js';

const LoginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  totpCode: z.string().max(16).optional(),
});

export interface AuthRouteDeps extends login.AuthDeps {
  readonly db: Db;
  readonly secure: boolean;
  readonly oidc: OidcClient | null;
  readonly log: Logger;
}

/** The app-native routes. The D3 Auth routes sit **beside** these, never in front (GL-001). */
export function authRoutes(deps: AuthRouteDeps): Router {
  const router = Router();

  router.post('/login', (req, res, next) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }
    login
      .login(deps, { ...parsed.data, ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') })
      .then((outcome) => {
        switch (outcome.kind) {
          case 'throttled': {
            const seconds = Math.ceil(outcome.retryAfterMs / 1000);
            res.setHeader('Retry-After', String(seconds));
            res.status(429).json({ error: 'too many attempts', retryAfterSeconds: seconds });
            return;
          }
          case 'rejected':
            // One message for every failure — wrong account, wrong password, wrong code.
            res.status(401).json({ error: 'invalid credentials' });
            return;
          case 'totp_required':
            res.json({ status: 'totp_required' });
            return;
          case 'session':
            sessions.setCookie(res, outcome.token, deps.secure);
            deps.log.info({ userId: outcome.userId, method: 'password' }, 'login');
            res.json({ status: 'signed_in' });
            return;
        }
      })
      .catch(next);
  });

  router.post('/logout', (req, res) => {
    const sessionId = req.auth?.sessionId;
    void (async () => {
      let redirectTo: string | null = null;
      if (sessionId !== undefined) {
        const session = await deps.db.session.findUnique({ where: { id: sessionId } });
        await sessions.revoke(deps.db, sessionId);
        if (session?.method === 'oidc' && deps.oidc !== null) {
          redirectTo = await deps.oidc.endSessionUrl('', '/');
        }
      }
      sessions.clearCookie(res, deps.secure);
      res.json({ redirectTo });
    })().catch(() => {
      // Signing out must always appear to work: a cookie left behind is the worse failure.
      sessions.clearCookie(res, deps.secure);
      res.json({ redirectTo: null });
    });
  });

  /** Who am I. The app calls this on load to choose between itself and the sign-in screen. */
  router.get('/session', (req, res, next) => {
    const userId = req.auth?.userId;
    void (async () => {
      const ownerExists = (await deps.db.user.count()) > 0;
      if (userId === undefined) {
        res.status(401).json({ authenticated: false, oidcAvailable: deps.oidc !== null, setupRequired: !ownerExists });
        return;
      }
      const user = await deps.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true, displayName: true, credential: { select: { totpConfirmedAt: true } }, identities: { select: { iss: true } } },
      });
      res.json({
        authenticated: true,
        user: { id: user.id, email: user.email, displayName: user.displayName },
        totpEnrolled: (user.credential?.totpConfirmedAt ?? null) !== null,
        d3AuthLinked: user.identities.length > 0,
        oidcAvailable: deps.oidc !== null,
      });
    })().catch(next);
  });

  router.post('/totp/enrol', requireUser, (req, res, next) => {
    login
      .beginTotpEnrolment(deps, req.auth?.userId ?? '')
      .then((result) => res.json(result))
      .catch(next);
  });

  router.post('/totp/confirm', requireUser, (req, res, next) => {
    const body = z.object({ code: z.string().min(6).max(10) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'a code is required' });
      return;
    }
    const userId = req.auth?.userId ?? '';
    void (async () => {
      if (!(await login.confirmTotpEnrolment(deps, userId, body.data.code))) {
        res.status(400).json({ error: 'that code did not match' });
        return;
      }
      await record(deps.db, { userId, entity: 'user', entityId: userId, action: 'totp_enrolled' });
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
