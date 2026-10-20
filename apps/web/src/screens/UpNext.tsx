import { useEffect, useState } from 'react';
import { PinIcon } from '../components/icons.js';
import { Poster } from '../components/Poster.js';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { audio, hours, se } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { CrunchyrollLink, type CrStatus } from './Settings/CrunchyrollLink.js';
import { ImportProgress } from './ImportProgress.js';

export interface UpNextItem {
  showKey: string;
  group: 'pinned' | 'new' | 'recent' | 'next_season' | 'paused';
  title: string;
  watchedEpisodes: number;
  totalEpisodes: number;
  remainingS: number;
  nextSeason: number | null;
  nextEpisode: number | null;
  nextAudioLocale: string | null;
  watchUrl: string | null;
}

const LABEL: Record<UpNextItem['group'], string> = { pinned: 'Pinned', new: 'New since you watched', recent: 'Recently watched', next_season: 'Next season out', paused: 'Paused' };
const BADGE: Partial<Record<UpNextItem['group'], [string, string]>> = { new: ['NEW DUB', 'border-shu text-shu'], next_season: ['NEXT SEASON', 'border-info text-info'] };

export function UpNextCard({ item }: { item: UpNextItem }) {
  const pct = item.totalEpisodes > 0 ? Math.round((item.watchedEpisodes / item.totalEpisodes) * 100) : 0;
  const badge = BADGE[item.group];
  return (
    <article className="flex items-center gap-3 rounded-[16px] border border-line bg-surface p-3">
      <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(item.showKey)}`); }} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`${item.title}: details`}>
        <Poster title={item.title} className="h-[104px] w-[72px] shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[18px] leading-6 font-bold">{item.title}</h3>
          <p className="text-[13px] text-muted">{se(item.nextSeason, item.nextEpisode)} next{item.nextAudioLocale !== null ? ` — ${audio(item.nextAudioLocale)}` : ''}</p>
          {badge !== undefined && <span className={`self-start rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] ${badge[1]}`}>{badge[0]}</span>}
          <div className="h-1 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${String(pct)}% of the show watched`}>
            <div className="h-full bg-kin" style={{ width: `${String(pct)}%` }} />
          </div>
          <p className="font-mono text-[12px] text-faint">{pct}% of the show · {item.totalEpisodes - item.watchedEpisodes} eps · {hours(item.remainingS)} left</p>
        </div>
      </button>
      {item.watchUrl !== null && (
        <a href={item.watchUrl} rel="noopener" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-shu px-4 text-[15px] font-bold text-on-accent">
          ▶ Watch
        </a>
      )}
    </article>
  );
}

export function UpNext() {
  const [cr, setCr] = useState<CrStatus>();
  const [items, setItems] = useState<UpNextItem[]>();
  useEffect(() => {
    void api<CrStatus>('/api/crunchyroll').then(setCr, () => { setCr({ linked: false }); });
    void api<{ items: UpNextItem[] }>('/api/up-next').then((r) => { setItems(r.items); }, () => { setItems([]); });
  }, []);

  const groups = (items ?? []).reduce<Map<string, UpNextItem[]>>((m, i) => m.set(i.group, [...(m.get(i.group) ?? []), i]), new Map());

  return (
    <Screen kicker="Tonight" title="Up Next">
      {cr !== undefined && !cr.linked && <CrunchyrollLink status={cr} onLinked={setCr} />}
      {cr?.linked === true && (items?.length ?? 0) === 0 && <ImportProgress />}
      {items === undefined && cr?.linked === true && <div aria-busy="true" className="h-32 animate-pulse rounded-[16px] bg-raised" />}
      {items !== undefined && items.length === 0 && cr?.linked === true && (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="font-display text-[40px] text-faint">空</p>
          <p className="text-[18px] font-bold">Nothing in progress</p>
          <p className="text-[15px] text-muted">Once your history imports, the shows you’re watching appear here.</p>
        </div>
      )}
      {[...groups.entries()].map(([group, list]) =>
        group === 'paused' ? (
          <details key={group} className="rounded-[10px] border border-line px-3 py-2">
            <summary className="cursor-pointer text-[15px] font-bold text-muted">Paused · {list.length} shows</summary>
            <div className="mt-3 flex flex-col gap-3">{list.map((i) => <UpNextCard key={i.showKey} item={i} />)}</div>
          </details>
        ) : (
          <section key={group} className="flex flex-col gap-3" aria-label={LABEL[group as UpNextItem['group']]}>
            <p className={`flex items-center gap-1 text-[11px] font-medium tracking-[0.6px] uppercase ${group === 'pinned' ? 'text-kin' : 'text-faint'}`}>
              {group === 'pinned' && <PinIcon />}
              {LABEL[group as UpNextItem['group']]}
            </p>
            {list.map((i) => <UpNextCard key={i.showKey} item={i} />)}
          </section>
        ),
      )}
    </Screen>
  );
}
