import type { ReactNode } from 'react';
import { useOnline } from '../lib/online.js';
import { navigate } from '../lib/router.js';
import { CalendarIcon, LibraryIcon, PlayIcon, YouIcon } from './icons.js';

const TABS = [
  { label: 'Up Next', path: '/', icon: PlayIcon },
  { label: 'This Season', path: '/season', icon: CalendarIcon },
  { label: 'Library', path: '/library', icon: LibraryIcon },
  { label: 'You', path: '/you', icon: YouIcon },
] as const;

function activeTab(path: string): string {
  if (path.startsWith('/show/')) return '/library';
  if (path.startsWith('/you/')) return '/you';
  return TABS.find((t) => t.path === path)?.path ?? '/';
}

function go(e: React.MouseEvent, path: string) {
  e.preventDefault();
  navigate(path);
}

/** Four tabs at the bottom of a phone; the same four as a sidebar from 1024px (KURO-T-1.6). */
export function AppShell({ path, children }: { path: string; children: ReactNode }) {
  const active = activeTab(path);
  const online = useOnline();
  return (
    <div className="min-h-dvh bg-canvas text-ink lg:flex">
      <nav aria-label="Main" className="hidden w-60 shrink-0 flex-col gap-1 border-r border-line bg-surface px-4 py-6 lg:flex">
        <a href="/" onClick={(e) => { go(e, '/'); }} className="mb-6 flex items-baseline gap-2 px-3">
          <span className="font-display text-[28px] leading-[34px] font-bold">Kurō</span>
          <span className="font-bold text-shu">苦労</span>
        </a>
        {TABS.map(({ label, path: p, icon: Icon }) => (
          <a key={p} href={p} onClick={(e) => { go(e, p); }} aria-current={active === p ? 'page' : undefined} className={`flex items-center gap-3 rounded-[10px] px-3 py-2 text-[15px] font-bold ${active === p ? 'bg-raised text-ink [&_svg]:text-shu' : 'text-muted hover:bg-raised'}`}>
            <Icon />
            {label}
          </a>
        ))}
      </nav>
      <div className="flex-1 pb-20 lg:pb-0">
        {!online && (
          <p role="status" className="sticky top-0 z-10 bg-raised px-4 py-2 text-center text-[13px] text-muted">
            You’re offline. Showing what Kurō last saw; changes need a connection.
          </p>
        )}
        <fieldset disabled={!online} className="contents">{children}</fieldset>
      </div>
      <nav aria-label="Tabs" className="fixed inset-x-0 bottom-0 flex justify-around border-t border-line bg-surface px-2 pt-2 pb-[max(env(safe-area-inset-bottom),12px)] lg:hidden">
        {TABS.map(({ label, path: p, icon: Icon }) => (
          <a key={p} href={p} onClick={(e) => { go(e, p); }} aria-current={active === p ? 'page' : undefined} className={`flex min-w-16 flex-col items-center gap-0.5 text-[11px] font-medium tracking-[0.3px] ${active === p ? 'text-ink [&_svg]:text-shu' : 'text-faint'}`}>
            <Icon />
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
