import PgBoss from 'pg-boss';
import type { Logger } from '../logger.js';
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

interface SyncJob {
  userId: string;
  kind: SyncKind;
}

export async function startPgBossQueue(databaseUrl: string, deps: SyncDeps, log: Logger): Promise<SyncQueue> {
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
  });
  // A backfill that was mid-run when the process stopped resumes on the next boot.
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
