import QRCode from 'qrcode';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { Button, Field, Screen } from '../../components/ui.js';
import { api, ApiError } from '../../lib/api.js';

type Step = 'owner' | 'totp' | 'link' | 'done';

/**
 * First run (KURO-REQ-055): the setup token creates the owner; then an authenticator; then an
 * optional D3 Auth link. Linking Crunchyroll comes later, from Sync & settings (KURO-T-1.1).
 */
export function Setup({ oidcAvailable, onDone }: { oidcAvailable: boolean; onDone: () => void }) {
  const [step, setStep] = useState<Step>('owner');
  return (
    <Screen kicker={`Setup · step ${String(['owner', 'totp', 'link', 'done'].indexOf(step) + 1)} of 3`} title={step === 'owner' ? 'Welcome to Kurō' : step === 'totp' ? 'Add an authenticator' : 'Link D3 Auth'}>
      {step === 'owner' && <OwnerStep onNext={() => { setStep('totp'); }} />}
      {step === 'totp' && <TotpStep onNext={() => { if (oidcAvailable) setStep('link'); else onDone(); }} />}
      {step === 'link' && <LinkStep onSkip={onDone} />}
    </Screen>
  );
}

function OwnerStep({ onNext }: { onNext: () => void }) {
  const [form, setForm] = useState({ setupToken: '', displayName: '', email: '', password: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [k]: e.target.value }); };

  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/setup', { body: form });
      onNext();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'That setup token isn’t right. It is SETUP_TOKEN in the server’s environment.' : err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} aria-label="Create the owner">
      <p className="text-[15px] text-muted">Kurō has one owner — you. Once this account exists, setup closes for good.</p>
      <Field label="Setup token" type="password" required value={form.setupToken} onChange={set('setupToken')} hint="SETUP_TOKEN from the server environment." />
      <Field label="Your name" required value={form.displayName} onChange={set('displayName')} autoComplete="name" />
      <Field label="Email" type="email" required value={form.email} onChange={set('email')} autoComplete="username" />
      <Field label="Password" type="password" required minLength={12} value={form.password} onChange={set('password')} autoComplete="new-password" hint="At least 12 characters." />
      {error !== undefined && <p role="alert" className="text-[13px] text-shu">{error}</p>}
      <Button type="submit" disabled={busy}>Create my account</Button>
    </form>
  );
}

function TotpStep({ onNext }: { onNext: () => void }) {
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string; qr: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    void (async () => {
      const { secret, uri } = await api<{ secret: string; uri: string }>('/auth/totp/enrol', { method: 'POST' });
      setEnrolment({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
    })().catch(() => { setError('Could not start enrolment.'); });
  }, []);

  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    try {
      await api('/auth/totp/confirm', { body: { code } });
      onNext();
    } catch {
      setError('That code didn’t match. Try the newest one.');
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} aria-label="Confirm authenticator">
      <p className="text-[15px] text-muted">Scan this with your authenticator app, then enter the code it shows.</p>
      {enrolment !== undefined && (
        <div className="flex flex-col items-center gap-3 rounded-[16px] border border-line bg-surface p-4">
          <img src={enrolment.qr} alt="Authenticator QR code" width={220} height={220} className="rounded-[10px] bg-white p-1" />
          <code data-testid="totp-secret" className="font-mono text-[12px] break-all text-muted">{enrolment.secret}</code>
        </div>
      )}
      <Field label="Code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => { setCode(e.target.value); }} error={error} />
      <Button type="submit">Confirm</Button>
    </form>
  );
}

function LinkStep({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px] text-muted">Optional: sign in with your D3 Auth account to link it, so either login works from now on.</p>
      <Button onClick={() => { window.location.assign('/auth/oidc/start?link=1'); }}>Link D3 Auth</Button>
      <Button kind="ghost" onClick={onSkip}>Skip for now</Button>
    </div>
  );
}
