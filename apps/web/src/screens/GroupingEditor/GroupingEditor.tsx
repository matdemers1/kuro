import { useEffect, useState } from 'react';
import { Button } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { navigate } from '../../lib/router.js';

/**
 * The grouping editor (KURO-T-2.6): reorder a Show's Seasons and Extras, split some off into a Show
 * of their own, move an Extra into another Show, or merge two Shows. Each change is an override —
 * the owner's, kept through every sync and catalog import — in the change log, and removable here.
 */

export interface EditorItem {
  entryId: string;
  kind: 'season' | 'extra';
  title: string;
}

interface OverrideRow {
  id: string;
  kind: 'merge' | 'split' | 'reorder' | 'attach';
  createdAt: string;
}

interface LibraryRow {
  showKey: string;
  title: string;
}

const DESCRIBE: Record<OverrideRow['kind'], string> = { merge: 'Merged with another show', split: 'Split into its own show', reorder: 'Put in your own order', attach: 'An extra moved here' };

export function GroupingEditor({ showKey, seriesIds, items, onChanged }: { showKey: string; seriesIds: readonly string[]; items: readonly EditorItem[]; onChanged: (newKey: string) => void }) {
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [library, setLibrary] = useState<LibraryRow[]>([]);
  const [target, setTarget] = useState<{ mode: 'merge' } | { mode: 'attach'; entryId: string }>();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    void api<{ items: OverrideRow[] }>(`/api/overrides?showKey=${encodeURIComponent(showKey)}`).then((r) => { setOverrides(r.items); }, () => { setOverrides([]); });
  }, [showKey, changes]);
  useEffect(() => {
    if (target === undefined) return;
    void api<{ items: LibraryRow[] }>('/api/shows').then((r) => { setLibrary(r.items.filter((s) => s.showKey !== showKey)); }, () => { setLibrary([]); });
  }, [target, showKey]);

  /** After a change the Show may have a new key: follow the first item to wherever it is now. */
  const after = async () => {
    const anchor = items[0]?.entryId;
    const where = anchor === undefined ? undefined : await api<{ showKey: string }>(`/api/shows/by-entry/${encodeURIComponent(anchor)}`).catch(() => undefined);
    setTarget(undefined);
    setQuery('');
    setChanges((n) => n + 1);
    onChanged(where?.showKey ?? showKey);
  };
  const add = (body: unknown) => {
    setError(undefined);
    void api('/api/overrides', { body }).then(after, () => { setError('That change did not save.'); });
  };
  const remove = (id: string) => {
    void api(`/api/overrides/${id}`, { method: 'DELETE' }).then(after, () => { setError('That did not undo.'); });
  };

  const move = (i: number, by: -1 | 1) => {
    const order = items.map((x) => x.entryId);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j] ?? '', order[i] ?? ''];
    add({ kind: 'reorder', entryIds: order });
  };

  const pickTarget = async (other: LibraryRow) => {
    if (target?.mode === 'merge') {
      const otherSeries = (await api<{ seriesIds?: string[] }>(`/api/shows/${encodeURIComponent(other.showKey)}`)).seriesIds ?? [];
      add({ kind: 'merge', seriesIds: [...seriesIds, ...otherSeries] });
    } else if (target?.mode === 'attach') {
      // Into the other Show, after its last Season.
      const theirs = (await api<{ items?: EditorItem[] }>(`/api/shows/${encodeURIComponent(other.showKey)}`)).items ?? [];
      const last = [...theirs].reverse().find((x) => x.kind === 'season') ?? theirs.at(-1);
      if (last === undefined) setError('That show has nothing to attach after.');
      else add({ kind: 'attach', entryId: target.entryId, afterEntryId: last.entryId });
    }
  };
  const matches = library.filter((s) => query.trim().length >= 2 && s.title.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8);

  return (
    <section aria-labelledby="edit-grouping" className="flex flex-col gap-3 rounded-[16px] border border-kin p-3">
      <h2 id="edit-grouping" className="text-[15px] font-bold">Edit grouping</h2>
      {error !== undefined && <p role="alert" className="text-[13px] text-shu">{error}</p>}
      <ol className="flex flex-col gap-2">
        {items.map((it, i) => (
          <li key={it.entryId} className="flex flex-wrap items-center gap-2">
            <span className={`w-12 shrink-0 text-[11px] font-medium tracking-[0.6px] uppercase ${it.kind === 'extra' ? 'text-kin' : 'text-muted'}`}>{it.kind === 'extra' ? 'Extra' : 'Season'}</span>
            <span className="min-w-0 flex-1 text-[15px]">{it.title}</span>
            <Button kind="ghost" className="min-h-9 px-3" disabled={i === 0} onClick={() => { move(i, -1); }} aria-label={`Move ${it.title} up`}>↑</Button>
            <Button kind="ghost" className="min-h-9 px-3" disabled={i === items.length - 1} onClick={() => { move(i, 1); }} aria-label={`Move ${it.title} down`}>↓</Button>
            {i > 0 && <Button kind="ghost" className="min-h-9 px-3" onClick={() => { add({ kind: 'split', entryIds: items.slice(i).map((x) => x.entryId) }); }}>Split from here</Button>}
            {it.kind === 'extra' && <Button kind="ghost" className="min-h-9 px-3" onClick={() => { setTarget({ mode: 'attach', entryId: it.entryId }); }}>Move to…</Button>}
          </li>
        ))}
      </ol>
      <Button kind="ghost" onClick={() => { setTarget({ mode: 'merge' }); }}>Merge with another show…</Button>

      {target !== undefined && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">{target.mode === 'merge' ? 'Merge with' : 'Move the extra to'}</span>
            <input type="search" autoFocus value={query} onChange={(e) => { setQuery(e.target.value); }} placeholder="Find a show in your library" className="min-h-11 rounded-[10px] border border-line-strong bg-raised px-3 text-[15px] text-ink placeholder:text-faint focus:border-kin focus:outline-none" />
          </label>
          {matches.map((m) => (
            <Button key={m.showKey} kind="ghost" onClick={() => { void pickTarget(m); }}>{m.title}</Button>
          ))}
          <Button kind="ghost" onClick={() => { setTarget(undefined); }}>Cancel</Button>
        </div>
      )}

      {overrides.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Your corrections</p>
          {overrides.map((o) => (
            <div key={o.id} className="flex items-center gap-2 text-[13px] text-muted">
              <span className="flex-1">{DESCRIBE[o.kind]} · {new Date(o.createdAt).toLocaleDateString()}</span>
              <Button kind="ghost" className="min-h-9 px-3" onClick={() => { remove(o.id); }}>Remove</Button>
            </div>
          ))}
        </div>
      )}
      <Button kind="ghost" onClick={() => { navigate('/you/changes'); }}>See the change log</Button>
    </section>
  );
}
