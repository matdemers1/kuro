import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui.js';
import { api } from '../lib/api.js';

export interface SyncState {
  plays: number;
  run: null | {
    kind: 'backfill' | 'delta';
    status: 'running' | 'succeeded' | 'failed';
    lastPage: number;
    pagesTotal: number | null;
    playsObserved: number;
    playsNew: number;
    error: string | null;
    finishedAt: string | null;
    derivedAt: string | null;
  };
}

/** The run is done for the owner only once its plays are matched and Up Next is rebuilt. */
const settling = (run: SyncState['run']) => run?.status === 'running' || (run?.status === 'succeeded' && run.derivedAt === null);

/**
 * Import progress (KURO-REQ-003) and Sync now (KURO-REQ-006). Polls while a run is active or its
 * plays are still being matched, and calls `onDerived` when a run's derived state lands.
 */
export function ImportProgress({ onDerived }: { onDerived?: () => void }) {
  const [state, setState] = useState<SyncState>();
  const [queued, setQueued] = useState(false);
  const lastDerived = useRef<string | null | undefined>(undefined);
  const derivedCallback = useRef(onDerived);
  useEffect(() => {
    derivedCallback.current = onDerived;
  }, [onDerived]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const next = await api<SyncState>('/api/sync').catch(() => undefined);
      if (stop || next === undefined) return;
      setState(next);
      const derived = next.run?.derivedAt ?? null;
      if (lastDerived.current !== undefined && derived !== null && derived !== lastDerived.current) derivedCallback.current?.();
      lastDerived.current = derived;
      if (settling(next.run) || queued) setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [queued]);

  const run = state?.run;
  const running = run?.status === 'running';
  const matching = run?.status === 'succeeded' && run.derivedAt === null;
  const pct = run?.pagesTotal ? Math.min(100, Math.round((run.lastPage / run.pagesTotal) * 100)) : null;

  return (
    <section aria-labelledby="import" className="flex flex-col gap-3 rounded-[16px] border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="import" className="text-[18px] font-bold">
          {run === null || run === undefined ? 'History' : run.kind === 'backfill' && running ? 'Importing your history' : 'Sync'}
        </h2>
        <Button kind="ghost" disabled={running || queued} onClick={() => { void api('/api/sync', { method: 'POST' }).then(() => { setQueued(true); setTimeout(() => { setQueued(false); }, 4000); }); }}>
          Sync now
        </Button>
      </div>
      {run !== null && run !== undefined && (
        <>
          <div className="h-1 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
            <div className="h-full bg-kin transition-[width]" style={{ width: `${String(pct ?? (running ? 15 : 100))}%` }} />
          </div>
          <p className="font-mono text-[12px] text-muted">
            {running ? `Page ${String(run.lastPage + 1)}${run.pagesTotal ? ` of ~${String(run.pagesTotal)}` : ''} · ` : ''}
            {matching ? 'Matching your shows · ' : ''}
            {String(state?.plays ?? 0)} plays in your vault
            {run.status === 'succeeded' && !matching && run.finishedAt !== null ? ` · last sync ${new Date(run.finishedAt).toLocaleString()}` : ''}
          </p>
          {run.status === 'succeeded' && run.error !== null && <p className="text-[13px] text-faint">{run.error}</p>}
          {run.status === 'failed' && <p role="alert" className="text-[13px] text-shu">Sync stopped: {run.error ?? 'unknown error'}. It resumes from where it stopped.</p>}
          {running && run.kind === 'backfill' && <p className="text-[13px] text-faint">Paced to stay gentle on Crunchyroll. Safe to close — it resumes from the last page.</p>}
        </>
      )}
    </section>
  );
}
