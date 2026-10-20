import { useEffect, useState } from 'react';
import { Button, Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { ImportProgress } from './ImportProgress.js';
import { useReviewCount } from './Review/Review.js';
import { RewatchQueue } from './RewatchQueue.js';
import { CrunchyrollLink, type CrStatus } from './Settings/CrunchyrollLink.js';
import { SyncHealth } from './Settings/SyncHealth.js';

/** You: sync health, the Crunchyroll link, and signing out. Stats arrive in Phase 5. */
export function You({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const [cr, setCr] = useState<CrStatus>();
  const toReview = useReviewCount();
  useEffect(() => {
    void api<CrStatus>('/api/crunchyroll').then(setCr, () => { setCr({ linked: false }); });
  }, []);
  return (
    <Screen kicker="Settings" title="You">
      {cr?.linked === true && <SyncHealth />}
      {cr?.linked === true && <ImportProgress />}
      {cr !== undefined && <CrunchyrollLink status={cr} onLinked={setCr} />}
      {toReview !== undefined && toReview > 0 && <Button onClick={() => { navigate('/review'); }}>Match review · {toReview} to check</Button>}
      {cr?.linked === true && <RewatchQueue />}
      <Button kind="ghost" onClick={() => { navigate('/you/changes'); }}>Change log</Button>
      <p className="text-[13px] text-faint">Signed in as {name}.</p>
      <Button kind="ghost" onClick={onSignOut}>Sign out</Button>
      <p className="text-[12px] text-faint">
        Anime catalog from{' '}
        <a className="underline" href="https://github.com/cedya77/anime-offline-database" rel="noopener">anime-offline-database</a>, under the{' '}
        <a className="underline" href="https://opendatacommons.org/licenses/odbl/1-0/" rel="noopener">ODbL 1.0</a> and{' '}
        <a className="underline" href="https://opendatacommons.org/licenses/dbcl/1-0/" rel="noopener">DbCL 1.0</a>.
      </p>
    </Screen>
  );
}
