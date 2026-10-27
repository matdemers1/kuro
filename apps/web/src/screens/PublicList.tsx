import { useEffect, useState } from 'react';
import { Poster } from '../components/Poster.js';

/**
 * /s/:token — a shared list, as the person it was sent to sees it: no account, no app chrome, and
 * nothing of the owner's history. Only what the owner put on the list.
 */

interface PublicItem {
  position: number;
  title: string;
  note: string | null;
  description: string | null;
  year: number | null;
  seasons: number | null;
  episodes: number | null;
  tags: string[];
  crunchyrollUrl: string | null;
}

interface PublicListBody {
  title: string;
  intro: string | null;
  items: PublicItem[];
}

const art = (token: string, position: number, kind: 'poster' | 'banner') => `/public/lists/${encodeURIComponent(token)}/img/${String(position)}/${kind}`;

function Card({ token, item, rank }: { token: string; item: PublicItem; rank: number }) {
  const [more, setMore] = useState(false);
  const facts = [item.year, item.seasons === null || item.seasons < 1 ? null : item.seasons === 1 ? '1 season' : `${String(item.seasons)} seasons`, item.episodes === null || item.episodes < 1 ? null : `${String(item.episodes)} episodes`].filter((x) => x !== null);
  return (
    <li className="flex flex-col overflow-hidden rounded-[20px] border border-line bg-surface sm:flex-row">
      <div className="relative sm:w-[200px] sm:shrink-0 lg:w-[220px]">
        <Poster title={item.title} src={art(token, item.position, 'banner')} className="aspect-video w-full rounded-none sm:hidden" />
        <Poster title={item.title} src={art(token, item.position, 'poster')} className="hidden aspect-[2/3] w-full rounded-none sm:block" />
        <span aria-hidden="true" className="absolute top-3 left-3 flex h-8 min-w-8 items-center justify-center rounded-full bg-black/70 px-2 font-mono text-[13px] font-bold text-on-accent">{rank}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 lg:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[24px] leading-[30px] font-bold">{item.title}</h2>
          {facts.length > 0 && <p className="font-mono text-[12px] text-faint">{facts.join(' · ')}</p>}
        </div>
        {item.note !== null && (
          <blockquote className="rounded-[12px] border-l-4 border-shu bg-raised px-4 py-3 text-[15px] leading-6">{item.note}</blockquote>
        )}
        {item.description !== null && (
          <div className="flex flex-col items-start gap-1">
            <p className={`text-[15px] leading-6 text-muted ${more ? '' : 'line-clamp-3'}`}>{item.description}</p>
            {item.description.length > 220 && <button type="button" className="text-[13px] text-faint underline" onClick={() => { setMore(!more); }}>{more ? 'Less' : 'More'}</button>}
          </div>
        )}
        {item.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
            {item.tags.map((t) => <li key={t} className="rounded-full border border-line-strong px-2 py-0.5 text-[12px] text-muted">{t}</li>)}
          </ul>
        )}
        {item.crunchyrollUrl !== null && (
          <a href={item.crunchyrollUrl} target="_blank" rel="noopener noreferrer" className="mt-auto inline-flex min-h-11 items-center gap-1.5 self-start rounded-full bg-shu-fill px-5 text-[15px] font-bold text-on-accent">
            ▶ Watch on Crunchyroll
          </a>
        )}
      </div>
    </li>
  );
}

export function PublicList({ token }: { token: string }) {
  const [list, setList] = useState<PublicListBody | null>();
  useEffect(() => {
    void fetch(`/public/lists/${encodeURIComponent(token)}`, { credentials: 'omit' })
      .then((r) => (r.ok ? (r.json() as Promise<PublicListBody>) : null))
      .then(setList, () => { setList(null); });
  }, [token]);
  useEffect(() => {
    document.title = list === undefined || list === null ? 'Kurō' : `${list.title} · Kurō`;
  }, [list]);

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-10 pb-16 lg:px-10">
        <p className="flex items-baseline gap-2">
          <span className="font-display text-[20px] font-bold">Kurō</span>
          <span className="text-[13px] font-bold text-shu">苦労</span>
        </p>
        {list === undefined && <div aria-busy="true" className="h-64 animate-pulse rounded-[20px] bg-raised" />}
        {list === null && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="font-display text-[40px] text-faint">空</p>
            <p className="text-[18px] font-bold">This list isn’t shared any more</p>
            <p className="text-[15px] text-muted">The link may be old. Ask whoever sent it for a new one.</p>
          </div>
        )}
        {list !== undefined && list !== null && (
          <>
            <header className="flex flex-col gap-2">
              <p className="text-[11px] font-medium tracking-[0.6px] text-shu uppercase">{list.items.length === 1 ? 'One show to watch' : `${String(list.items.length)} shows to watch`}</p>
              <h1 className="font-display text-[36px] leading-[42px] font-extrabold lg:text-[48px] lg:leading-[54px]">{list.title}</h1>
              {list.intro !== null && <p className="max-w-2xl text-[17px] leading-7 text-muted">{list.intro}</p>}
            </header>
            <ol className="flex flex-col gap-4">
              {list.items.map((item, i) => <Card key={item.position} token={token} item={item} rank={i + 1} />)}
            </ol>
            <p className="text-[12px] text-faint">Shared from Kurō, an anime tracker. Kurō is not affiliated with Crunchyroll.</p>
          </>
        )}
      </main>
    </div>
  );
}
