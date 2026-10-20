import { useEffect, useState } from 'react';
import { BackIcon, CheckIcon, EyeIcon, PinIcon } from '../../components/icons.js';
import { Poster, posterFor } from '../../components/Poster.js';
import { Button } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { audio, hours, se } from '../../lib/format.js';

interface Episode {
  crEpisodeId: string;
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
  pinned: boolean;
  watchedEpisodes: number;
  totalEpisodes: number;
  remainingS: number;
  next: null | { season: number | null; episode: number | null; title: string | null; audioLocale: string | null; watchUrl: string };
  episodes: Episode[];
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

export function Show({ showKey }: { showKey: string }) {
  const [show, setShow] = useState<ShowDetail | null>();
  const [season, setSeason] = useState<number>();
  useEffect(() => {
    void api<ShowDetail>(`/api/shows/${encodeURIComponent(showKey)}`).then(
      (s) => { setShow(s); setSeason(s.next?.season ?? s.episodes.at(-1)?.seasonNumber); },
      () => { setShow(null); },
    );
  }, [showKey]);

  if (show === undefined) return <main aria-busy="true" className="min-h-dvh bg-canvas" />;
  if (show === null) return <main className="p-6 text-muted">That show isn’t in your history.</main>;

  const seasons = [...new Set(show.episodes.map((e) => e.seasonNumber))];
  const pct = show.totalEpisodes > 0 ? Math.round((show.watchedEpisodes / show.totalEpisodes) * 100) : 0;
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
          <span className="rounded-full border border-shu px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] text-shu uppercase">{show.status.replace('_', ' ')}</span>
          <button type="button" onClick={togglePin} aria-pressed={show.pinned} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] uppercase ${show.pinned ? 'border-kin text-kin' : 'border-line-strong text-muted'}`}>
            <PinIcon /> {show.pinned ? 'Pinned' : 'Pin'}
          </button>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Show progress">
          <div className="h-full bg-kin" style={{ width: `${String(pct)}%` }} />
        </div>
        <p className="font-mono text-[12px] text-muted">
          {show.next !== null ? `${se(show.next.season, show.next.episode)} next · ` : ''}{pct}% · {show.totalEpisodes - show.watchedEpisodes} episodes ({hours(show.remainingS)}) left
        </p>
        {show.next !== null && (
          <a href={show.next.watchUrl} rel="noopener" className="inline-flex min-h-11 items-center justify-center rounded-full bg-shu px-5 text-[15px] font-bold text-on-accent">
            ▶ Watch {se(show.next.season, show.next.episode)}{show.next.audioLocale !== null ? ` (${audio(show.next.audioLocale)})` : ''}
          </a>
        )}
        {seasons.length > 1 && (
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Seasons">
            {seasons.map((s) => (
              <Button key={s} kind={s === season ? 'primary' : 'ghost'} role="tab" aria-selected={s === season} className="min-h-9 px-4" onClick={() => { setSeason(s); }}>
                S{s}
              </Button>
            ))}
          </div>
        )}
        <ol className="flex flex-col gap-1">
          {show.episodes.filter((e) => season === undefined || e.seasonNumber === season).map((e) => <EpisodeRow key={e.crEpisodeId} e={e} />)}
        </ol>
      </div>
    </main>
  );
}
