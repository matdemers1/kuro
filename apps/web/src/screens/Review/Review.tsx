import { useEffect, useState } from 'react';
import { Poster } from '../../components/Poster.js';
import { Button, Screen } from '../../components/ui.js';
import { api } from '../../lib/api.js';

/**
 * Match review (KURO-T-2.4): the seasons the matcher was not sure of, most-watched first. One tap
 * settles each — confirm the guess, pick a candidate, search the catalog, or say it is not there.
 * Every answer is in the change log and can be undone.
 */

export interface Entry {
  id: string;
  title: string;
  type: string;
  episodes: number;
  year: number | null;
  season: string | null;
  picture: string | null;
}

export interface ReviewItem {
  seasonId: string;
  seriesTitle: string;
  seasonTitle: string;
  plays: number;
  episodes: number;
  ranges: { id: string; epFrom: number; epTo: number; entry: Entry | null; signals: string[] }[];
  candidates: Entry[];
}

const meta = (e: Entry) => [e.type === 'TV' ? 'TV' : e.type.charAt(0) + e.type.slice(1).toLowerCase(), e.episodes > 0 ? `${String(e.episodes)} eps` : null, e.year].filter((x) => x !== null).join(' · ');
const range = (from: number, to: number) => (from === to ? `E${String(from)}` : `E${String(from)}–${String(to)}`);

export function useReviewCount(): number | undefined {
  const [total, setTotal] = useState<number>();
  useEffect(() => {
    void api<{ total: number }>('/api/mappings/review').then((r) => { setTotal(r.total); }, () => { setTotal(0); });
  }, []);
  return total;
}

export function Review() {
  const [items, setItems] = useState<ReviewItem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api<{ items: ReviewItem[] }>('/api/mappings/review').then((r) => { setItems(r.items); }, () => { setError('Could not load the review queue.'); });
  }, []);

  const settle = (seasonId: string, action: 'confirm' | 'skip' | { entryIds: string[] }) => {
    const path = typeof action === 'string' ? `/api/mappings/season/${encodeURIComponent(seasonId)}/${action}` : `/api/mappings/season/${encodeURIComponent(seasonId)}/choose`;
    void api(path, typeof action === 'string' ? { method: 'POST' } : { body: action }).then(
      () => { setItems((list) => list?.filter((i) => i.seasonId !== seasonId)); },
      () => { setError('That did not save. Try again.'); },
    );
  };

  return (
    <Screen kicker={items === undefined ? 'Match review' : items.length === 0 ? 'Match review' : `${String(items.length)} to check`} title="Which show is this?">
      {error !== undefined && <p role="alert" className="text-[13px] text-shu">{error}</p>}
      {items === undefined && error === undefined && <div aria-busy="true" className="h-40 animate-pulse rounded-[16px] bg-raised" />}
      {items !== undefined && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="font-display text-[40px] text-kin">済</p>
          <p className="text-[18px] font-bold">All matched</p>
          <p className="text-[15px] text-muted">Every season you’ve watched is matched to the catalog.</p>
        </div>
      )}
      {items?.map((item) => <ReviewCard key={item.seasonId} item={item} onSettle={(a) => { settle(item.seasonId, a); }} />)}
    </Screen>
  );
}

function ReviewCard({ item, onSettle }: { item: ReviewItem; onSettle: (action: 'confirm' | 'skip' | { entryIds: string[] }) => void }) {
  const [query, setQuery] = useState('');
  /** Entries picked so far, in watch order, when the season spans more than one. */
  const [picked, setPicked] = useState<Entry[]>([]);
  const covered = picked.reduce((n, e) => n + e.episodes, 0);
  const pick = (e: Entry) => {
    const next = [...picked, e];
    // One entry that holds the whole season (or an open-ended one) settles it in one tap.
    if (e.episodes === 0 || covered + e.episodes >= item.episodes) onSettle({ entryIds: next.map((x) => x.id) });
    else setPicked(next);
  };
  const [results, setResults] = useState<Entry[]>([]);
  const searching = query.trim().length >= 2;
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(() => {
      void api<{ items: Entry[] }>(`/api/catalog/search?q=${encodeURIComponent(query.trim())}`).then((r) => { setResults(r.items); }, () => { setResults([]); });
    }, 250);
    return () => { clearTimeout(t); };
  }, [query, searching]);

  const guessed = item.ranges.filter((r) => r.entry !== null);
  const from = Math.min(...item.ranges.map((r) => r.epFrom));
  const to = Math.max(...item.ranges.map((r) => r.epTo));
  const guessIds = new Set(guessed.map((r) => r.entry?.id));
  // While picking in order, every candidate is on offer — the guess's own entries included.
  const others = item.candidates.filter((c) => (picked.length > 0 ? true : !guessIds.has(c.id)));

  return (
    <article className="flex flex-col gap-3 rounded-[16px] border border-line bg-surface p-4" aria-label={`${item.seriesTitle}: ${item.seasonTitle}`}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-[18px] leading-6 font-bold">{item.seriesTitle}</h2>
        <p className="text-[13px] text-muted">
          {item.seasonTitle} · {range(from, to)}
          {` · ${String(item.episodes)} eps`}
          {item.plays > 0 ? ` · ${String(item.plays)} plays` : ''}
        </p>
      </header>

      {picked.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-kin p-3" role="status">
          <p className="text-[13px] text-ink">
            {picked.map((p) => p.title).join(' → ')} covers {covered} of {item.episodes} episodes — then which?
          </p>
          <div className="flex gap-2">
            <Button onClick={() => { onSettle({ entryIds: picked.map((p) => p.id) }); }}>Save as is</Button>
            <Button kind="ghost" onClick={() => { setPicked([]); }}>Start over</Button>
          </div>
        </div>
      )}

      {guessed.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Best guess</p>
          {guessed.map((r) => r.entry !== null && (
            <EntryRow key={r.id} entry={r.entry} note={guessed.length > 1 ? range(r.epFrom, r.epTo) : undefined} />
          ))}
          <Button onClick={() => { onSettle('confirm'); }}>Yes, that’s it</Button>
        </div>
      )}

      {others.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Or one of these</p>
          {others.filter((c) => !picked.some((p) => p.id === c.id)).map((c) => <EntryRow key={c.id} entry={c} onPick={() => { pick(c); }} />)}
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Search the catalog</span>
        <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); }} placeholder="Title, in any language" className="min-h-11 rounded-[10px] border border-line-strong bg-raised px-3 text-[15px] text-ink placeholder:text-faint focus:border-kin focus:outline-none" />
      </label>
      {searching && results.filter((c) => !picked.some((p) => p.id === c.id)).map((c) => <EntryRow key={c.id} entry={c} onPick={() => { pick(c); }} />)}

      <Button kind="ghost" onClick={() => { onSettle('skip'); }}>Not in the catalog</Button>
    </article>
  );
}

function EntryRow({ entry, note, onPick }: { entry: Entry; note?: string | undefined; onPick?: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <Poster title={entry.title} src={entry.picture === null ? undefined : `/img/catalog/${encodeURIComponent(entry.id)}`} className="h-[60px] w-[42px] shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] leading-5 font-bold">{entry.title}</span>
        <span className="font-mono text-[12px] text-faint">{note !== undefined ? `${note} · ` : ''}{meta(entry)}</span>
      </div>
      {onPick !== undefined && <Button kind="ghost" onClick={onPick} aria-label={`It is ${entry.title}`}>This one</Button>}
    </div>
  );
}
