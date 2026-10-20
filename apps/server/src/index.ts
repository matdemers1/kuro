import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const version = process.env['KURO_VERSION'] ?? 'dev';

createApp({ version, webDist: config.WEB_DIST }).listen(config.PORT, () => {
  log.info({ port: config.PORT, version }, 'kuro-server listening');
});
