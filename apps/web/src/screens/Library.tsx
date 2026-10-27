import { useEffect, useState } from 'react';
import { Poster, posterFor } from '../components/Poster.js';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { statusLabel } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { useReviewCount } from './Review/Review.js';

export interface ShowRow {
  showKey: string;
  title: string;
  status: string;
  watchedEpisodes: number;
  totalEpisodes: number;
  pinned: boolean;
  franchiseKey: string;
  franchiseTitle: string;
}

const FILTERS = ['all', 'watching', 'rewatching', 'caught_up', 'paused', 'plan_to_watch', 'completed', 'dropped'] as const;

/** Folded for search: case and accents never stand between the owner and a title. */
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The Library (KURO-REQ-035, KURO-T-2.8): every Show, filtered by status and searched by title, and
 * grouped under its Franchise when the Franchise holds more than one.
 */
export function Library() {
  const [shows, setShows] = useState<ShowRow[]>();
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [query, setQuery] = useState('');
  const toReview = useReviewCount();
  useEffect(() => {
    void api<{ items: ShowRow[] }>('/api/shows').then((r) => { setShows(r.items); }, () => { setFailed(true); setShows([]); });
  }, []);

  const q = fold(query.trim());
  const visible = (shows ?? []).filter((s) => (filter === 'all' || s.status === filter) && (q === '' || fold(s.title).includes(q) || fold(s.franchiseTitle).includes(q)));
  // Franchises in title order; a Franchise of one Show is just that Show.
  const groups = [...visible.reduce((m, s) => m.set(s.franchiseKey, [...(m.get(s.franchiseKey) ?? []), s]), new Map<string, ShowRow[]>()).entries()]
    .map(([key, list]) => ({ key, title: list[0]?.franchiseTitle ?? '', shows: list, size: (shows ?? []).filter((s) => s.franchiseKey === key).length }))
    .sort((a, b) => a.title.localeCompare(b.title));

  return (
    <Screen kicker={shows === undefined ? 'Library' : `${String(shows.length)} shows`} title="Library" wide="full">
      {toReview !== undefined && toReview > 0 && (
        <button type="button" onClick={() => { navigate('/review'); }} className="self-start rounded-full border border-kin px-3 py-1 text-[13px] text-kin">
          {toReview === 1 ? '1 season needs a match' : `${String(toReview)} seasons need a match`} →
        </button>
      )}
      <input
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); }}
        placeholder="Search your shows"
        aria-label="Search your shows"
        className="min-h-11 rounded-[10px] border border-line-strong bg-raised px-3 text-[15px] text-ink placeholder:text-faint focus:border-kin focus:outline-none"
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); }} className={`rounded-full px-3 py-1 text-[13px] ${filter === f ? 'bg-ink text-canvas' : 'border border-line-strong text-muted'}`}>
            {f === 'all' ? 'All' : statusLabel(f)}
          </button>
        ))}
      </div>

      {shows === undefined && (
        <ul aria-busy="true" className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 lg:gap-4">
          {Array.from({ length: 12 }, (_, i) => <li key={i} className="aspect-[108/152] w-full animate-pulse rounded-[10px] bg-raised" />)}
        </ul>
      )}
      {shows !== undefined && visible.length === 0 && (
        <p className="text-[15px] text-muted">
          {failed ? 'Your library could not load. Try again in a moment.' : shows.length === 0 ? 'Your history hasn’t imported yet.' : q !== '' ? `Nothing matches “${query.trim()}”.` : 'No shows with that status.'}
        </p>
      )}

      <div className="flex flex-col gap-6">
        {groups.map((g) =>
          g.size > 1 ? (
            <section key={g.key} aria-label={`${g.title} franchise`} className="flex flex-col gap-2">
              <button type="button" onClick={() => { navigate(`/franchise/${encodeURIComponent(g.key)}`); }} className="flex items-baseline gap-2 self-start text-left">
                <span className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Franchise</span>
                <span className="text-[15px] font-bold">{g.title}</span>
                <span className="text-[13px] text-faint">· {g.size} shows →</span>
              </button>
              <ShowGrid shows={g.shows} />
            </section>
          ) : null,
        )}
        <ShowGrid shows={groups.filter((g) => g.size <= 1).flatMap((g) => g.shows)} />
      </div>
    </Screen>
  );
}

export function ShowGrid({ shows }: { shows: readonly ShowRow[] }) {
  if (shows.length === 0) return null;
  return (
    <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 lg:gap-4">
      {shows.map((s) => (
        <li key={s.showKey}>
          <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(s.showKey)}`); }} className="flex w-full flex-col gap-1 text-left">
            <Poster title={s.title} src={posterFor(s.showKey)} className="aspect-[108/152] w-full" />
            <span className="text-[15px] leading-5 font-bold">{s.title}</span>
            <span className="text-[13px] text-faint">{statusLabel(s.status)} · {s.watchedEpisodes}/{s.totalEpisodes}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
