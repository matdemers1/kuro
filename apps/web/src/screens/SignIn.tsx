import { useState, type SyntheticEvent } from 'react';
import { Button, Field, Wordmark } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';

/** Both login paths, side by side (GL-001): the password path never depends on D3 Auth. */
export function SignIn({ oidcAvailable, onSignedIn, initialError }: { oidcAvailable: boolean; onSignedIn: () => void; initialError?: string | undefined }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const [busy, setBusy] = useState(false);

  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ status: string }>('/auth/login', { body: { email, password, ...(needCode ? { totpCode: code } : {}) } });
      if (res.status === 'totp_required') setNeedCode(true);
      else onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts — wait a moment and try again.' : 'That didn’t work. Check your details and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 bg-canvas px-4 py-10 text-ink">
      <div className="flex flex-col gap-1">
        <Wordmark />
        <p className="text-[15px] text-muted">Your anime, by show — not by season.</p>
      </div>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} aria-label="Sign in">
        {!needCode ? (
          <>
            <Field label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => { setEmail(e.target.value); }} />
            <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => { setPassword(e.target.value); }} />
          </>
        ) : (
          <Field
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => { setCode(e.target.value); }}
            hint="The six digits from your authenticator app."
          />
        )}
        {error !== undefined && (
          <p role="alert" className="text-[13px] text-shu">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {needCode ? 'Verify' : 'Sign in'}
        </Button>
      </form>
      {oidcAvailable && (
        <>
          <p className="text-center text-[13px] text-faint">or</p>
          <Button kind="ghost" onClick={() => { window.location.assign('/auth/oidc/start'); }}>
            Sign in with D3 Auth
          </Button>
        </>
      )}
    </main>
  );
}
