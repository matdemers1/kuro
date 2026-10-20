import { importCatalog } from '../catalog/import.js';
import { loadConfig, requireSecrets } from '../config.js';
import { createDb } from '../db.js';
import { createLogger } from '../logger.js';

/** `kuro catalog-import [--force]` — import the newest catalog release now (KURO-REQ-025). */
export async function catalogImport(args: readonly string[]): Promise<number> {
  const config = loadConfig();
  const { databaseUrl } = requireSecrets(config);
  const db = createDb(databaseUrl);
  try {
    const out = await importCatalog(db, { repo: config.KURO_CATALOG_REPO }, createLogger(config.LOG_LEVEL), { force: args.includes('--force') });
    console.log(`${out.status}: ${out.repo} ${out.tag} — ${String(out.entries)} entries, ${String(out.added)} added, ${String(out.retired)} retired`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}
