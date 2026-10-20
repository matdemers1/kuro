import { useEffect, useState } from 'react';
import { Button, Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

type Adjust = 'boost' | 'lower' | 'mute';

interface TermRow {
  term: string;
  label: string;
  kind: 'tag' | 'studio';
  learned: number;
  weight: number;
  adjust: Adjust | null;
}

interface TasteData {
  state: 'ready' | 'cold';
  tags: TermRow[];
  studios: TermRow[];
  disliked: TermRow[];
  edited: TermRow[];
}

const ADJUST_LABEL: Record<Adjust, string> = { boost: 'More', lower: 'Less', mute: 'Ignore' };

/**
 * The taste profile (KURO-REQ-048, KURO-T-4.5): the tags and studios Kurō has learned from the
 * owner's ratings and finished Shows, strongest first. More, Less and Ignore edit a term; Discover
 * and This Season's picks reorder from it. Every edit is in the change log.
 */
export function TasteProfile() {
  const [data, setData] = useState<TasteData | null>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void api<TasteData>('/api/taste').then(setData, () => { setData(null); });
  }, [version]);
  const set = (term: string, adjust: Adjust | null) => {
    void api(`/api/taste/terms/${encodeURIComponent(term)}`, { method: 'PUT', body: { adjust } }).then(() => { setVersion((v) => v + 1); });
  };
  const strongest = Math.max(0.01, ...[...(data?.tags ?? []), ...(data?.studios ?? [])].map((t) => t.learned));

  return (
    <Screen kicker="You" title="Your taste">
      {data === undefined && <div aria-busy="true" className="h-40 animate-pulse rounded-[16px] bg-raised" />}
      {data === null && <p className="text-[15px] text-muted">Your taste profile could not load. Try again in a moment.</p>}
      {data !== undefined && data !== null && data.tags.length === 0 && data.edited.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="font-display text-[40px] text-faint">味</p>
          <p className="text-[18px] font-bold">Needs history</p>
          <p className="text-[15px] text-muted">Rate or finish a few shows and the tags and studios you like appear here.</p>
          <Button kind="ghost" onClick={() => { navigate('/discover'); }}>Rate a few shows</Button>
        </div>
      )}
      {data !== undefined && data !== null && (data.tags.length > 0 || data.edited.length > 0) && (
        <>
          <p className="text-[13px] text-muted">Learned from what you rated well or finished. More, Less and Ignore reorder Discover and this season’s picks.</p>
          {data.edited.length > 0 && <Terms title="Your edits" rows={data.edited} strongest={strongest} onSet={set} />}
          {data.tags.length > 0 && <Terms title="Tags you like" rows={data.tags} strongest={strongest} onSet={set} />}
          {data.studios.length > 0 && <Terms title="Studios you like" rows={data.studios} strongest={strongest} onSet={set} />}
          {data.disliked.length > 0 && <Terms title="Not for you" rows={data.disliked} strongest={strongest} onSet={set} />}
        </>
      )}
    </Screen>
  );
}

function Terms({ title, rows, strongest, onSet }: { title: string; rows: readonly TermRow[]; strongest: number; onSet: (term: string, adjust: Adjust | null) => void }) {
  const id = `taste-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">{title}</h2>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.term} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className={`text-[15px] ${r.adjust === 'mute' ? 'text-faint line-through' : ''}`}>
                {r.label}
                {r.kind === 'studio' && <span className="ml-2 text-[11px] text-faint uppercase">studio</span>}
              </span>
              <span aria-hidden="true" className="h-1 rounded-full bg-raised">
                <span className={`block h-1 rounded-full ${r.learned < 0 ? 'bg-line-strong' : 'bg-kin'}`} style={{ width: `${String(Math.min(100, Math.round((Math.abs(r.learned) / strongest) * 100)))}%` }} />
              </span>
            </div>
            <div role="group" aria-label={`Adjust ${r.label}`} className="flex gap-1">
              {(['boost', 'lower', 'mute'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={r.adjust === a}
                  // Pressing the current choice again puts the term back to what history says.
                  onClick={() => { onSet(r.term, r.adjust === a ? null : a); }}
                  className={`min-h-9 rounded-full px-3 text-[12px] ${r.adjust === a ? 'bg-kin text-canvas' : 'border border-line-strong text-muted'}`}
                >
                  {ADJUST_LABEL[a]}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
