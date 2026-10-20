import { useEffect, useState } from 'react';
import { BackIcon } from '../components/icons.js';
import { Poster, posterFor } from '../components/Poster.js';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { statusLabel } from '../lib/format.js';
import { navigate } from '../lib/router.js';

interface FranchiseDetail {
  key: string;
  title: string;
  shows: { showKey: string; title: string; year: number | null; seasons: number; extras: number; status: string | null; watchedEpisodes: number; totalEpisodes: number }[];
}

/** A Franchise (KURO-T-2.8): its Shows in watch order, each with where the owner stands. */
export function Franchise({ franchiseKey }: { franchiseKey: string }) {
  const [f, setF] = useState<FranchiseDetail | null>();
  useEffect(() => {
    void api<FranchiseDetail>(`/api/franchises/${encodeURIComponent(franchiseKey)}`).then(setF, () => { setF(null); });
  }, [franchiseKey]);

  if (f === undefined) return <Screen kicker="Franchise" title=" "><div aria-busy="true" className="h-40 animate-pulse rounded-[16px] bg-raised" /></Screen>;
  if (f === null) return <Screen kicker="Franchise" title="Not found"><p className="text-[15px] text-muted">That franchise isn’t in your history.</p></Screen>;

  return (
    <Screen kicker={`Franchise · ${String(f.shows.length)} shows`} title={f.title}>
      <button type="button" onClick={() => { window.history.back(); }} className="flex items-center gap-1 self-start text-[13px] text-muted" aria-label="Back"><BackIcon /> Back</button>
      <ol className="flex flex-col gap-3">
        {f.shows.map((s, i) => {
          const pct = s.totalEpisodes > 0 ? Math.round((s.watchedEpisodes / s.totalEpisodes) * 100) : 0;
          return (
            <li key={s.showKey}>
              <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(s.showKey)}`); }} className="flex w-full items-center gap-3 rounded-[16px] border border-line bg-surface p-3 text-left">
                <span className="w-5 shrink-0 font-mono text-[12px] text-faint">{i + 1}</span>
                <Poster title={s.title} src={posterFor(s.showKey)} className="h-[84px] w-[60px] shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[16px] leading-5 font-bold">{s.title}</span>
                  <span className="font-mono text-[12px] text-faint">
                    {[s.year, s.seasons > 0 ? `${String(s.seasons)} season${s.seasons === 1 ? '' : 's'}` : null, s.extras > 0 ? `${String(s.extras)} extra${s.extras === 1 ? '' : 's'}` : null].filter((x) => x !== null).join(' · ')}
                  </span>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${String(pct)}% of ${s.title} watched`}>
                    <div className="h-full bg-kin" style={{ width: `${String(pct)}%` }} />
                  </div>
                  <span className="text-[13px] text-muted">{s.status === null ? 'Not started' : statusLabel(s.status)} · {s.watchedEpisodes}/{s.totalEpisodes}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </Screen>
  );
}
