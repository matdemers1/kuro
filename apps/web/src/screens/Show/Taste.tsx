import { useState } from 'react';
import { Button } from '../../components/ui.js';
import { api } from '../../lib/api.js';

/**
 * The owner's own say on a Show (KURO-T-4.1, KURO-T-4.3): a 1–10 rating for the Show and each
 * Season, why it was dropped, and a note. Each change is in the change log and can be undone.
 */

export function RatingRow({ label, score, onRate }: { label: string; score: number | null; onRate: (score: number | null) => void }) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <span className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">{label}</span>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={score === n}
            aria-label={`${String(n)} out of 10`}
            // Tapping the current score again clears it.
            onClick={() => { onRate(score === n ? null : n); }}
            className={`h-9 w-9 rounded-full font-mono text-[13px] ${score !== null && n <= score ? 'bg-kin text-canvas' : 'border border-line-strong text-muted'}`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SeasonScore({ title, score, onRate }: { title: string; score: number | null; onRate: (score: number | null) => void }) {
  return (
    <select
      aria-label={`Rate ${title}`}
      value={score ?? ''}
      onChange={(e) => { onRate(e.target.value === '' ? null : Number(e.target.value)); }}
      className="rounded-[8px] border border-line-strong bg-raised px-1 py-0.5 font-mono text-[12px] text-muted"
    >
      <option value="">–</option>
      {Array.from({ length: 10 }, (_, i) => 10 - i).map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}

const REASONS = [
  ['pacing', 'The pacing'],
  ['not_for_me', 'Not for me'],
  ['got_busy', 'Got busy'],
] as const;
export const DROP_REASON: Record<string, string> = Object.fromEntries(REASONS);

/** Dropping asks why (KURO-REQ-043) — one tap more, and it is what recommendations learn from. */
export function DropChooser({ onDrop, onCancel }: { onDrop: (reason: (typeof REASONS)[number][0]) => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line-strong p-3" role="group" aria-label="Why are you dropping it?">
      <p className="text-[13px] text-muted">Why are you dropping it?</p>
      <div className="flex flex-wrap gap-2">
        {REASONS.map(([value, label]) => <Button key={value} kind="ghost" className="min-h-9 px-3" onClick={() => { onDrop(value); }}>{label}</Button>)}
        <Button kind="ghost" className="min-h-9 px-3" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function NoteBox({ showKey, initial }: { showKey: string; initial: string | null }) {
  const [text, setText] = useState(initial ?? '');
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const save = () => {
    if (text.trim() === (initial ?? '').trim() && saved === 'idle') return;
    setSaved('saving');
    void api(`/api/shows/${encodeURIComponent(showKey)}/note`, { method: 'PUT', body: { text } }).then(() => { setSaved('saved'); }, () => { setSaved('failed'); });
  };
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2 text-[11px] font-medium tracking-[0.6px] text-faint uppercase">
        Your note
        <span className="normal-case tracking-normal" role="status">{saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : saved === 'failed' ? 'Not saved — try again' : ''}</span>
      </span>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setSaved('idle'); }}
        onBlur={save}
        rows={3}
        maxLength={10_000}
        placeholder="Where you left off, who recommended it, what to remember…"
        className="rounded-[10px] border border-line-strong bg-raised px-3 py-2 text-[15px] text-ink placeholder:text-faint focus:border-kin focus:outline-none"
      />
    </label>
  );
}
