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
  sent.push(...(await checkShowAlerts(db, alerts)));

  const release = await newestRelease(db);
  if (release !== null && now.getTime() - release.publishedAt.getTime() > CATALOG_STALE_AFTER_MS) {
    const key = `catalog-stale:${release.repo}:${release.tag}`;
    if (await alerts.send({ key, title: 'The anime catalog is out of date', body: `The newest release (${release.tag}) is over three weeks old. Check the source, or switch KURO_CATALOG_REPO.`, url: '/you' })) sent.push(key);
  }
  return sent;
}

/** Languages a show is made in; an episode in any other is a dub. */
const ORIGINAL = new Set(['ja-JP', 'zh-CN', 'ko-KR']);

/**
 * Show alerts (KURO-T-3.4), each sent once — the key names the episode or the sequel:
 *   - a dub episode published since the owner last watched a Show they are Watching;
 *   - a sequel announced, or airing, for a Show the owner has finished.
 */
export async function checkShowAlerts(db: Db, alerts: Alerts): Promise<string[]> {
  const sent: string[] = [];
  // The first time a kind runs, what is already true is not news: remember it, push nothing. Every
  // dub episode and sequel after that is.
  const seeding = new Set<string>();
  for (const prefix of ['dub:', 'sequel:']) {
    if ((await db.alert.count({ where: { key: { startsWith: prefix } } })) > 0) continue;
    seeding.add(prefix);
    // A marker, so the next run is not "the first" even when nothing qualified this time.
    await alerts.remember({ key: `${prefix}seeded`, title: 'seeded', body: '' });
  }
  const deliver = async (prefix: string, input: { key: string; title: string; body: string; url: string }) => {
    if (seeding.has(prefix)) await alerts.remember(input);
    else if (await alerts.send(input)) sent.push(input.key);
  };
  for (const s of await db.showState.findMany({ where: { OR: [{ status: 'watching', nextIsNew: true }, { comingEntryId: { not: null } }] } })) {
    if (s.status === 'watching' && s.nextIsNew && s.nextCrEpisodeId !== null && s.nextAudioLocale !== null && !ORIGINAL.has(s.nextAudioLocale)) {
      const ep = s.nextEpisode === null ? '' : ` episode ${String(s.nextEpisode)}`;
      await deliver('dub:', { key: `dub:${s.showKey}:${s.nextCrEpisodeId}`, title: `New dub: ${s.title}`, body: `${s.title}${ep} is out in your dub.`, url: `/show/${encodeURIComponent(s.showKey)}` });
    }
    if (s.comingEntryId !== null && s.totalEpisodes > 0 && s.watchedEpisodes >= s.totalEpisodes) {
      const sequel = await db.catalogEntry.findUnique({ where: { id: s.comingEntryId }, select: { title: true, status: true } });
      const what = sequel?.status === 'ONGOING' ? 'is airing' : 'is announced';
      await deliver('sequel:', { key: `sequel:${s.showKey}:${s.comingEntryId}`, title: `More ${s.title}`, body: `${sequel?.title ?? 'A sequel'} ${what}.`, url: `/show/${encodeURIComponent(s.showKey)}` });
    }
  }
  return sent;
}
