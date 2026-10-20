import { newestRelease } from '../catalog/import.js';
import type { Db } from '../db.js';
import type { Alerts } from '../push/sender.js';

/**
 * The hourly health check (KURO-REQ-007, 008, 009). Each condition alerts once per occurrence:
 * the key names the event (this pause, this pair of blocked runs, this stale stretch), so a check
 * that runs every hour never repeats itself.
 */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
/** KURO-REQ-026: the newest catalog release is more than three weeks old. */
export const CATALOG_STALE_AFTER_MS = 21 * 24 * 60 * 60 * 1000;

export interface SyncHealth {
  readonly state: 'unlinked' | 'linked' | 'paused' | 'blocked';
  readonly stale: boolean;
  readonly lastSuccessAt: Date | null;
  readonly lastError: string | null;
  readonly blockedTwice: boolean;
}

export async function syncHealth(db: Db, userId: string, now = new Date()): Promise<SyncHealth> {
  const conn = await db.crConnection.findUnique({ where: { userId } });
  if (conn === null) return { state: 'unlinked', stale: false, lastSuccessAt: null, lastError: null, blockedTwice: false };
  const recent = await db.syncRun.findMany({ where: { crConnectionId: conn.id, status: { not: 'running' } }, orderBy: { startedAt: 'desc' }, take: 2 });
  const blockedTwice = recent.length === 2 && recent.every((r) => r.status === 'failed' && (r.error ?? '').startsWith('blocked'));
  const reference = conn.lastSuccessAt ?? conn.createdAt;
  return {
    state: conn.state,
    stale: now.getTime() - reference.getTime() > STALE_AFTER_MS,
    lastSuccessAt: conn.lastSuccessAt,
    lastError: recent.find((r) => r.status === 'failed')?.error ?? null,
    blockedTwice,
  };
}

export async function checkAlerts(db: Db, alerts: Alerts, now = new Date()): Promise<string[]> {
  const sent: string[] = [];
  for (const conn of await db.crConnection.findMany()) {
    const h = await syncHealth(db, conn.userId, now);
    const since = (conn.lastSuccessAt ?? conn.createdAt).toISOString();
    if (h.state === 'paused') {
      const key = `cr-expired:${conn.id}:${conn.updatedAt.toISOString()}`;
      if (await alerts.send({ key, title: 'Crunchyroll session expired', body: 'Re-link Crunchyroll to resume syncing your history.', url: '/you' })) sent.push(key);
    }
    if (h.blockedTwice) {
      const key = `cr-blocked:${conn.id}:${since}`;
      if (await alerts.send({ key, title: 'Crunchyroll is blocking sync', body: 'Two syncs in a row were refused. Kurō keeps retrying nightly.', url: '/you' })) sent.push(key);
    }
    if (h.stale) {
      const key = `stale:${conn.id}:${since}`;
      if (await alerts.send({ key, title: 'Sync is stale', body: 'Kurō has not synced in over 36 hours. Tap to sync now.', url: '/you' })) sent.push(key);
    }
  }
  const release = await newestRelease(db);
  if (release !== null && now.getTime() - release.publishedAt.getTime() > CATALOG_STALE_AFTER_MS) {
    const key = `catalog-stale:${release.repo}:${release.tag}`;
    if (await alerts.send({ key, title: 'The anime catalog is out of date', body: `The newest release (${release.tag}) is over three weeks old. Check the source, or switch KURO_CATALOG_REPO.`, url: '/you' })) sent.push(key);
  }
  return sent;
}
