import { Router } from 'express';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';
import type { Logger } from '../logger.js';
import { OidcError, resolveIdentity, TX_COOKIE, type OidcClient } from '../auth/oidc.js';
import * as sessions from '../auth/sessions.js';

export interface OidcRouteDeps {
  readonly db: Db;
  readonly baseUrl: string;
  readonly secure: boolean;
  readonly client: OidcClient | null;
  readonly log: Logger;
}

export function oidcRoutes({ db, baseUrl, secure, client, log }: OidcRouteDeps): Router {
  const router = Router();
  const txCookie = (value: string, maxAgeSeconds: number) =>
    [`${TX_COOKIE}=${value}`, 'Path=/auth/oidc/callback', 'HttpOnly', 'SameSite=Lax', `Max-Age=${String(maxAgeSeconds)}`, ...(secure ? ['Secure'] : [])].join('; ');

  /** `?link=1` from a signed-in session attaches the identity to the owner (setup, Settings). */
  router.get('/start', (req, res, next) => {
    if (client === null) {
      res.status(503).json({ error: 'sign-in with D3 Auth is not available' });
      return;
    }
    const linkTo = req.query['link'] === '1' ? req.auth?.userId : undefined;
    client
      .beginSignIn(linkTo)
      .then(({ url, tx }) => {
        res.setHeader('Set-Cookie', txCookie(tx, 600));
        res.redirect(url);
      })
      .catch(next);
  });

  router.get('/callback', (req, res, next) => {
    res.append('Set-Cookie', txCookie('', 0));
    if (client === null) {
      res.status(503).json({ error: 'sign-in with D3 Auth is not available' });
      return;
    }
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const tx = sessions.readCookie(req, TX_COOKIE);
    if (tx === null) {
      res.status(400).json({ error: 'no sign-in is in progress for this browser' });
      return;
    }
    void (async () => {
      try {
        const completed = await client.completeSignIn(new URL(req.originalUrl, baseUrl), tx, state);
        const userId = await resolveIdentity(db, completed);
        if (completed.linkToUserId !== undefined) {
          await record(db, { userId, entity: 'identity', entityId: `${completed.iss}#${completed.sub}`, action: 'linked', after: { iss: completed.iss } });
        }
        const session = await sessions.issue(db, userId, 'oidc', { ip: req.ip, userAgent: req.get('user-agent'), idTokenSub: completed.sub });
        sessions.setCookie(res, session.token, secure);
        log.info({ userId, method: 'oidc' }, 'login');
        res.redirect('/');
      } catch (error) {
        if (error instanceof OidcError) {
          log.warn({ err: error.message }, 'D3 Auth sign-in refused');
          res.redirect(`/?${new URLSearchParams({ signin_error: error.message }).toString()}`);
          return;
        }
        throw error;
      }
    })().catch(next);
  });

  return router;
}
