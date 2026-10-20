import { useCallback, useEffect, useState } from 'react';
import { Button, Screen } from './components/ui.js';
import { api, getSession, type SessionInfo } from './lib/api.js';
import { Setup } from './screens/Setup/Setup.js';
import { SignIn } from './screens/SignIn.js';
import { CrunchyrollLink, type CrStatus } from './screens/Settings/CrunchyrollLink.js';

/** The browser path, or '/' when rendering outside a browser (unit tests). */
function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

export function App({ initial }: { initial?: SessionInfo }) {
  const [session, setSession] = useState<SessionInfo | undefined>(initial);
  const [setupDone, setSetupDone] = useState(false);
  const refresh = useCallback(() => {
    void getSession().then(setSession);
  }, []);
  useEffect(() => {
    if (initial === undefined) refresh();
  }, [initial, refresh]);

  if (session === undefined) return <main className="min-h-dvh bg-canvas" aria-busy="true" />;
  if (session.setupRequired === true || (session.authenticated && !setupDone && session.totpEnrolled === false && currentPath() === '/setup')) {
    return <Setup oidcAvailable={session.oidcAvailable} onDone={() => { setSetupDone(true); window.history.replaceState(null, '', '/'); refresh(); }} />;
  }
  if (!session.authenticated) {
    const signinError = typeof window === 'undefined' ? undefined : (new URLSearchParams(window.location.search).get('signin_error') ?? undefined);
    return <SignIn oidcAvailable={session.oidcAvailable} onSignedIn={refresh} initialError={signinError} />;
  }
  return <Home name={session.user?.displayName ?? ''} onSignOut={() => { void api('/auth/logout', { method: 'POST' }).then(refresh); }} />;
}

function Home({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const [cr, setCr] = useState<CrStatus>();
  useEffect(() => {
    void api<CrStatus>('/api/crunchyroll').then(setCr, () => { setCr({ linked: false }); });
  }, []);
  return (
    <Screen kicker="Tonight" title="Up Next">
      {cr !== undefined && !cr.linked && <CrunchyrollLink status={cr} onLinked={setCr} />}
      {cr?.linked === true && <p className="text-[15px] text-muted">Crunchyroll is linked. Your history imports next.</p>}
      <p className="text-[13px] text-faint">Signed in as {name}.</p>
      <Button kind="ghost" onClick={onSignOut}>Sign out</Button>
    </Screen>
  );
}
