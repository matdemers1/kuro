import type PgBoss from 'pg-boss';
import { importCatalog, newestRelease } from '../catalog/import.js';
import type { CatalogSource } from '../catalog/source.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

/**
 * Weekly catalog import (KURO-REQ-025): Tuesdays at 04:00 in the owner's time zone, after the
 * Monday releases land, and once at boot while nothing has been imported yet.
 */
export const CATALOG_CRON = '0 4 * * 2';
const QUEUE = 'catalog-import';

export async function registerCatalogImport(boss: PgBoss, db: Db, source: CatalogSource, log: Logger, timezone: string, afterImport?: () => Promise<void>): Promise<void> {
  await boss.createQueue(QUEUE, { policy: 'singleton' });
  await boss.schedule(QUEUE, CATALOG_CRON, {}, { tz: timezone });
  await boss.work(QUEUE, { batchSize: 1 }, async () => {
    try {
      const out = await importCatalog(db, source, log);
      if (out.status === 'imported') await afterImport?.();
    } catch (err) {
      // The stale alert is what tells the owner; a failed week retries the next.
      log.warn({ repo: source.repo, err: err instanceof Error ? err.message : String(err) }, 'catalog import failed');
    }
  });
  if ((await newestRelease(db)) === null) await boss.send(QUEUE, {}, { singletonKey: 'boot' });
  log.info({ cron: CATALOG_CRON, timezone, repo: source.repo }, 'catalog import scheduled');
}
