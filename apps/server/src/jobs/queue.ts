import PgBoss from 'pg-boss';
import type { Logger } from '../logger.js';
import { resolveCatalog, resolveMarkers } from '../cr/resolve.js';
import { rebuildShows } from '../derive/rebuild.js';
import { matchCatalog } from '../match/run.js';
import type { Alerts } from '../push/sender.js';
import { checkAlerts } from './alertsCheck.js';
import { registerCatalogImport } from './catalogImport.js';
import type { CatalogSource } from '../catalog/source.js';
import { runSync, type SyncDeps, type SyncKind } from '../sync/run.js';

/**
 * Where sync work goes (KURO-D-044: jobs on Postgres, in the server process, no Redis). The
 * `sync_run` row is the checkpoint; the queue only decides *when* a run happens and that two never
 * overlap. Tests use the inline queue, which runs at once.
 */
export interface SyncQueue {
  request(userId: string, kind: SyncKind | 'derive' | 'match'): Promise<void>;
  stop(): Promise<void>;
}

const QUEUE = 'cr-sync';
const NIGHTLY = 'cr-sync-nightly';
const ALERTS = 'alerts-check';

/** 03:00 in the owner's time zone (KURO-REQ-005). */
export const NIGHTLY_CRON = '0 3 * * *';

interface SyncJob {
  userId: string;
  /**
   * `derive` finishes what a sync started — matching and Up Next — without syncing again; `match`
   * re-runs only the matcher and derivation, after a catalog import.
   */
  kind: SyncKind | 'derive' | 'match';
}

/**
 * After a sync: what the new plays point at, then derived state, then credits markers and derived
 * state again. Up Next is rebuilt before the marker pass because there is one marker per watched
 * episode — thousands after a first import — and markers only refine what counts as watched.
 */
export async function afterSync(deps: SyncDeps, userId: string, runId: string, log: Logger): Promise<void> {
  await resolveCatalog(deps, userId).catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'catalog resolve failed; it retries after the next sync');
  });
  if (deps.anilist !== undefined) {
    await matchCatalog({ db: deps.db, anilist: deps.anilist, log }, userId).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'matching failed; it retries after the next sync');
    });
  }
  let shows = await rebuildShows(deps.db, userId);
  await deps.db.syncRun.update({ where: { id: runId }, data: { derivedAt: new Date() } });
  log.info({ shows }, 'derived state rebuilt');
  const { checked } = await resolveMarkers(deps, userId).catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'credits markers failed; they retry after the next sync');
    return { checked: 0 };
  });
  if (checked > 0) {
    shows = await rebuildShows(deps.db, userId);
    log.info({ shows }, 'derived state rebuilt with credits markers');
  }
}

export async function startPgBossQueue(databaseUrl: string, deps: SyncDeps, log: Logger, timezone = 'America/New_York', alerts?: Alerts, catalog?: CatalogSource): Promise<SyncQueue> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err: unknown) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'job queue error');
  });
  await boss.start();
  // One run at a time: two syncs racing over one refresh token would invalidate each other.
  await boss.createQueue(QUEUE, { policy: 'singleton' });
  await boss.work<SyncJob>(QUEUE, { batchSize: 1 }, async ([job]) => {
    if (job === undefined) return;
    const { userId, kind } = job.data;
    if (kind === 'match') {
      if (deps.anilist !== undefined) await matchCatalog({ db: deps.db, anilist: deps.anilist, log }, userId);
      log.info({ shows: await rebuildShows(deps.db, userId) }, 'derived state rebuilt after matching');
      return;
    }
    if (kind === 'derive') {
      const run = await deps.db.syncRun.findFirst({ where: { crConnection: { userId }, status: 'succeeded' }, orderBy: { startedAt: 'desc' } });
      if (run !== null) await afterSync(deps, userId, run.id, log);
      return;
    }
    const outcome = await runSync(deps, userId, kind);
    log.info({ kind, status: outcome.status }, 'sync job finished');
    if (outcome.status === 'succeeded') await afterSync(deps, userId, outcome.runId, log);
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
  if (catalog !== undefined) {
    // A new catalog release can retire entries and add better ones: match again after each import.
    await registerCatalogImport(boss, deps.db, catalog, log, timezone, async () => {
      for (const { userId } of await deps.db.crConnection.findMany({ select: { userId: true } })) await boss.send(QUEUE, { userId, kind: 'match' } satisfies SyncJob, { singletonKey: userId });
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
      if (kind === 'backfill' || kind === 'delta') done.push(runSync(deps, userId, kind));
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
}

/**
 * At boot: resume an interrupted backfill, and finish a derivation a restart cut short — so a deploy
 * mid-import strands neither the history nor Up Next.
 */
export async function resumeInterrupted(deps: SyncDeps, queue: SyncQueue): Promise<void> {
  const stuck = await deps.db.syncRun.findMany({ where: { status: 'running', kind: 'backfill' }, include: { crConnection: { select: { userId: true } } } });
  for (const run of stuck) await queue.request(run.crConnection.userId, 'backfill');
  for (const conn of await deps.db.crConnection.findMany({ select: { id: true, userId: true } })) {
    if (stuck.some((r) => r.crConnectionId === conn.id)) continue;
    const last = await deps.db.syncRun.findFirst({ where: { crConnectionId: conn.id, status: 'succeeded' }, orderBy: { startedAt: 'desc' } });
    if (last !== null && last.derivedAt === null) await queue.request(conn.userId, 'derive');
  }
}

/** What the nightly run queues: one run per linked connection that is not waiting on a re-link. */
export async function nightlyPlan(deps: Pick<SyncDeps, 'db'>): Promise<{ userId: string; kind: SyncKind }[]> {
  const conns = await deps.db.crConnection.findMany({ where: { state: { not: 'paused' } }, select: { userId: true, lastSuccessAt: true } });
  return conns.map((c) => ({ userId: c.userId, kind: c.lastSuccessAt === null ? 'backfill' : 'delta' }));
}
