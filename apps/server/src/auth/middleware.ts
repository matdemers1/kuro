import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import * as sessions from './sessions.js';

export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/** True when cookies must carry the `Secure` attribute — everywhere but local HTTP. */
export function isSecureOrigin(config: Pick<Config, 'BASE_URL'>): boolean {
  return config.BASE_URL.startsWith('https://');
}

/** Attach the session when a cookie presents one. Never rejects; route guards decide. */
export function attachAuth(db: Db, config: Pick<Config, 'BASE_URL'>) {
  const name = sessions.cookieName(isSecureOrigin(config));
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = sessions.readCookie(req, name);
    if (token === null) {
      next();
      return;
    }
    sessions
      .resolve(db, token)
      .then((session) => {
        if (session !== null) req.auth = { userId: session.userId, sessionId: session.sessionId };
        next();
      })
      .catch(next);
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (req.auth === undefined) {
    res.status(401).json({ error: 'sign in first' });
    return;
  }
  next();
}
