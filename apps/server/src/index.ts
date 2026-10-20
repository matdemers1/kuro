import { createApp } from './app.js';
import { migrate } from './boot.js';
import { CrSidecar } from './adapters/crunchyroll.js';
import { resumeInterrupted, startPgBossQueue } from './jobs/queue.js';
import { Alerts, vapidTransport } from './push/sender.js';
import { ImageCache } from './images/cache.js';
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
const transport =
  config.VAPID_PUBLIC_KEY !== undefined && config.VAPID_PRIVATE_KEY !== undefined
    ? vapidTransport({ publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT }, log)
    : null;
const alerts = new Alerts(db, transport, log);
const queue = await startPgBossQueue(databaseUrl, syncDeps, log, config.SYNC_TIMEZONE, alerts, { repo: config.KURO_CATALOG_REPO });
await resumeInterrupted(syncDeps, queue);

createApp({
  version,
  webDist: config.WEB_DIST,
  core: { db, baseUrl: config.BASE_URL, secretKey, pepper, oidc, log, setupToken: config.SETUP_TOKEN, sidecarUrl: config.KURO_CR_URL, sidecar, queue, alerts, vapidPublicKey: config.VAPID_PUBLIC_KEY, images: new ImageCache(config.IMAGE_DIR) },
}).listen(config.PORT, () => {
  log.info({ port: config.PORT, version, oidc: oidc !== null }, 'kuro-server listening');
});
