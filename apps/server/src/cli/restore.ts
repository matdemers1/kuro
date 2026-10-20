import { run } from '../boot.js';
import { loadConfig } from '../config.js';

/**
 * Restore a dump made by backup.js or the pre-migration step. Destructive: `--yes` is required.
 *   node dist/cli/restore.js --file /data/backups/<name>.dump --yes
 */
const args = process.argv.slice(2);
const at = args.indexOf('--file');
const file = at >= 0 ? args[at + 1] : undefined;
if (file === undefined) throw new Error('usage: restore.js --file <dump> --yes');
if (!args.includes('--yes')) throw new Error('restore replaces the whole database; pass --yes to confirm');
const config = loadConfig();
if (config.DATABASE_URL === undefined) throw new Error('DATABASE_URL is required');
await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--single-transaction', '--dbname', config.DATABASE_URL, file], process.env);
console.log(`restored ${file}`);
