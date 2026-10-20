import { importCatalog } from '../catalog/import.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createLogger } from '../logger.js';

/** `kuro catalog-import [--force]` — import the newest catalog release now (KURO-REQ-025). */
export async function catalogImport(args: readonly string[]): Promise<number> {
  const config = loadConfig();
  // The catalog is public data: no secret is needed to import it.
  if (config.DATABASE_URL === undefined) {
    console.error('DATABASE_URL is required');
    return 2;
  }
  const db = createDb(config.DATABASE_URL);
  try {
    const out = await importCatalog(db, { repo: config.KURO_CATALOG_REPO }, createLogger(config.LOG_LEVEL), { force: args.includes('--force') });
    console.log(`${out.status}: ${out.repo} ${out.tag} — ${String(out.entries)} entries, ${String(out.added)} added, ${String(out.retired)} retired`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}
