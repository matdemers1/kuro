import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { attachAuth, isSecureOrigin } from './auth/middleware.js';
import type { OidcClient } from './auth/oidc.js';
import type { Db } from './db.js';
import type { Logger } from './logger.js';
import { authRoutes } from './routes/auth.js';
import { oidcRoutes } from './routes/oidc.js';
import { setupRoutes } from './routes/setup.js';
import { schemaRevision } from './boot.js';
import { CrSidecar } from './adapters/crunchyroll.js';
import { crunchyrollRoutes } from './routes/crunchyroll.js';

export interface AppDeps {
  readonly version: string;
  readonly webDist?: string | undefined;
  /** Absent only in tests that exercise nothing but the health endpoint. */
  readonly core?: {
    readonly db: Db;
    readonly baseUrl: string;
    readonly secretKey: string;
    readonly pepper: string;
    readonly oidc: OidcClient | null;
    readonly log: Logger;
    readonly setupToken?: string | undefined;
    readonly sidecarUrl?: string | undefined;
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  // Liveness: the process is up. Docker's HEALTHCHECK reads this.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: deps.version });
  });

  // What Shipyard's manifest checks after a deploy: the schema revision, the database and the
  // sidecar. 503 when either dependency is down, so a broken release fails its soak.
  app.get('/health', (_req, res, next) => {
    if (deps.core === undefined) {
      res.json({ ok: true, version: deps.version, schemaRevision: null, database: 'absent', sidecar: 'absent' });
      return;
    }
    const { db, sidecarUrl } = deps.core;
    void (async () => {
      const schema = await schemaRevision(db);
      const sidecar = sidecarUrl === undefined ? 'absent' : await fetch(new URL('/healthz', sidecarUrl), { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? 'up' : 'down'), () => 'down');
      const database = schema === null ? 'down' : 'up';
      const ok = database === 'up' && sidecar !== 'down';
      res.status(ok ? 200 : 503).json({ ok, version: deps.version, schemaRevision: schema, database, sidecar });
    })().catch(next);
  });

  if (deps.core !== undefined) {
    const { db, baseUrl, log } = deps.core;
    const secure = isSecureOrigin({ BASE_URL: baseUrl });
    app.use(express.json({ limit: '64kb' }));
    app.use(attachAuth(db, { BASE_URL: baseUrl }));
    app.use('/auth', authRoutes({ ...deps.core, secure }));
    app.use('/auth/oidc', oidcRoutes({ db, baseUrl, secure, client: deps.core.oidc, log }));
    app.use('/api/setup', setupRoutes({ ...deps.core, setupToken: deps.core.setupToken, secure }));
    const sidecar = new CrSidecar(deps.core.sidecarUrl ?? 'http://kuro-cr:8080');
    app.use('/api/crunchyroll', crunchyrollRoutes({ db, sidecar, secretKey: deps.core.secretKey, log }));
  }

  if (deps.webDist !== undefined) {
    app.use(express.static(deps.webDist, { index: 'index.html', maxAge: '1h' }));
  }

  // One shape for every unexpected failure, and nothing about the internals in it.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    deps.core?.log.error({ err: err instanceof Error ? err.message : String(err) }, 'request failed');
    res.status(500).json({ error: 'something went wrong' });
  });

  return app;
}
