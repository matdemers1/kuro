import { useEffect, useState } from 'react';
import { Poster } from '../components/Poster.js';
import { Button, Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { statusLabel } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { RatingRow } from './Show/Taste.js';

export interface Rec {
  entryId: string;
  title: string;
  type: string;
  episodes: number;
  season: string | null;
  seasonYear: number | null;
  status: string;
  because: { term: string; label: string }[];
  like: { showKey: string; title: string } | null;
}

interface ToRate {
  showKey: string;
  title: string;
  status: string;
  watchedEpisodes: number;
}

interface DiscoverData {
  state: 'ready' | 'cold';
  needed?: number;
  items: Rec[];
  toRate: ToRate[];
}

const SEASON: Record<string, string> = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };

/** "Fall 2026 · TV · 12 eps · airing" */
export function recMeta(r: Rec): string {
  return [
    r.seasonYear === null ? null : `${r.season === null ? '' : `${SEASON[r.season] ?? ''} `}${String(r.seasonYear)}`,
    r.type,
    r.episodes > 0 ? `${String(r.episodes)} eps` : null,
    r.status === 'ONGOING' ? 'airing' : r.status === 'UPCOMING' ? 'upcoming' : null,
  ].filter((x) => x !== null).join(' · ');
}

/** One recommendation: what it is, why, and Not interested. */
export function RecCard({ rec, onDismiss }: { rec: Rec; onDismiss: (entryId: string) => void }) {
  return (
    <li className="flex gap-3 rounded-[16px] border border-line bg-surface p-2">
      <Poster title={rec.title} src={`/img/catalog/${encodeURIComponent(rec.entryId)}`} className="h-[96px] w-[68px] shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] leading-5 font-bold">{rec.title}</span>
        <span className="font-mono text-[12px] text-faint">{recMeta(rec)}</span>
        <p className="text-[13px] text-muted">
          {rec.because.length > 0 && <>Because you like {rec.because.map((b) => b.label).join(', ')}</>}
          {rec.like !== null && (
            <>
              {rec.because.length > 0 ? ' — ' : 'Because '}like{' '}
              <button type="button" className="text-left underline" onClick={() => { navigate(`/show/${encodeURIComponent(rec.like?.showKey ?? '')}`); }}>{rec.like.title}</button>
            </>
          )}
        </p>
        <Button kind="ghost" className="mt-auto min-h-9 self-start px-3 text-[13px]" onClick={() => { onDismiss(rec.entryId); }} aria-label={`Not interested in ${rec.title}`}>
          Not interested
        </Button>
      </div>
    </li>
  );
}

/** Not interested, with the one-tap undo the change log keeps for it. */
export function useDismiss(after: () => void) {
  const [dismissed, setDismissed] = useState<{ entryId: string; title: string } | null>(null);
  const dismiss = (rec: Rec) => {
    void api(`/api/discover/${encodeURIComponent(rec.entryId)}/interest`, { method: 'PUT', body: { interested: false } }).then(() => {
      setDismissed({ entryId: rec.entryId, title: rec.title });
      after();
    });
  };
  const undo = () => {
    if (dismissed === null) return;
    void api(`/api/discover/${encodeURIComponent(dismissed.entryId)}/interest`, { method: 'PUT', body: { interested: true } }).then(() => {
      setDismissed(null);
      after();
    });
  };
  const notice =
    dismissed === null ? null : (
      <div role="status" className="flex items-center justify-between gap-2 rounded-[10px] border border-line-strong px-3 py-2 text-[13px] text-muted">
        <span>Hid {dismissed.title}; shows like it now rank lower.</span>
        <Button kind="ghost" className="min-h-8 px-3 text-[13px]" onClick={undo}>Undo</Button>
      </div>
    );
  return { dismiss, notice };
}

/**
 * Discover (KURO-REQ-045/046, KURO-T-4.4): catalog Shows the owner has not seen, ranked by the tags
 * and studios they share with what the owner rated well or finished, each saying why. Until there are
 * a few ratings or finished Shows, it asks for ratings instead.
 */
export function Discover() {
  const [data, setData] = useState<DiscoverData | null>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void api<DiscoverData>('/api/discover').then(setData, () => { setData(null); });
  }, [version]);
  const reload = () => { setVersion((v) => v + 1); };
  const byId = new Map((data?.items ?? []).map((r) => [r.entryId, r]));
  const { dismiss, notice } = useDismiss(reload);

  return (
    <Screen kicker="For you" title="Discover" wide>
      {data === undefined && <div aria-busy="true" className="h-40 animate-pulse rounded-[16px] bg-raised" />}
      {data === null && <p className="text-[15px] text-muted">Recommendations could not load. Try again in a moment.</p>}
      {data?.state === 'cold' && <RateAFew shows={data.toRate} needed={data.needed ?? 1} onRated={reload} />}
      {data?.state === 'ready' && (
        <>
          <p className="text-[13px] text-muted">
            From the tags and studios of the shows you rated well or finished.{' '}
            <button type="button" className="underline" onClick={() => { navigate('/you/taste'); }}>Tune your taste</button>
          </p>
          {notice}
          {data.items.length === 0 ? (
            <p className="text-[15px] text-muted">Nothing new to suggest — you have seen everything like what you love.</p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {data.items.map((r) => <RecCard key={r.entryId} rec={r} onDismiss={(id) => { const rec = byId.get(id); if (rec !== undefined) dismiss(rec); }} />)}
            </ul>
          )}
        </>
      )}
    </Screen>
  );
}

/** The cold start: "Rate a few shows to tune this", with the owner's most-watched Shows to rate in place. */
function RateAFew({ shows, needed, onRated }: { shows: readonly ToRate[]; needed: number; onRated: () => void }) {
  const [scores, setScores] = useState<Record<string, number | null>>({});
  const rate = (key: string, score: number | null) => {
    setScores((s) => ({ ...s, [key]: score }));
    void api(`/api/shows/${encodeURIComponent(key)}/rating`, { method: 'PUT', body: { score } });
  };
  const rated = Object.values(scores).filter((s) => s !== null).length;
  return (
    <section aria-labelledby="rate-a-few" className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <p className="font-display text-[40px] text-faint">好</p>
        <h2 id="rate-a-few" className="text-[18px] font-bold">Rate a few shows to tune this</h2>
        <p className="text-[15px] text-muted">
          Recommendations come from what you rate well or finish. {needed === 1 ? 'One more rating' : `${String(needed)} more ratings`} and Discover fills in.
        </p>
      </div>
      {shows.length === 0 ? (
        <p className="text-center text-[13px] text-faint">Watch a few episodes on Crunchyroll first — your shows appear here after a sync.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shows.map((s) => (
            <li key={s.showKey} className="flex flex-col gap-1 rounded-[16px] border border-line bg-surface p-3">
              <span className="text-[15px] font-bold">{s.title}</span>
              <span className="font-mono text-[12px] text-faint">{statusLabel(s.status)} · {s.watchedEpisodes} watched</span>
              <RatingRow label={`Rate ${s.title}`} score={scores[s.showKey] ?? null} onRate={(n) => { rate(s.showKey, n); }} />
            </li>
          ))}
        </ul>
      )}
      <Button className="self-center" disabled={rated === 0} onClick={onRated}>Show my recommendations</Button>
    </section>
  );
}
