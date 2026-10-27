import { useEffect, useState, type SyntheticEvent } from 'react';
import { BackIcon } from '../components/icons.js';
import { Poster, posterFor } from '../components/Poster.js';
import { Button, Field, Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import type { ShowRow } from './Library.js';

/**
 * Shared lists: Shows the owner recommends to someone, sent as a link they open without an account.
 * The reader sees the list's Shows and the owner's notes, never the owner's history.
 */

export interface ListSummary {
  id: string;
  title: string;
  intro: string | null;
  token: string | null;
  count: number;
  showKeys: string[];
}

interface ListDetail {
  id: string;
  title: string;
  intro: string | null;
  token: string | null;
  items: { showKey: string; title: string; note: string | null }[];
}

export const shareUrl = (token: string) => `${window.location.origin}/s/${token}`;

/** /you/lists: every shared list, and a new one. */
export function SharedLists() {
  const [lists, setLists] = useState<ListSummary[] | null>();
  const [title, setTitle] = useState('');
  useEffect(() => {
    void api<{ items: ListSummary[] }>('/api/share-lists').then((r) => { setLists(r.items); }, () => { setLists(null); });
  }, []);
  const create = (e: SyntheticEvent) => {
    e.preventDefault();
    if (title.trim() === '') return;
    void api<{ id: string }>('/api/share-lists', { body: { title: title.trim() } }).then((r) => { navigate(`/you/lists/${r.id}`); });
  };

  return (
    <Screen kicker="You" title="Shared lists">
      <p className="text-[15px] text-muted">Pick Shows for a friend and send them the link. They can open it without an account, and they only see what you put on the list.</p>
      <form onSubmit={create} className="flex items-end gap-2">
        <div className="min-w-0 flex-1"><Field label="New list" value={title} onChange={(e) => { setTitle(e.target.value); }} placeholder="For Sam: start here" maxLength={120} /></div>
        <Button type="submit" disabled={title.trim() === ''}>Create</Button>
      </form>
      {lists === undefined && <div aria-busy="true" className="h-24 animate-pulse rounded-[16px] bg-raised" />}
      {lists === null && <p role="alert" className="text-[15px] text-muted">Your lists could not load. Try again in a moment.</p>}
      {lists?.length === 0 && <p className="text-[15px] text-faint">No lists yet.</p>}
      <ul className="flex flex-col gap-2">
        {lists?.map((l) => (
          <li key={l.id}>
            <button type="button" onClick={() => { navigate(`/you/lists/${l.id}`); }} className="flex w-full items-center gap-3 rounded-[16px] border border-line bg-surface p-3 text-left hover:bg-raised">
              <span className="flex shrink-0 -space-x-6">
                {(l.showKeys.length > 0 ? l.showKeys : ['']).slice(0, 3).map((k, i) => (
                  <Poster key={k || i} title={k || l.title} src={k === '' ? undefined : posterFor(k)} className="h-[72px] w-[50px] ring-2 ring-surface" />
                ))}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-bold">{l.title}</span>
                <span className="text-[13px] text-faint">{l.count === 1 ? '1 show' : `${String(l.count)} shows`} · {l.token === null ? 'not shared' : 'shared by link'}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Screen>
  );
}

/** The link, with Copy and (on a phone) the share sheet; and the switches that kill it. */
function LinkBox({ list, onChange }: { list: ListDetail; onChange: (token: string | null) => void }) {
  const [copied, setCopied] = useState(false);
  const set = (body: { enabled: boolean; renew?: boolean }) => {
    void api<{ token: string | null }>(`/api/share-lists/${list.id}/link`, { method: 'PUT', body }).then((r) => { onChange(r.token); });
  };
  if (list.token === null) {
    return (
      <section className="flex flex-col items-start gap-2 rounded-[16px] border border-line p-3">
        <p className="text-[15px] text-muted">Sharing is off. Nobody can open this list.</p>
        <Button onClick={() => { set({ enabled: true }); }}>Share by link</Button>
      </section>
    );
  }
  const url = shareUrl(list.token);
  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  };
  const canShare = typeof navigator.share === 'function';
  return (
    <section aria-labelledby="link" className="flex flex-col gap-2 rounded-[16px] border border-line p-3">
      <h2 id="link" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Anyone with this link can see the list</h2>
      <input readOnly value={url} aria-label="Share link" onFocus={(e) => { e.target.select(); }} className="min-h-11 rounded-[10px] border border-line-strong bg-raised px-3 font-mono text-[13px] text-ink" />
      <div className="flex flex-wrap gap-2">
        <Button onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
        {canShare && <Button kind="ghost" onClick={() => { void navigator.share({ title: list.title, url }).catch(() => undefined); }}>Share…</Button>}
        <a href={url} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-5 text-[15px] font-bold hover:bg-raised">Preview</a>
      </div>
      <div className="flex flex-wrap gap-3 text-[13px]">
        <button type="button" className="text-muted underline" onClick={() => { set({ enabled: true, renew: true }); }}>New link (the old one stops working)</button>
        <button type="button" className="text-muted underline" onClick={() => { set({ enabled: false }); }}>Stop sharing</button>
      </div>
    </section>
  );
}

/** One Show on the list: its note for the reader, its place, and taking it off. */
function ItemRow({ listId, item, first, last, onMove, onRemove }: { listId: string; item: ListDetail['items'][number]; first: boolean; last: boolean; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const [note, setNote] = useState(item.note ?? '');
  const save = () => {
    if (note.trim() === (item.note ?? '')) return;
    void api(`/api/share-lists/${listId}/items/${encodeURIComponent(item.showKey)}`, { method: 'PUT', body: { note: note.trim() === '' ? null : note.trim() } });
  };
  return (
    <li className="flex gap-3 rounded-[16px] border border-line bg-surface p-3">
      <Poster title={item.title} src={posterFor(item.showKey)} className="h-[96px] w-[66px] shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-[15px] font-bold">{item.title}</p>
        <textarea value={note} onChange={(e) => { setNote(e.target.value); }} onBlur={save} maxLength={500} rows={2} placeholder="Why they should watch it (optional)" aria-label={`Note for ${item.title}`} className="rounded-[10px] border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-kin focus:outline-none" />
      </div>
      <div className="flex shrink-0 flex-col gap-1 text-[13px] text-muted">
        <button type="button" disabled={first} onClick={() => { onMove(-1); }} aria-label={`Move ${item.title} up`} className="rounded-full border border-line-strong px-2 disabled:opacity-30">↑</button>
        <button type="button" disabled={last} onClick={() => { onMove(1); }} aria-label={`Move ${item.title} down`} className="rounded-full border border-line-strong px-2 disabled:opacity-30">↓</button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${item.title}`} className="rounded-full border border-line-strong px-2">✕</button>
      </div>
    </li>
  );
}

/** Search the Library for a Show to add. */
function AddShow({ listId, have, onAdded }: { listId: string; have: ReadonlySet<string>; onAdded: () => void }) {
  const [shows, setShows] = useState<ShowRow[]>([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    void api<{ items: ShowRow[] }>('/api/shows').then((r) => { setShows(r.items); });
  }, []);
  const q = query.trim().toLowerCase();
  const matches = q === '' ? [] : shows.filter((s) => !have.has(s.showKey) && s.title.toLowerCase().includes(q)).slice(0, 8);
  return (
    <section className="flex flex-col gap-2">
      <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); }} placeholder="Add a show from your library" aria-label="Add a show from your library" className="min-h-11 rounded-[10px] border border-line-strong bg-raised px-3 text-[15px] text-ink placeholder:text-faint focus:border-kin focus:outline-none" />
      {matches.length > 0 && (
        <ul className="flex flex-col gap-1">
          {matches.map((s) => (
            <li key={s.showKey}>
              <button type="button" onClick={() => { void api(`/api/share-lists/${listId}/items`, { body: { showKey: s.showKey } }).then(() => { setQuery(''); onAdded(); }); }} className="flex w-full items-center gap-3 rounded-[10px] px-2 py-1 text-left hover:bg-raised">
                <Poster title={s.title} src={posterFor(s.showKey)} className="h-[48px] w-[34px] shrink-0" />
                <span className="min-w-0 flex-1 text-[15px]">{s.title}</span>
                <span className="text-[13px] text-kin">Add</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** /you/lists/:id: one list, edited in place. */
export function SharedListEditor({ id }: { id: string }) {
  const [list, setList] = useState<ListDetail | null>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    void api<ListDetail>(`/api/share-lists/${id}`).then(setList, () => { setList(null); });
  }, [id, reload]);
  if (list === undefined) return <main aria-busy="true" className="min-h-dvh bg-canvas" />;
  if (list === null) return <main className="p-6 text-muted">That list doesn’t exist any more.</main>;

  const refresh = () => { setReload((n) => n + 1); };
  const saveMeta = (body: { title?: string; intro?: string | null }) => { void api(`/api/share-lists/${id}`, { method: 'PUT', body }); };
  const move = (i: number, by: -1 | 1) => {
    const keys = list.items.map((x) => x.showKey);
    const [k] = keys.splice(i, 1);
    if (k === undefined) return;
    keys.splice(i + by, 0, k);
    void api(`/api/share-lists/${id}/order`, { method: 'PUT', body: { showKeys: keys } }).then(refresh);
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 bg-canvas px-4 pt-6 pb-10 text-ink lg:max-w-2xl lg:px-10">
      <button type="button" onClick={() => { navigate('/you/lists'); }} className="flex items-center gap-1 self-start text-[13px] text-muted"><BackIcon /> Shared lists</button>
      <input defaultValue={list.title} aria-label="List title" maxLength={120} onBlur={(e) => { if (e.target.value.trim() !== '' && e.target.value.trim() !== list.title) saveMeta({ title: e.target.value.trim() }); }} className="bg-transparent font-display text-[32px] leading-[38px] font-extrabold focus:outline-none" />
      <textarea defaultValue={list.intro ?? ''} aria-label="A word at the top of the list" maxLength={1000} rows={2} placeholder="A word at the top: who it’s for, where to start (optional)" onBlur={(e) => { if (e.target.value.trim() !== (list.intro ?? '')) saveMeta({ intro: e.target.value.trim() === '' ? null : e.target.value.trim() }); }} className="rounded-[10px] border border-line-strong bg-raised px-3 py-2 text-[15px] text-ink placeholder:text-faint focus:border-kin focus:outline-none" />
      <LinkBox list={list} onChange={(token) => { setList({ ...list, token }); }} />
      <AddShow listId={id} have={new Set(list.items.map((i) => i.showKey))} onAdded={refresh} />
      {list.items.length === 0 && <p className="text-[15px] text-faint">Nothing on this list yet. Search your library above, or use “Add to shared list” on any Show.</p>}
      <ol className="flex flex-col gap-2">
        {list.items.map((item, i) => (
          <ItemRow key={item.showKey} listId={id} item={item} first={i === 0} last={i === list.items.length - 1} onMove={(by) => { move(i, by); }} onRemove={() => { void api(`/api/share-lists/${id}/items/${encodeURIComponent(item.showKey)}`, { method: 'DELETE' }).then(refresh); }} />
        ))}
      </ol>
      <Button kind="ghost" className="self-start" onClick={() => { if (window.confirm(`Delete “${list.title}”? Its link stops working. You can undo this from the change log.`)) void api(`/api/share-lists/${id}`, { method: 'DELETE' }).then(() => { navigate('/you/lists'); }); }}>Delete list</Button>
    </main>
  );
}

/** On a Show page: put it on a shared list, or start a new one with it. */
export function AddToShareList({ showKey, title }: { showKey: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ListSummary[]>();
  const [done, setDone] = useState<string>();
  useEffect(() => {
    if (open && lists === undefined) void api<{ items: ListSummary[] }>('/api/share-lists').then((r) => { setLists(r.items); });
  }, [open, lists]);
  const add = (listId: string, name: string) => {
    void api(`/api/share-lists/${listId}/items`, { body: { showKey } }).then(() => { setDone(name); setOpen(false); setLists(undefined); });
  };
  const fresh = () => {
    const name = window.prompt('Name the new list', `Watch ${title}`);
    if (name === null || name.trim() === '') return;
    void api<{ id: string }>('/api/share-lists', { body: { title: name.trim() } }).then((r) => api(`/api/share-lists/${r.id}/items`, { body: { showKey } }).then(() => { navigate(`/you/lists/${r.id}`); }));
  };
  return (
    <div className="flex flex-col gap-2">
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); setDone(undefined); }} className="self-start rounded-full border border-line-strong px-3 py-1.5 text-[13px] text-muted hover:bg-raised">
        Add to shared list
      </button>
      {done !== undefined && <p role="status" className="text-[13px] text-ok">Added to “{done}”.</p>}
      {open && (
        <ul className="flex flex-col gap-1 rounded-[10px] border border-line p-2">
          {lists === undefined && <li aria-busy="true" className="h-8 animate-pulse rounded bg-raised" />}
          {lists?.map((l) => {
            const has = l.showKeys.includes(showKey);
            return (
              <li key={l.id}>
                <button type="button" disabled={has} onClick={() => { add(l.id, l.title); }} className="flex w-full justify-between rounded-[8px] px-2 py-1.5 text-left text-[15px] hover:bg-raised disabled:opacity-50">
                  <span>{l.title}</span>
                  <span className="text-[13px] text-faint">{has ? 'on it' : `${String(l.count)} shows`}</span>
                </button>
              </li>
            );
          })}
          <li><button type="button" onClick={fresh} className="w-full rounded-[8px] px-2 py-1.5 text-left text-[15px] text-kin hover:bg-raised">New list…</button></li>
        </ul>
      )}
    </div>
  );
}
