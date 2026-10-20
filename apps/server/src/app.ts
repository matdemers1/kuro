import express, { type Express } from 'express';

export interface AppDeps {
  version: string;
  webDist?: string | undefined;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Shipyard and Docker's HEALTHCHECK read this. KURO-T-0.7 adds the database and sidecar.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: deps.version });
  });

  if (deps.webDist) {
    app.use(express.static(deps.webDist, { index: 'index.html', maxAge: '1h' }));
  }

  return app;
}
