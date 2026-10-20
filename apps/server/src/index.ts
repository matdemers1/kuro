import { createApp } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { loadConfig, requireSecrets } from './config.js';
import { createDb } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const version = process.env['KURO_VERSION'] ?? 'dev';
const { secretKey, pepper, databaseUrl } = requireSecrets(config);
const db = createDb(databaseUrl);
const oidc = await createOidcClient(config, log);

createApp({
  version,
  webDist: config.WEB_DIST,
  core: { db, baseUrl: config.BASE_URL, secretKey, pepper, oidc, log },
}).listen(config.PORT, () => {
  log.info({ port: config.PORT, version, oidc: oidc !== null }, 'kuro-server listening');
});
