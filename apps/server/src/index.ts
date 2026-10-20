import { createApp } from './app.js';
import { migrate } from './boot.js';
import { CrSidecar } from './adapters/crunchyroll.js';
import { resumeInterrupted, startPgBossQueue } from './jobs/queue.js';
import { createOidcClient } from './auth/oidc.js';
import { loadConfig, requireSecrets } from './config.js';
import { createDb } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const version = process.env['KURO_VERSION'] ?? 'dev';
const { secretKey, pepper, databaseUrl } = requireSecrets(config);
await migrate({ databaseUrl, backupDir: config.BACKUP_DIR, backupFirst: config.BACKUP_BEFORE_MIGRATE, log });
const db = createDb(databaseUrl);
const oidc = await createOidcClient(config, log);
const sidecar = new CrSidecar(config.KURO_CR_URL);
const syncDeps = { db, sidecar, secretKey, log };
const queue = await startPgBossQueue(databaseUrl, syncDeps, log);
await resumeInterrupted(syncDeps, queue);

createApp({
  version,
  webDist: config.WEB_DIST,
  core: { db, baseUrl: config.BASE_URL, secretKey, pepper, oidc, log, setupToken: config.SETUP_TOKEN, sidecarUrl: config.KURO_CR_URL, sidecar, queue },
}).listen(config.PORT, () => {
  log.info({ port: config.PORT, version, oidc: oidc !== null }, 'kuro-server listening');
});
