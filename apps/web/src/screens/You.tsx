import { useEffect, useState } from 'react';
import { Button, Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { ImportProgress } from './ImportProgress.js';
import { CrunchyrollLink, type CrStatus } from './Settings/CrunchyrollLink.js';

/** You: sync health, the Crunchyroll link, and signing out. Stats arrive in Phase 5. */
export function You({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const [cr, setCr] = useState<CrStatus>();
  useEffect(() => {
    void api<CrStatus>('/api/crunchyroll').then(setCr, () => { setCr({ linked: false }); });
  }, []);
  return (
    <Screen kicker="Settings" title="You">
      {cr?.linked === true && <ImportProgress />}
      {cr !== undefined && <CrunchyrollLink status={cr} onLinked={setCr} />}
      <p className="text-[13px] text-faint">Signed in as {name}.</p>
      <Button kind="ghost" onClick={onSignOut}>Sign out</Button>
    </Screen>
  );
}
