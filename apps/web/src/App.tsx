import { useCallback, useEffect, useState } from 'react';
import { AppShell } from './components/AppShell.js';
import { api, getSession, type SessionInfo } from './lib/api.js';
import { Setup } from './screens/Setup/Setup.js';
import { SignIn } from './screens/SignIn.js';
import { usePath } from './lib/router.js';
import { Library } from './screens/Library.js';
import { Show } from './screens/Show/Show.js';
import { Discover } from './screens/Discover.js';
import { TasteProfile } from './screens/TasteProfile.js';
import { ThisSeason } from './screens/ThisSeason.js';
import { UpNext } from './screens/UpNext.js';
import { You } from './screens/You.js';
import { ChangeLog } from './screens/ChangeLog.js';
import { Review } from './screens/Review/Review.js';
import { Franchise } from './screens/Franchise.js';

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
  return <Signed name={session.user?.displayName ?? ''} onSignOut={() => { void api('/auth/logout', { method: 'POST' }).then(() => { window.history.replaceState(null, '', '/'); refresh(); }); }} />;
}

function Signed({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const path = usePath();
  let screen;
  if (path.startsWith('/show/')) screen = <Show showKey={decodeURIComponent(path.slice('/show/'.length))} />;
  else if (path === '/season') screen = <ThisSeason />;
  else if (path === '/library') screen = <Library />;
  else if (path === '/you') screen = <You name={name} onSignOut={onSignOut} />;
  else if (path === '/you/changes') screen = <ChangeLog />;
  else if (path === '/you/taste') screen = <TasteProfile />;
  else if (path === '/discover') screen = <Discover />;
  else if (path === '/review') screen = <Review />;
  else if (path.startsWith('/franchise/')) screen = <Franchise franchiseKey={decodeURIComponent(path.slice('/franchise/'.length))} />;
  else screen = <UpNext />;
  return <AppShell path={path}>{screen}</AppShell>;
}
