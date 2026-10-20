import type PgBoss from 'pg-boss';
import type { FillerClient } from '../adapters/fillerlist.js';
import type { Db } from '../db.js';
import { FILLER_CRON, refreshFiller } from '../filler/refresh.js';
import type { Logger } from '../logger.js';

/**
 * Weekly filler refresh (KURO-T-5.3): Wednesdays at 05:00 in the owner's time zone, and once at boot
 * while no list has been read. A refresh that fetched anything re-derives, so marks and skips land.
 */
const QUEUE = 'filler-refresh';

export async function registerFillerRefresh(boss: PgBoss, db: Db, client: FillerClient, log: Logger, timezone: string, afterRefresh: () => Promise<void>): Promise<void> {
  await boss.createQueue(QUEUE, { policy: 'singleton' });
  await boss.schedule(QUEUE, FILLER_CRON, {}, { tz: timezone });
  await boss.work(QUEUE, { batchSize: 1 }, async () => {
    try {
      if ((await refreshFiller(db, client, log)).fetched > 0) await afterRefresh();
    } catch (err) {
      // Filler marks are a nicety: a failed week keeps last week's lists and retries the next.
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'filler refresh failed');
    }
  });
  if ((await db.fillerList.count()) === 0) await boss.send(QUEUE, {}, { singletonKey: 'boot', startAfter: 300 });
  log.info({ cron: FILLER_CRON, timezone }, 'filler refresh scheduled');
}
