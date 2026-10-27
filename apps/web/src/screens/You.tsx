import { useEffect, useState } from 'react';
import { Button, Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { ImportProgress } from './ImportProgress.js';
import { useReviewCount } from './Review/Review.js';
import { RewatchQueue } from './RewatchQueue.js';
import { CrunchyrollLink, type CrStatus } from './Settings/CrunchyrollLink.js';
import { SyncHealth } from './Settings/SyncHealth.js';

const EXPORTS = [
  { href: '/api/export/kuro.json', label: 'Everything (JSON)', note: 'every play and every choice; kuro import-json reads it back' },
  { href: '/api/export/mal.xml', label: 'MyAnimeList list (XML)', note: 'imports into MyAnimeList or AniList' },
  { href: '/api/export/shows.csv', label: 'Shows (CSV)', note: 'one row per Show' },
  { href: '/api/export/plays.csv', label: 'Plays (CSV)', note: 'one row per play' },
] as const;

/** Export (KURO-T-6.1): your history, yours to take. */
function ExportLinks() {
  return (
    <section aria-labelledby="export" className="flex flex-col gap-2">
      <h2 id="export" className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">Export</h2>
      <ul className="flex flex-col gap-1">
        {EXPORTS.map((x) => (
          <li key={x.href}>
            <a href={x.href} download className="flex flex-col rounded-[10px] border border-line px-3 py-2 hover:bg-raised">
              <span className="text-[15px]">{x.label}</span>
              <span className="text-[12px] text-faint">{x.note}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** You: sync health, the Crunchyroll link, stats, taste, the rewatch queue, and signing out. */
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
      {cr?.linked === true && <Button kind="ghost" onClick={() => { navigate('/you/stats'); }}>Stats and year in review</Button>}
      {cr?.linked === true && <Button kind="ghost" onClick={() => { navigate('/you/taste'); }}>Your taste</Button>}
      {cr?.linked === true && <Button kind="ghost" onClick={() => { navigate('/you/lists'); }}>Shared lists</Button>}
      <Button kind="ghost" onClick={() => { navigate('/you/changes'); }}>Change log</Button>
      {cr?.linked === true && <ExportLinks />}
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
