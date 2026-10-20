import { useEffect, useState } from 'react';
import { Poster, posterFor } from '../components/Poster.js';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

interface ShowRow { showKey: string; title: string; status: string; watchedEpisodes: number; totalEpisodes: number; pinned: boolean }

const FILTERS = ['all', 'watching', 'paused', 'completed'] as const;

/** Every Show in your history (KURO-REQ-035 arrives fully with franchises in Phase 2). */
export function Library() {
  const [shows, setShows] = useState<ShowRow[]>();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  useEffect(() => {
    void api<{ items: ShowRow[] }>('/api/shows').then((r) => { setShows(r.items); }, () => { setShows([]); });
  }, []);
  const visible = (shows ?? []).filter((s) => filter === 'all' || s.status === filter);
  return (
    <Screen kicker={shows === undefined ? 'Library' : `${String(shows.length)} shows`} title="Library" wide>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); }} className={`rounded-full px-3 py-1 text-[13px] capitalize ${filter === f ? 'bg-ink text-canvas' : 'border border-line-strong text-muted'}`}>
            {f}
          </button>
        ))}
      </div>
      {shows !== undefined && visible.length === 0 && <p className="text-[15px] text-muted">{shows.length === 0 ? 'Your history hasn’t imported yet.' : 'No shows with that status.'}</p>}
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {visible.map((s) => (
          <li key={s.showKey}>
            <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(s.showKey)}`); }} className="flex w-full flex-col gap-1 text-left">
              <Poster title={s.title} src={posterFor(s.showKey)} className="aspect-[108/152] w-full" />
              <span className="text-[15px] leading-5 font-bold">{s.title}</span>
              <span className="text-[13px] text-faint capitalize">{s.status.replace('_', ' ')} · {s.watchedEpisodes}/{s.totalEpisodes}</span>
            </button>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
