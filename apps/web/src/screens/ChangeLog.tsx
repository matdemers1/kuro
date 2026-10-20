import { useEffect, useState } from 'react';
import { Button, Screen } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';

interface Change { id: string; entity: string; entityId: string; action: string; at: string; undone: boolean; isUndo: boolean; undoable: boolean }

/** What a change was, in words: by entity and action, then by action alone. */
const DESCRIBE: Record<string, string> = {
  pinned: 'Pinned a show',
  unpinned: 'Unpinned a show',
  linked: 'Linked Crunchyroll',
  relinked: 'Re-linked Crunchyroll',
  owner_created: 'Created the owner account',
  totp_enrolled: 'Added an authenticator',
  'rating:rated': 'Rated',
  'rating:cleared': 'Cleared a rating',
  'show_note:noted': 'Wrote a note',
  'show_note:removed': 'Removed a note',
  'show_status:plan_to_watch': 'Marked Plan to watch',
  'show_status:dropped': 'Dropped a show',
  'show_status:cleared': 'Put a show back to automatic',
  'skip_filler:skip': 'Skipped filler',
  'skip_filler:include': 'Included filler again',
  'rec_dismissal:not_interested': 'Not interested in a recommendation',
  'rec_dismissal:interested': 'Took back Not interested',
  'taste_term:boost': 'Asked for more of a tag',
  'taste_term:lower': 'Asked for less of a tag',
  'taste_term:mute': 'Ignored a tag',
  'taste_term:reset': 'Reset a tag',
  rewatch_queue: 'Changed the rewatch queue',
  override: 'Changed a grouping',
  mapping_season: 'Answered a match review',
};
const describe = (c: Change) => {
  const undo = c.action.startsWith('undo:');
  const action = undo ? c.action.slice('undo:'.length) : c.action;
  const what = DESCRIBE[`${c.entity}:${action}`] ?? DESCRIBE[action] ?? DESCRIBE[c.entity] ?? action.replace(/_/g, ' ');
  return undo ? `Undid: ${what.charAt(0).toLowerCase()}${what.slice(1)}` : what;
};

/** Every change, newest first, with Undo where it applies (KURO-REQ-022). */
export function ChangeLog() {
  const [items, setItems] = useState<Change[] | null>();
  const [error, setError] = useState<string>();
  const load = () => {
    void api<{ items: Change[] }>('/api/changes').then((r) => { setItems(r.items); }, () => { setItems(null); });
  };
  useEffect(load, []);
  return (
    <Screen kicker="You" title="Change log">
      {error !== undefined && <p role="alert" className="text-[13px] text-shu">{error}</p>}
      {items === undefined && <div aria-busy="true" className="h-32 animate-pulse rounded-[16px] bg-raised" />}
      {items === null && <p role="alert" className="text-[15px] text-muted">The change log could not load. Try again in a moment.</p>}
      {items?.length === 0 && <p className="text-[15px] text-muted">No changes yet.</p>}
      <ul className="flex flex-col gap-2">
        {(items ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface px-3 py-2">
            <div className="min-w-0">
              <p className={`text-[15px] ${c.undone ? 'text-faint line-through' : ''}`}>{describe(c)}</p>
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
