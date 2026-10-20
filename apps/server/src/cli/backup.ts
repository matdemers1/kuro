import { dumpDatabase } from '../boot.js';
import { loadConfig } from '../config.js';

/** Shipyard's backup step and the manual dump: prints the artifact's file name on success. */
const config = loadConfig();
if (config.DATABASE_URL === undefined) throw new Error('DATABASE_URL is required');
const path = await dumpDatabase(config.DATABASE_URL, config.BACKUP_DIR, 'manual');
console.log(path.split('/').pop());
