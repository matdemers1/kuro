import { useEffect, useState } from 'react';
import { Button } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { enablePush, pushSupported } from '../../lib/push.js';

export interface Health {
  state: 'unlinked' | 'linked' | 'paused' | 'blocked';
  stale: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  blockedTwice: boolean;
  pushDevices: number;
}

export function useHealth(): Health | undefined {
  const [h, setH] = useState<Health>();
  useEffect(() => {
    void api<Health>('/api/health-panel').then(setH, () => undefined);
  }, []);
  return h;
}

/** The banner Up Next shows when sync needs the owner (KURO-REQ-007, KURO-REQ-009). */
export function SyncBanner({ health }: { health: Health | undefined }) {
  if (health === undefined || health.state === 'unlinked') return null;
  const [tone, text] =
    health.state === 'paused'
      ? (['border-shu', 'Crunchyroll session expired — re-link to resume sync'] as const)
      : health.state === 'blocked'
        ? (['border-shu', 'Crunchyroll is refusing sync right now — Kurō keeps retrying'] as const)
        : health.stale
          ? (['border-kin', `Last sync ${health.lastSuccessAt === null ? 'never finished' : new Date(health.lastSuccessAt).toLocaleString()} — tap to sync now`] as const)
          : ([null, null] as const);
  if (tone === null) return null;
  return (
    <a href="/you" role="alert" className={`flex items-center gap-2 rounded-[10px] border bg-raised px-3 py-2 text-[13px] ${tone}`}>
      {text}
    </a>
  );
}

/** Sync health (KURO-REQ-010) and alerts on this device (KURO-REQ-020). */
export function SyncHealth() {
  const health = useHealth();
  const [push, setPush] = useState<string>();
  if (health === undefined) return null;
  const row = (k: string, v: string, tone = 'text-ink') => (
    <div className="flex justify-between gap-3 text-[13px]">
      <span className="text-muted">{k}</span>
      <span className={`font-mono text-[12px] ${tone}`}>{v}</span>
    </div>
  );
  return (
    <section aria-labelledby="health" className="flex flex-col gap-2 rounded-[16px] border border-line bg-surface p-4">
      <h2 id="health" className="text-[18px] font-bold">Sync health</h2>
      {row('Crunchyroll', health.state, health.state === 'linked' ? 'text-ok' : 'text-shu')}
      {row('Last sync', health.lastSuccessAt === null ? '—' : new Date(health.lastSuccessAt).toLocaleString(), health.stale ? 'text-kin' : 'text-ink')}
      {row('Next sync', 'Tonight 03:00')}
      {row('Last error', health.lastError ?? '—', health.lastError === null ? 'text-faint' : 'text-shu')}
      {row('Alerts', health.pushDevices > 0 ? `on ${String(health.pushDevices)} device${health.pushDevices === 1 ? '' : 's'}` : 'off', health.pushDevices > 0 ? 'text-ok' : 'text-faint')}
      <div className="mt-2 flex flex-wrap gap-2">
        {pushSupported() && (
          <Button kind="ghost" onClick={() => { void enablePush().then((r) => { setPush(r === 'enabled' ? 'Alerts are on for this device.' : r === 'denied' ? 'Notifications are blocked for Kurō in this browser’s settings.' : 'Alerts aren’t available here. On iPhone, add Kurō to your Home Screen first.'); }); }}>
            Enable alerts here
          </Button>
        )}
        {health.pushDevices > 0 && <Button kind="ghost" onClick={() => { void api('/api/push/test', { method: 'POST' }).then(() => { setPush('Test alert sent.'); }); }}>Send a test alert</Button>}
      </div>
      {push !== undefined && <p role="status" className="text-[13px] text-muted">{push}</p>}
    </section>
  );
}
