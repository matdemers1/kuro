import { useEffect, useState } from 'react';
import { BackIcon } from '../components/icons.js';
import { Poster, posterFor } from '../components/Poster.js';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { statusLabel } from '../lib/format.js';
import { navigate } from '../lib/router.js';

interface TimelineRow {
  entryId: string;
  title: string;
  type: string;
  episodes: number;
  year: number | null;
  status: string;
  kind: 'season' | 'extra' | 'related';
  label: string | null;
  showKey: string | null;
  showTitle: string | null;
  required: boolean;
  relation: string | null;
  watched: number | null;
  total: number | null;
}

interface FranchiseDetail {
  key: string;
  title: string;
  timeline?: TimelineRow[];
  shows: { showKey: string; title: string; year: number | null; seasons: number; extras: number; status: string | null; watchedEpisodes: number; totalEpisodes: number }[];
}

const RELATION: Record<string, string> = { SEQUEL: 'Sequel', PREQUEL: 'Prequel', SIDE_STORY: 'Side story', PARENT: 'Main story' };
const TYPE: Record<string, string> = { TV: 'TV', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special' };

/** The watch-order timeline (KURO-T-5.4): every part of every Show, and what the library is missing. */
function Timeline({ rows, multiShow }: { rows: readonly TimelineRow[]; multiShow: boolean }) {
  return (
    <section aria-labelledby="timeline" className="flex flex-col gap-2">
      <h2 id="timeline" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Watch order</h2>
      <ol className="flex flex-col">
        {rows.map((r, i) => {
          const done = r.watched !== null && r.total !== null && r.total > 0 && r.watched >= r.total;
          const started = r.watched !== null && r.watched > 0;
          const what = r.kind === 'related' ? `${RELATION[r.relation ?? ''] ?? 'Related'} · not in your library` : r.kind === 'extra' ? (r.required ? 'Extra' : 'Extra · optional') : (r.label ?? 'Season');
          const body = (
            <>
              <span aria-hidden="true" className="relative flex w-4 shrink-0 justify-center self-stretch">
                {i > 0 && <span className="absolute top-0 h-1/2 w-px bg-line-strong" />}
                {i < rows.length - 1 && <span className="absolute bottom-0 h-1/2 w-px bg-line-strong" />}
                <span className={`relative mt-[18px] h-2.5 w-2.5 rounded-full ${done ? 'bg-kin' : started ? 'border-2 border-kin bg-canvas' : r.kind === 'related' ? 'border border-dashed border-line-strong bg-canvas' : 'border border-line-strong bg-canvas'}`} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col py-2">
                <span className={`text-[11px] font-medium tracking-[0.6px] uppercase ${r.kind === 'extra' ? 'text-kin' : 'text-faint'}`}>
                  {what}{multiShow && r.showTitle !== null ? ` · ${r.showTitle}` : ''}
                </span>
                <span className={`text-[15px] ${r.kind === 'related' ? 'text-muted' : ''}`}>{r.title}</span>
                <span className="font-mono text-[12px] text-faint">
                  {[TYPE[r.type] ?? r.type, r.year, r.episodes > 1 ? `${String(r.episodes)} eps` : null, r.status === 'UPCOMING' ? 'upcoming' : r.status === 'ONGOING' ? 'airing' : null, r.watched !== null && r.total !== null ? (done ? 'watched' : `${String(r.watched)}/${String(r.total)} watched`) : null].filter((x) => x !== null).join(' · ')}
                </span>
              </span>
            </>
          );
          return (
            <li key={r.entryId}>
              {r.showKey !== null ? (
                <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(r.showKey ?? '')}`); }} className="flex w-full gap-3 rounded-[10px] px-1 text-left hover:bg-raised">{body}</button>
              ) : (
                <div className="flex gap-3 px-1">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A Franchise (KURO-T-2.8): its Shows in watch order, each with where the owner stands, then the timeline. */
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
      {(f.timeline?.length ?? 0) > 0 && <Timeline rows={f.timeline ?? []} multiShow={f.shows.length > 1} />}
    </Screen>
  );
}
