import { useEffect, useState } from 'react';
import { Poster, posterFor } from '../components/Poster.js';
import { RecCard, useDismiss, type Rec } from './Discover.js';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { statusLabel } from '../lib/format.js';
import { navigate } from '../lib/router.js';

interface SeasonItem {
  title: string;
  episodeNumber: number | null;
  episodes: number | null;
  episodeDate: string | null;
  delayedUntil: string | null;
  showKey: string | null;
  status: string | null;
}

interface ThisSeasonData {
  source: 'animeschedule' | 'crunchyroll';
  week: { label: string; start: string; end: string };
  dubs: SeasonItem[];
  subs: SeasonItem[];
  missing: { showKey: string; title: string }[];
  picks: { season: string; year: number; byFit: boolean; items: Rec[] };
  credit: { name: string; url: string } | null;
}

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const SEASON_NAME: Record<string, string> = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };

/**
 * This Season (KURO-REQ-036, KURO-T-3.2): what lands this week, dubs first and the shows you are
 * watching on top; sub-only second. Credited to AnimeSchedule.net when its timetable is the source.
 * Then the season's picks (KURO-REQ-047, KURO-T-4.5): new Shows this season, best fit first.
 */
export function ThisSeason() {
  const [data, setData] = useState<ThisSeasonData | null>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void api<ThisSeasonData>('/api/this-season').then(setData, () => { setData(null); });
  }, [version]);
  const { dismiss, notice } = useDismiss(() => { setVersion((v) => v + 1); });

  return (
    <Screen kicker={data === undefined || data === null ? 'This week' : `Week ${data.week.label.split('-W')[1] ?? ''}`} title="This Season" wide>
      {data === undefined && <div aria-busy="true" className="h-40 animate-pulse rounded-[16px] bg-raised" />}
      {data === null && <p className="text-[15px] text-muted">This week’s schedule could not load. Try again in a moment.</p>}
      {data !== undefined && data !== null && (
        <>
          <section aria-labelledby="dubs" className="flex flex-col gap-3">
            <h2 id="dubs" className="text-[11px] font-medium tracking-[0.6px] text-shu uppercase">Dubs landing this week</h2>
            {data.dubs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <p className="font-display text-[40px] text-faint">季</p>
                <p className="text-[18px] font-bold">No dubs this week</p>
                <p className="text-[15px] text-muted">{data.source === 'crunchyroll' ? 'None of your shows got a new dub episode on Crunchyroll this week.' : 'Nothing is dubbing this week.'}</p>
              </div>
            ) : (
              <SeasonList items={data.dubs} />
            )}
          </section>
          {data.subs.length > 0 && (
            <section aria-labelledby="subs" className="flex flex-col gap-3">
              <h2 id="subs" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Sub only this week</h2>
              <SeasonList items={data.subs} />
            </section>
          )}
          {data.picks.items.length > 0 && (
            <section aria-labelledby="picks" className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 id="picks" className="text-[11px] font-medium tracking-[0.6px] text-kin uppercase">
                  {data.picks.byFit ? 'Picked for you' : 'New'} · {SEASON_NAME[data.picks.season] ?? ''} {data.picks.year}
                </h2>
                <button type="button" className="text-[13px] text-muted underline" onClick={() => { navigate('/discover'); }}>Discover more</button>
              </div>
              {!data.picks.byFit && <p className="text-[13px] text-muted">By score for now — rate a few shows and these sort by your taste.</p>}
              {notice}
              <ul className="grid gap-2 md:grid-cols-2">
                {data.picks.items.map((r) => <RecCard key={r.entryId} rec={r} onDismiss={() => { dismiss(r); }} />)}
              </ul>
            </section>
          )}
          {data.missing.length > 0 && (
            <details className="rounded-[10px] border border-line px-3 py-2">
              <summary className="cursor-pointer text-[13px] text-muted">{data.missing.length} of your airing shows aren’t in the schedule</summary>
              <ul className="mt-2 flex flex-col gap-1 text-[13px] text-faint">{data.missing.map((m) => <li key={m.showKey}>{m.title}</li>)}</ul>
            </details>
          )}
          <p className="text-[12px] text-faint">
            {data.credit !== null ? (
              <>Schedule from <a className="underline" href={data.credit.url} rel="noopener">{data.credit.name}</a>.</>
            ) : (
              'From the episodes your shows released on Crunchyroll this week. A full dub schedule needs an AnimeSchedule.net token.'
            )}
          </p>
        </>
      )}
    </Screen>
  );
}

function SeasonList({ items }: { items: readonly SeasonItem[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it, i) => {
        const mine = it.showKey !== null;
        const body = (
          <>
            <Poster title={it.title} src={it.showKey === null ? undefined : posterFor(it.showKey)} className="h-[60px] w-[42px] shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] leading-5 font-bold">{it.title}</span>
              <span className="font-mono text-[12px] text-faint">
                {[it.episodeNumber === null ? null : `E${String(it.episodeNumber)}${it.episodes !== null && it.episodes > 0 ? `/${String(it.episodes)}` : ''}`, it.episodeDate === null ? null : DAY.format(new Date(it.episodeDate)), it.delayedUntil !== null ? 'delayed' : null].filter((x) => x !== null).join(' · ')}
              </span>
            </div>
            {mine && it.status !== null && <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-muted">{statusLabel(it.status)}</span>}
          </>
        );
        return (
          <li key={`${it.title}-${String(it.episodeNumber)}-${String(i)}`}>
            {mine ? (
              <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(it.showKey ?? '')}`); }} className={`flex w-full items-center gap-3 rounded-[16px] border p-2 text-left ${ACTIVE.has(it.status ?? '') ? 'border-shu bg-surface' : 'border-line bg-surface'}`}>{body}</button>
            ) : (
              <div className="flex items-center gap-3 rounded-[16px] border border-line p-2 opacity-80">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const ACTIVE = new Set(['watching', 'caught_up', 'rewatching']);
