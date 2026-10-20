import { useEffect, useState } from 'react';
import { Button, Screen } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';

interface Change { id: string; entity: string; entityId: string; action: string; at: string; undone: boolean; isUndo: boolean; undoable: boolean }

const DESCRIBE: Record<string, string> = {
  pinned: 'Pinned a show',
  unpinned: 'Unpinned a show',
  'undo:pinned': 'Undid a pin',
  'undo:unpinned': 'Undid an unpin',
  linked: 'Linked Crunchyroll',
  relinked: 'Re-linked Crunchyroll',
  owner_created: 'Created the owner account',
  totp_enrolled: 'Added an authenticator',
};

/** Every change, newest first, with Undo where it applies (KURO-REQ-022). */
export function ChangeLog() {
  const [items, setItems] = useState<Change[]>();
  const [error, setError] = useState<string>();
  const load = () => {
    void api<{ items: Change[] }>('/api/changes').then((r) => { setItems(r.items); });
  };
  useEffect(load, []);
  return (
    <Screen kicker="You" title="Change log">
      {error !== undefined && <p role="alert" className="text-[13px] text-shu">{error}</p>}
      {items !== undefined && items.length === 0 && <p className="text-[15px] text-muted">No changes yet.</p>}
      <ul className="flex flex-col gap-2">
        {(items ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface px-3 py-2">
            <div className="min-w-0">
              <p className={`text-[15px] ${c.undone ? 'text-faint line-through' : ''}`}>{DESCRIBE[c.action] ?? c.action}</p>
              <p className="truncate font-mono text-[12px] text-faint">{new Date(c.at).toLocaleString()} · {c.entityId}</p>
            </div>
            {c.undoable && (
              <Button kind="ghost" className="min-h-9 px-4" onClick={() => {
                setError(undefined);
                void api(`/api/changes/${c.id}/undo`, { method: 'POST' }).then(load, (err: unknown) => { setError(err instanceof ApiError ? err.message : 'Undo failed'); });
              }}>
                Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Screen>
  );
}
