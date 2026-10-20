import { useEffect, useState } from 'react';
import { Button } from '../components/ui.js';
import { api } from '../lib/api.js';
import { statusLabel } from '../lib/format.js';
import { navigate } from '../lib/router.js';

interface QueueItem {
  showKey: string;
  title: string;
  status: string | null;
  reason: string | null;
  startTitle: string | null;
  timesRewatched: number;
}

/** The rewatch queue (KURO-REQ-042): in the owner's order, each with why and where to start. */
export function RewatchQueue() {
  const [items, setItems] = useState<QueueItem[]>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void api<{ items: QueueItem[] }>('/api/rewatch-queue').then((r) => { setItems(r.items); }, () => { setItems([]); });
  }, [version]);
  const reload = () => { setVersion((v) => v + 1); };

  const move = (i: number, by: -1 | 1) => {
    if (items === undefined) return;
    const keys = items.map((x) => x.showKey);
    const j = i + by;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j] ?? '', keys[i] ?? ''];
    void api('/api/rewatch-queue/order', { method: 'PUT', body: { showKeys: keys } }).then(reload);
  };
  const remove = (key: string) => { void api(`/api/rewatch-queue/${encodeURIComponent(key)}`, { method: 'DELETE' }).then(reload); };
  const editReason = (key: string, reason: string) => { void api(`/api/rewatch-queue/${encodeURIComponent(key)}`, { method: 'PUT', body: { reason: reason.trim() === '' ? null : reason.trim() } }).then(reload); };

  return (
    <section aria-labelledby="rewatch-queue" className="flex flex-col gap-2">
      <h2 id="rewatch-queue" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Rewatch queue</h2>
      {items === undefined && <div aria-busy="true" className="h-16 animate-pulse rounded-[10px] bg-raised" />}
      {items?.length === 0 && <p className="text-[13px] text-muted">Nothing queued — add a show from its page.</p>}
      <ol className="flex flex-col gap-2">
        {items?.map((it, i) => (
          <li key={it.showKey} className="flex flex-col gap-1 rounded-[10px] border border-line p-2">
            <div className="flex items-center gap-2">
              <span className="w-5 font-mono text-[12px] text-faint">{i + 1}</span>
              <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(it.showKey)}`); }} className="min-w-0 flex-1 text-left text-[15px] font-bold">{it.title}</button>
              <Button kind="ghost" className="min-h-9 px-3" disabled={i === 0} onClick={() => { move(i, -1); }} aria-label={`Move ${it.title} up`}>↑</Button>
              <Button kind="ghost" className="min-h-9 px-3" disabled={i === items.length - 1} onClick={() => { move(i, 1); }} aria-label={`Move ${it.title} down`}>↓</Button>
              <Button kind="ghost" className="min-h-9 px-3" onClick={() => { remove(it.showKey); }} aria-label={`Remove ${it.title} from the queue`}>Remove</Button>
            </div>
            <p className="pl-7 font-mono text-[12px] text-faint">
              {[it.status === null ? null : statusLabel(it.status), it.startTitle === null ? 'from the start' : `from ${it.startTitle}`, it.timesRewatched > 0 ? `rewatched ${String(it.timesRewatched)}×` : null].filter((x) => x !== null).join(' · ')}
            </p>
            <input
              defaultValue={it.reason ?? ''}
              onBlur={(e) => { if (e.target.value.trim() !== (it.reason ?? '')) editReason(it.showKey, e.target.value); }}
              placeholder="Why rewatch it?"
              aria-label={`Why rewatch ${it.title}`}
              className="ml-7 min-h-9 rounded-[8px] border border-line-strong bg-raised px-2 text-[13px] text-ink placeholder:text-faint focus:border-kin focus:outline-none"
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Add to rewatch queue" on a Show page: optional reason and Season to start from. */
export function AddToRewatch({ showKey, seasons, onAdded }: { showKey: string; seasons: readonly { entryId: string; title: string }[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [start, setStart] = useState('');
  if (!open) return <Button kind="ghost" className="self-start" onClick={() => { setOpen(true); }}>Add to rewatch queue</Button>;
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line-strong p-3">
      <input value={reason} onChange={(e) => { setReason(e.target.value); }} placeholder="Why rewatch it? (optional)" aria-label="Why rewatch it" className="min-h-10 rounded-[8px] border border-line-strong bg-raised px-2 text-[15px] text-ink placeholder:text-faint" />
      {seasons.length > 1 && (
        <select value={start} onChange={(e) => { setStart(e.target.value); }} aria-label="Start from" className="min-h-10 rounded-[8px] border border-line-strong bg-raised px-2 text-[15px] text-ink">
          <option value="">From the start</option>
          {seasons.map((s) => <option key={s.entryId} value={s.entryId}>From {s.title}</option>)}
        </select>
      )}
      <div className="flex gap-2">
        <Button onClick={() => { void api('/api/rewatch-queue', { body: { showKey, reason: reason.trim() === '' ? null : reason.trim(), startEntryId: start === '' ? null : start } }).then(() => { setOpen(false); onAdded(); }); }}>Queue it</Button>
        <Button kind="ghost" onClick={() => { setOpen(false); }}>Cancel</Button>
      </div>
    </div>
  );
}
