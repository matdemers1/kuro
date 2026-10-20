import PgBoss from 'pg-boss';
import type { Logger } from '../logger.js';
import { resolveCatalog } from '../cr/resolve.js';
import { rebuildShows } from '../derive/rebuild.js';
import type { Alerts } from '../push/sender.js';
import { checkAlerts } from './alertsCheck.js';
import { runSync, type SyncDeps, type SyncKind } from '../sync/run.js';

/**
 * Where sync work goes (KURO-D-044: jobs on Postgres, in the server process, no Redis). The
 * `sync_run` row is the checkpoint; the queue only decides *when* a run happens and that two never
 * overlap. Tests use the inline queue, which runs at once.
 */
export interface SyncQueue {
  request(userId: string, kind: SyncKind): Promise<void>;
  stop(): Promise<void>;
}

const QUEUE = 'cr-sync';
const NIGHTLY = 'cr-sync-nightly';
const ALERTS = 'alerts-check';

/** 03:00 in the owner's time zone (KURO-REQ-005). */
export const NIGHTLY_CRON = '0 3 * * *';

interface SyncJob {
  userId: string;
  kind: SyncKind;
}

export async function startPgBossQueue(databaseUrl: string, deps: SyncDeps, log: Logger, timezone = 'America/New_York', alerts?: Alerts): Promise<SyncQueue> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err: unknown) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'job queue error');
  });
  await boss.start();
  // One run at a time: two syncs racing over one refresh token would invalidate each other.
  await boss.createQueue(QUEUE, { policy: 'singleton' });
  await boss.work<SyncJob>(QUEUE, { batchSize: 1 }, async ([job]) => {
    if (job === undefined) return;
    const outcome = await runSync(deps, job.data.userId, job.data.kind);
    log.info({ kind: job.data.kind, status: outcome.status }, 'sync job finished');
    // What the new plays point at: series, seasons, episodes, dub folding and credits markers.
    if (outcome.status === 'succeeded') {
      await resolveCatalog(deps, job.data.userId).catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'catalog resolve failed; it retries after the next sync');
      });
      const shows = await rebuildShows(deps.db, job.data.userId);
      await deps.db.syncRun.update({ where: { id: outcome.runId }, data: { derivedAt: new Date() } });
      log.info({ shows }, 'derived state rebuilt');
    }
  });
  // Nightly: a delta for every linked owner — or the backfill, if one has never finished.
  await boss.createQueue(NIGHTLY);
  await boss.schedule(NIGHTLY, NIGHTLY_CRON, {}, { tz: timezone });
  await boss.work(NIGHTLY, { batchSize: 1 }, async () => {
    for (const { userId, kind } of await nightlyPlan(deps)) {
      await boss.send(QUEUE, { userId, kind } satisfies SyncJob, { singletonKey: userId, retryLimit: 0 });
    }
  });
  log.info({ cron: NIGHTLY_CRON, timezone }, 'nightly sync scheduled');
  // Hourly: session expired, blocked twice, stale over 36 hours (KURO-REQ-007..009).
  if (alerts !== undefined) {
    await boss.createQueue(ALERTS);
    await boss.schedule(ALERTS, '17 * * * *', {}, { tz: timezone });
    await boss.work(ALERTS, { batchSize: 1 }, async () => {
      await checkAlerts(deps.db, alerts);
    });
  }
  return {
    async request(userId, kind) {
      await boss.send(QUEUE, { userId, kind } satisfies SyncJob, { singletonKey: userId, retryLimit: 0 });
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}

export function inlineQueue(deps: SyncDeps): SyncQueue & { readonly done: Promise<unknown>[] } {
  const done: Promise<unknown>[] = [];
  return {
    done,
    request(userId, kind) {
      done.push(runSync(deps, userId, kind));
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
}

/** Resume an interrupted backfill at boot, so a deploy mid-import does not strand it. */
export async function resumeInterrupted(deps: SyncDeps, queue: SyncQueue): Promise<void> {
  const stuck = await deps.db.syncRun.findMany({ where: { status: 'running', kind: 'backfill' }, include: { crConnection: { select: { userId: true } } } });
  for (const run of stuck) await queue.request(run.crConnection.userId, 'backfill');
}

/** What the nightly run queues: one run per linked connection that is not waiting on a re-link. */
export async function nightlyPlan(deps: Pick<SyncDeps, 'db'>): Promise<{ userId: string; kind: SyncKind }[]> {
  const conns = await deps.db.crConnection.findMany({ where: { state: { not: 'paused' } }, select: { userId: true, lastSuccessAt: true } });
  return conns.map((c) => ({ userId: c.userId, kind: c.lastSuccessAt === null ? 'backfill' : 'delta' }));
}
