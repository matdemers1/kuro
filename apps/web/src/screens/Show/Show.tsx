import { useEffect, useState } from 'react';
import { BackIcon, CheckIcon, EyeIcon, PinIcon } from '../../components/icons.js';
import { Poster, posterFor } from '../../components/Poster.js';
import { Button } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { audio, hours, se, statusLabel } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';
import { GroupingEditor } from '../GroupingEditor/GroupingEditor.js';
import { DROP_REASON, DropChooser, NoteBox, RatingRow, SeasonScore } from './Taste.js';
import { AddToRewatch } from '../RewatchQueue.js';

interface Episode {
  crEpisodeId: string;
  seasonId: string | null;
  seasonNumber: number;
  episodeNumber: number | null;
  title: string;
  watched: boolean;
  lastWatchedAt: string | null;
  spoiler: boolean;
  isNext: boolean;
  watchUrl: string;
}

interface ShowDetail {
  showKey: string;
  title: string;
  description: string | null;
  status: string;
  /** The owner's own status, when set: plan_to_watch or dropped. */
  manualStatus?: string | null;
  dropReason?: string | null;
  rating?: number | null;
  seasonRatings?: Record<string, number>;
  note?: string | null;
  rewatches?: { startedAt: string; endedAt: string | null }[];
  inRewatchQueue?: boolean;
  pinned: boolean;
  watchedEpisodes: number;
  totalEpisodes: number;
  remainingS: number;
  /** Episodes out in the original but not yet in the owner's dub. */
  dubLag?: number;
  next: null | { season: number | null; episode: number | null; title: string | null; audioLocale: string | null; watchUrl: string };
  episodes: Episode[];
  items?: { entryId: string; kind: 'season' | 'extra'; required: boolean; title: string; type: string; episodes: number; year: number | null }[];
  extras?: Episode[];
  franchise?: { showKey: string; title: string }[];
  seriesIds?: string[];
}

/** One episode row; past your position the title stays hidden until tapped (KURO-REQ-018). */
function EpisodeRow({ e }: { e: Episode }) {
  const [revealed, setRevealed] = useState(false);
  const hidden = e.spoiler && !revealed;
  return (
    <li className={`flex items-center gap-3 rounded-[10px] px-3 py-2 ${e.isNext ? 'border border-shu bg-raised' : ''}`}>
      <span className={`w-8 font-mono text-[12px] ${e.watched ? 'text-faint' : 'text-muted'}`}>E{e.episodeNumber ?? '–'}</span>
      <div className="h-9 w-16 shrink-0 overflow-hidden rounded-[6px] bg-raised">
        {/* A thumbnail spoils as much as a title: past your position it stays hidden too. */}
        {!hidden && <img src={`/img/episode/${encodeURIComponent(e.crEpisodeId)}/thumb`} alt="" loading="lazy" className="h-full w-full object-cover" onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />}
      </div>
      <div className="min-w-0 flex-1">
        {hidden ? (
          <button type="button" onClick={() => { setRevealed(true); }} className="flex items-center gap-2 text-[15px] text-faint" aria-label={`Reveal episode ${String(e.episodeNumber ?? '')} title`}>
            <EyeIcon /> Tap to reveal
          </button>
        ) : (
          <a href={e.watchUrl} rel="noopener" className="block truncate text-[15px]">{e.title}</a>
        )}
        <p className="text-[13px] text-faint">{e.watched && e.lastWatchedAt !== null ? `Watched ${new Date(e.lastWatchedAt).toLocaleDateString()}` : e.isNext ? 'Up next' : hidden ? 'Spoiler-safe' : ''}</p>
      </div>
      {e.watched && <span className="text-ok"><CheckIcon /></span>}
    </li>
  );
}

const tabOf = (e: Episode) => e.seasonId ?? `S${String(e.seasonNumber)}`;

export function Show({ showKey }: { showKey: string }) {
  const [show, setShow] = useState<ShowDetail | null>();
  const [editing, setEditing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [reload, setReload] = useState(0);
  const [season, setSeason] = useState<string>();
  useEffect(() => {
    void api<ShowDetail>(`/api/shows/${encodeURIComponent(showKey)}`).then(
      (s) => {
        setShow(s);
        const next = s.episodes.find((e) => e.isNext) ?? s.episodes.at(-1);
        setSeason(next === undefined ? undefined : tabOf(next));
      },
      () => { setShow(null); },
    );
  }, [showKey, reload]);

  if (show === undefined) return <main aria-busy="true" className="min-h-dvh bg-canvas" />;
  if (show === null) return <main className="p-6 text-muted">That show isn’t in your history.</main>;

  // One tab per Crunchyroll season, in watch order. A Show made of several series can have two
  // "Season 1"s (Attack on Titan and its Final Season), so tabs are keyed by season, not number.
  const tabs = [...new Map(show.episodes.map((e) => [tabOf(e), e.seasonNumber])).entries()];
  const labels = new Map(tabs.map(([key, n], i) => [key, tabs.filter(([, m]) => m === n).length > 1 ? `S${String(n)} · ${String(i + 1)}` : `S${String(n)}`]));
  const pct = show.totalEpisodes > 0 ? Math.round((show.watchedEpisodes / show.totalEpisodes) * 100) : 0;
  const setStatus = (status: 'plan_to_watch' | 'dropped' | null, reason?: string) => {
    setDropping(false);
    void api(`/api/shows/${encodeURIComponent(showKey)}/status`, { method: 'PUT', body: { status, ...(reason === undefined ? {} : { reason }) } })
      .then(() => api<ShowDetail>(`/api/shows/${encodeURIComponent(showKey)}`))
      .then(setShow);
  };
  const rate = (path: string, score: number | null, apply: (s: ShowDetail) => ShowDetail) => {
    void api(`/api/shows/${encodeURIComponent(showKey)}${path}`, { method: 'PUT', body: { score } }).then(() => { setShow((cur) => (cur === null || cur === undefined ? cur : apply(cur))); });
  };
  const togglePin = () => {
    void api(`/api/shows/${encodeURIComponent(showKey)}/pin`, { method: 'PUT', body: { pinned: !show.pinned } }).then(() => { setShow({ ...show, pinned: !show.pinned }); });
  };

  return (
    <main className="mx-auto w-full max-w-2xl bg-canvas text-ink">
      <header className="relative flex min-h-[220px] flex-col justify-end gap-1 overflow-hidden px-4 pt-14 pb-5">
        <Poster title={show.title} src={posterFor(show.showKey)} className="absolute inset-0 rounded-none opacity-90" />
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/80 to-black/10" />
        <button type="button" onClick={() => { window.history.back(); }} className="absolute top-4 left-3 text-on-accent" aria-label="Back"><BackIcon /></button>
        <h1 className="relative font-display text-[28px] leading-[34px] font-bold text-on-accent">{show.title}</h1>
      </header>
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-shu px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] text-shu uppercase">{statusLabel(show.status)}</span>
          <button type="button" onClick={togglePin} aria-pressed={show.pinned} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] uppercase ${show.pinned ? 'border-kin text-kin' : 'border-line-strong text-muted'}`}>
            <PinIcon /> {show.pinned ? 'Pinned' : 'Pin'}
          </button>
          {/* Dropped and Plan to watch are the owner's alone; every other status is derived. */}
          {show.manualStatus !== 'dropped' && show.status !== 'completed' && (
            <button type="button" onClick={() => { setDropping(true); }} className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] text-muted uppercase">Drop</button>
          )}
          {show.manualStatus !== 'plan_to_watch' && show.watchedEpisodes === 0 && (
            <button type="button" onClick={() => { setStatus('plan_to_watch'); }} className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] text-muted uppercase">Plan to watch</button>
          )}
          {show.manualStatus !== null && show.manualStatus !== undefined && (
            <button type="button" onClick={() => { setStatus(null); }} className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] text-muted uppercase">Back to automatic</button>
          )}
        </div>
        {dropping && <DropChooser onDrop={(reason) => { setStatus('dropped', reason); }} onCancel={() => { setDropping(false); }} />}
        {show.status === 'dropped' && show.dropReason !== null && show.dropReason !== undefined && (
          <p className="text-[13px] text-faint">Dropped — {DROP_REASON[show.dropReason] ?? show.dropReason}.</p>
        )}
        <div className="h-1 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Show progress">
          <div className="h-full bg-kin" style={{ width: `${String(pct)}%` }} />
        </div>
        <p className="font-mono text-[12px] text-muted">
          {show.next !== null ? `${se(show.next.season, show.next.episode)} next · ` : ''}{pct}% · {show.totalEpisodes - show.watchedEpisodes} episodes ({hours(show.remainingS)}) left
        </p>
        {(show.dubLag ?? 0) > 0 && (
          <p className="self-start rounded-full border border-info px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] text-info uppercase" role="status">
            Dub {show.dubLag} behind{show.status === 'caught_up' ? ' — waiting on the dub' : ''}
          </p>
        )}
        {show.next !== null && (
          <a href={show.next.watchUrl} rel="noopener" className="inline-flex min-h-11 items-center justify-center rounded-full bg-shu px-5 text-[15px] font-bold text-on-accent">
            ▶ Watch {se(show.next.season, show.next.episode)}{show.next.audioLocale !== null ? ` (${audio(show.next.audioLocale)})` : ''}
          </a>
        )}
        {(show.items?.length ?? 0) > 0 && (
          <section aria-labelledby="parts" className="flex flex-col gap-2">
            <h2 id="parts" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Seasons &amp; extras</h2>
            <ol className="flex flex-col gap-1">
              {show.items?.map((it) => (
                <li key={it.entryId} className="flex items-baseline gap-2 text-[15px]">
                  <span className={`w-14 shrink-0 text-[11px] font-medium tracking-[0.6px] uppercase ${it.kind === 'extra' ? 'text-kin' : 'text-muted'}`}>{it.kind === 'extra' ? 'Extra' : 'Season'}</span>
                  <span className="min-w-0 flex-1">{it.title}</span>
                  <span className="shrink-0 font-mono text-[12px] text-faint">{[it.type === 'TV' ? null : it.type.toLowerCase(), it.episodes > 1 ? `${String(it.episodes)} eps` : null, it.year].filter((x) => x !== null).join(' · ')}{it.kind === 'extra' && !it.required ? ' · optional' : ''}</span>
                  {it.kind === 'season' && (
                    <SeasonScore
                      title={it.title}
                      score={show.seasonRatings?.[it.entryId] ?? null}
                      onRate={(score) => {
                        rate(`/seasons/${encodeURIComponent(it.entryId)}/rating`, score, (cur) => ({
                          ...cur,
                          seasonRatings: Object.fromEntries([...Object.entries(cur.seasonRatings ?? {}).filter(([k]) => k !== it.entryId), ...(score === null ? [] : [[it.entryId, score] as const])]),
                        }));
                      }}
                    />
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
        {(show.rewatches?.length ?? 0) > 0 && (
          <p className="text-[13px] text-faint">
            Rewatched {show.rewatches?.filter((r) => r.endedAt !== null).length ?? 0}×{show.rewatches?.some((r) => r.endedAt === null) === true ? ' · rewatching now' : ''}
          </p>
        )}
        {show.inRewatchQueue === true ? (
          <button type="button" onClick={() => { navigate('/you'); }} className="self-start text-[13px] text-kin">In your rewatch queue →</button>
        ) : (
          (show.status === 'completed' || show.status === 'caught_up' || show.status === 'paused') && (
            <AddToRewatch showKey={show.showKey} seasons={(show.items ?? []).filter((i) => i.kind === 'season').map((i) => ({ entryId: i.entryId, title: i.title }))} onAdded={() => { setReload((n) => n + 1); }} />
          )
        )}
        <RatingRow label="Your rating" score={show.rating ?? null} onRate={(score) => { rate('/rating', score, (cur) => ({ ...cur, rating: score })); }} />
        <NoteBox key={show.showKey} showKey={show.showKey} initial={show.note ?? null} />
        {(show.items?.length ?? 0) > 0 && !editing && (
          <Button kind="ghost" className="self-start" onClick={() => { setEditing(true); }}>Edit grouping</Button>
        )}
        {editing && (
          <GroupingEditor
            showKey={show.showKey}
            seriesIds={show.seriesIds ?? []}
            items={show.items ?? []}
            onChanged={(key) => {
              if (key !== showKey) navigate(`/show/${encodeURIComponent(key)}`);
              else setReload((n) => n + 1);
            }}
          />
        )}
        {tabs.length > 1 && (
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Seasons">
            {tabs.map(([key]) => (
              <Button key={key} kind={key === season ? 'primary' : 'ghost'} role="tab" aria-selected={key === season} className="min-h-9 px-4" onClick={() => { setSeason(key); }}>
                {labels.get(key)}
              </Button>
            ))}
          </div>
        )}
        <ol className="flex flex-col gap-1">
          {show.episodes.filter((e) => season === undefined || tabOf(e) === season).map((e) => <EpisodeRow key={e.crEpisodeId} e={e} />)}
        </ol>
        {(show.extras?.length ?? 0) > 0 && (
          <section aria-labelledby="extras" className="flex flex-col gap-1">
            <h2 id="extras" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Extras — optional, never needed for Completed</h2>
            <ol className="flex flex-col gap-1">{show.extras?.map((e) => <EpisodeRow key={e.crEpisodeId} e={e} />)}</ol>
          </section>
        )}
        {(show.franchise?.length ?? 0) > 0 && (
          <section aria-labelledby="franchise" className="flex flex-col gap-2">
            <h2 id="franchise" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Also in this franchise</h2>
            <div className="flex flex-wrap gap-2">
              {show.franchise?.map((f) => (
                <button key={f.showKey} type="button" onClick={() => { navigate(`/show/${encodeURIComponent(f.showKey)}`); }} className="rounded-full border border-line-strong px-3 py-1 text-[13px] text-muted">{f.title}</button>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
