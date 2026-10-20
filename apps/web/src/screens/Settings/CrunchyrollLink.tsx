import { useState, type SyntheticEvent } from 'react';
import { Button, Field } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';

export interface CrStatus {
  linked: boolean;
  state?: 'linked' | 'paused' | 'blocked';
  stateReason?: string | null;
  lastSuccessAt?: string | null;
}

/**
 * Link Crunchyroll (KURO-REQ-001). Kurō signs in once to read the owner's watch history; the
 * password is used for that one exchange and discarded — only an encrypted session token is kept.
 */
export function CrunchyrollLink({ status, onLinked }: { status: CrStatus; onLinked: (s: CrStatus) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const next = await api<CrStatus>('/api/crunchyroll/link', { body: { email, password } });
      setPassword('');
      onLinked(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Linking failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="cr-link" className="flex flex-col gap-4 rounded-[16px] border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="cr-link" className="text-[18px] font-bold">
          {status.linked ? 'Re-link Crunchyroll' : 'Link Crunchyroll'}
        </h2>
        {status.linked && (
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-[0.6px] uppercase ${status.state === 'linked' ? 'border-ok text-ok' : 'border-shu text-shu'}`}>
            {status.state === 'linked' ? 'Connected' : status.state}
          </span>
        )}
      </div>
      <p className="text-[15px] text-muted">
        Kurō signs in once to read your watch history. Your password is used for this one exchange and then discarded — only an encrypted session token is kept.
      </p>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} aria-label="Link Crunchyroll">
        <Field label="Crunchyroll email" type="email" autoComplete="off" required value={email} onChange={(e) => { setEmail(e.target.value); }} />
        <Field label="Crunchyroll password" type="password" autoComplete="off" required value={password} onChange={(e) => { setPassword(e.target.value); }} />
        {error !== undefined && <p role="alert" className="text-[13px] text-shu">{error}</p>}
        <Button type="submit" disabled={busy}>{status.linked ? 'Re-link' : 'Link and import history'}</Button>
      </form>
    </section>
  );
}
