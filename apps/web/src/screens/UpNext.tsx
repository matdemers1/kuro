import { useEffect, useState } from 'react';
import { PinIcon } from '../components/icons.js';
import { bannerFor, Poster, posterFor } from '../components/Poster.js';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { audio, hours, se } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { CrunchyrollLink, type CrStatus } from './Settings/CrunchyrollLink.js';
import { ImportProgress } from './ImportProgress.js';
import { SyncBanner, useHealth } from './Settings/SyncHealth.js';

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

const percent = (item: UpNextItem) => (item.totalEpisodes > 0 ? Math.round((item.watchedEpisodes / item.totalEpisodes) * 100) : 0);
const nextLine = (item: UpNextItem) => `${se(item.nextSeason, item.nextEpisode)} next${item.nextAudioLocale !== null ? ` — ${audio(item.nextAudioLocale)}` : ''}`;

function Badge({ group }: { group: UpNextItem['group'] }) {
  const badge = BADGE[group];
  return badge === undefined ? null : <span className={`self-start rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] ${badge[1]}`}>{badge[0]}</span>;
}

function Progress({ pct, className = '' }: { pct: number; className?: string }) {
  return (
    <div className={`h-1 w-full overflow-hidden rounded-full bg-raised ${className}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${String(pct)}% of the show watched`}>
      <div className="h-full bg-kin" style={{ width: `${String(pct)}%` }} />
    </div>
  );
}

function WatchButton({ item }: { item: UpNextItem }) {
  return item.watchUrl === null ? null : (
    <a href={item.watchUrl} rel="noopener" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-shu-fill px-4 text-[15px] font-bold text-on-accent">
      ▶ Watch
    </a>
  );
}

export function UpNextCard({ item }: { item: UpNextItem }) {
  const pct = percent(item);
  return (
    <article className="flex items-center gap-3 rounded-[16px] border border-line bg-surface p-3">
      <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(item.showKey)}`); }} className="flex min-w-0 flex-1 items-center gap-3 text-left lg:gap-4" aria-label={`${item.title}: details`}>
        <Poster title={item.title} src={posterFor(item.showKey)} className="h-[104px] w-[72px] shrink-0 lg:h-[132px] lg:w-[92px]" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[18px] leading-6 font-bold">{item.title}</h3>
          <p className="text-[13px] text-muted">{nextLine(item)}</p>
          <Badge group={item.group} />
          <Progress pct={pct} />
          <p className="font-mono text-[12px] text-faint">{pct}% of the show · {item.totalEpisodes - item.watchedEpisodes} eps · {hours(item.remainingS)} left</p>
        </div>
      </button>
      <WatchButton item={item} />
    </article>
  );
}

/** Tonight's first pick, on its wide key art: what to put on without scrolling. */
export function Spotlight({ item }: { item: UpNextItem }) {
  const pct = percent(item);
  return (
    <article className="relative isolate flex min-h-[240px] overflow-hidden rounded-[20px] border border-line bg-surface sm:min-h-[300px] lg:min-h-[360px]">
      <Poster title={item.title} src={bannerFor(item.showKey)} className="absolute inset-0 -z-10 rounded-none" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-black/90 via-black/50 to-black/10 lg:bg-gradient-to-r lg:from-black/95 lg:via-black/75 lg:via-40% lg:to-black/10" />
      <div className="flex w-full items-end gap-5 p-4 sm:p-6 lg:p-8">
        <Poster title={item.title} src={posterFor(item.showKey)} className="hidden aspect-[2/3] w-[140px] shrink-0 shadow-2xl ring-1 ring-white/10 sm:block lg:w-[168px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 text-on-accent">
          <p className="text-[11px] font-medium tracking-[0.6px] text-white/70 uppercase">{LABEL[item.group]}</p>
          <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(item.showKey)}`); }} className="text-left" aria-label={`${item.title}: details`}>
            <h2 className="font-display text-[28px] leading-[34px] font-bold lg:text-[40px] lg:leading-[46px]">{item.title}</h2>
          </button>
          <p className="text-[15px] text-white/80">{nextLine(item)}</p>
          <Badge group={item.group} />
          <Progress pct={pct} className="max-w-md bg-white/20" />
          <p className="font-mono text-[12px] text-white/70">{pct}% of the show · {item.totalEpisodes - item.watchedEpisodes} eps · {hours(item.remainingS)} left</p>
          <div className="pt-1"><WatchButton item={item} /></div>
        </div>
      </div>
    </article>
  );
}

const GRID = 'grid gap-3 lg:grid-cols-2 lg:gap-4 2xl:grid-cols-3';

export function UpNext() {
  const [cr, setCr] = useState<CrStatus>();
  const [items, setItems] = useState<UpNextItem[] | null>();
  const loadItems = () => {
    void api<{ items: UpNextItem[] }>('/api/up-next').then((r) => { setItems(r.items); }, () => { setItems(null); });
  };
  useEffect(() => {
    void api<CrStatus>('/api/crunchyroll').then(setCr, () => { setCr({ linked: false }); });
    loadItems();
  }, []);

  const health = useHealth();
  // The first Show not paused leads, on its art; the rest follow in their groups.
  const lead = (items ?? []).find((i) => i.group !== 'paused');
  const groups = (items ?? []).filter((i) => i !== lead).reduce<Map<string, UpNextItem[]>>((m, i) => m.set(i.group, [...(m.get(i.group) ?? []), i]), new Map());

  return (
    <Screen kicker="Tonight" title="Up Next" wide="full">
      <SyncBanner health={health} />
      {cr !== undefined && !cr.linked && <CrunchyrollLink status={cr} onLinked={setCr} />}
      {cr?.linked === true && items?.length === 0 && <ImportProgress onDerived={loadItems} />}
      {items === undefined && cr?.linked === true && <div aria-busy="true" className="h-32 animate-pulse rounded-[16px] bg-raised" />}
      {items === null && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-[15px] text-muted">Up Next could not load. Your history is safe; this is only the page.</p>
          <button type="button" className="text-[13px] underline" onClick={loadItems}>Try again</button>
        </div>
      )}
      {items !== undefined && items !== null && items.length === 0 && cr?.linked === true && (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="font-display text-[40px] text-faint">空</p>
          <p className="text-[18px] font-bold">Nothing in progress</p>
          <p className="text-[15px] text-muted">Once your history imports, the shows you’re watching appear here.</p>
        </div>
      )}
      {lead !== undefined && <Spotlight item={lead} />}
      {[...groups.entries()].map(([group, list]) =>
        group === 'paused' ? (
          <details key={group} className="rounded-[10px] border border-line px-3 py-2">
            <summary className="cursor-pointer text-[15px] font-bold text-muted">Paused · {list.length} shows</summary>
            <div className={`mt-3 ${GRID}`}>{list.map((i) => <UpNextCard key={i.showKey} item={i} />)}</div>
          </details>
        ) : (
          <section key={group} className="flex flex-col gap-3" aria-label={LABEL[group as UpNextItem['group']]}>
            <p className={`flex items-center gap-1 text-[11px] font-medium tracking-[0.6px] uppercase ${group === 'pinned' ? 'text-kin' : 'text-faint'}`}>
              {group === 'pinned' && <PinIcon />}
              {LABEL[group as UpNextItem['group']]}
            </p>
            <div className={GRID}>{list.map((i) => <UpNextCard key={i.showKey} item={i} />)}</div>
          </section>
        ),
      )}
    </Screen>
  );
}
